/**
 * The settlement summary must be answerable from 0081's capture-event index
 * (not a seq scan of transaction_events), in one query, with the same result
 * as summing the window's capture events directly.
 * Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { getSettlementSummary } from "./query.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("summaryPlan.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 3 });

after(async () => {
  await pool.end();
});

async function seedMerchant(): Promise<string> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Summary Plan Test ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  // Window edges (Bahrain midnight = 21:00Z the day before), a void, and an
  // authorization: only the capture events inside [from, to) may count.
  const events: Array<[string, number | null, string]> = [
    ["authorized", null, "2026-07-01T08:00:00+03:00"],
    ["partially_captured", 1_000, "2026-07-01T00:00:00+03:00"],
    ["captured", 2_000, "2026-07-01T23:59:59.999+03:00"],
    ["captured", 4_000, "2026-07-02T00:00:00+03:00"],
    ["partially_captured", 8_000, "2026-06-30T23:59:59.999+03:00"],
    ["voided", null, "2026-07-01T12:00:00+03:00"],
  ];
  for (const [eventType, amountFils, at] of events) {
    const t = await pool.query<{ id: string }>(
      `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
       VALUES ($1, 'captured', 20000, 0, $2) RETURNING id`,
      [merchantId, `acq_${randomUUID()}`],
    );
    await pool.query(
      `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at)
       VALUES ($1, $2, $3, 'system', $4)`,
      [t.rows[0]!.id, eventType, amountFils, at],
    );
  }
  return merchantId;
}

test("summary equals the window's capture events, issued as a single query", async () => {
  const merchantId = await seedMerchant();
  const input = { merchantId, from: "2026-07-01", to: "2026-07-02" };

  const reference = await pool.query<{ n: string; total: string }>(
    `SELECT COUNT(DISTINCT t.id) AS n, COALESCE(SUM(te.amount_fils), 0) AS total
       FROM transactions t JOIN transaction_events te ON te.transaction_id = t.id
      WHERE t.merchant_id = $1 AND te.event_type IN ('captured', 'partially_captured')
        AND te.occurred_at >= '2026-07-01T00:00:00+03:00' AND te.occurred_at < '2026-07-02T00:00:00+03:00'`,
    [merchantId],
  );

  const issued: string[] = [];
  const counting = {
    query: (text: string, params?: unknown[]) => {
      issued.push(text);
      return pool.query(text, params);
    },
  } as unknown as Pool;
  const summary = await getSettlementSummary(counting, input);

  assert.deepEqual(summary, {
    periodFrom: "2026-07-01",
    periodTo: "2026-07-02",
    transactionCount: Number(reference.rows[0]!.n),
    totalCapturedFils: Number(reference.rows[0]!.total),
  });
  assert.equal(summary.transactionCount, 2);
  assert.equal(summary.totalCapturedFils, 3_000);
  assert.equal(issued.length, 1, "one query regardless of how many events are in the window");

  // The plan must be able to reach the window's events through the index.
  // A merchant with a handful of transactions (like this one) is rightly
  // served by a nested loop over 0018's per-transaction index; leaving only a
  // hash join without seq scans forces a plan that finds the window's events
  // by occurred_at, which only 0081's index can serve.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL enable_seqscan = off");
    await client.query("SET LOCAL enable_bitmapscan = off");
    await client.query("SET LOCAL enable_nestloop = off");
    await client.query("SET LOCAL enable_mergejoin = off");
    const plan = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN ${issued[0]}`, [
      merchantId,
      new Date("2026-07-01T00:00:00+03:00"),
      new Date("2026-07-02T00:00:00+03:00"),
    ]);
    const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
    assert.match(text, /idx_transaction_events_capture_occurred/, text);
    assert.doesNotMatch(text, /Seq Scan on transaction_events/, text);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
