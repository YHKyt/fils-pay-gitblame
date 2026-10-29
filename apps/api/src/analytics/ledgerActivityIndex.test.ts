/**
 * recent-ledger-activity compares occurred_at against instant bounds so it can
 * range-scan idx_ledger_entries_merchant_occurred. It must return exactly the
 * rows the per-row Bahrain-date comparison selects, including at the edges.
 * Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { getRecentLedgerActivity } from "./query.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("ledgerActivityIndex.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 3 });

after(async () => {
  await pool.end();
});

const EDGES = [
  "2026-02-28T23:59:59.999999+03:00",
  "2026-03-01T00:00:00+03:00",
  "2026-03-01T02:59:59+03:00",
  "2026-03-01T03:00:00+03:00",
  "2026-03-15T12:00:00+03:00",
  "2026-03-31T20:59:59+00:00",
  "2026-03-31T23:59:59.999999+03:00",
  "2026-04-01T00:00:00+03:00",
  "2026-04-01T00:00:00.000001+03:00",
];

test("same rows as the per-row Bahrain-date predicate, and the window is an index condition", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Ledger Index Test ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  for (const at of EDGES) {
    const g = randomUUID();
    await pool.query(
      `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
       VALUES ($1, $2, 'card_scheme_clearing', 'debit', 1000, $3, $4), ($1, $2, 'merchant_payable', 'credit', 1000, $3, $4)`,
      [g, merchantId, at, at],
    );
  }
  const window = { merchantId, from: "2026-03-01", to: "2026-04-01" };

  const expected = await pool.query<{ id: string }>(
    `SELECT id FROM ledger_entries
      WHERE merchant_id = $1
        AND (occurred_at AT TIME ZONE 'Asia/Bahrain')::date >= $2::date
        AND (occurred_at AT TIME ZONE 'Asia/Bahrain')::date <  $3::date
      ORDER BY occurred_at DESC, id`,
    [merchantId, window.from, window.to],
  );

  const issued: string[] = [];
  const counting = {
    query: (text: string, params?: unknown[]) => {
      issued.push(text);
      return pool.query(text, params);
    },
  } as unknown as Pool;
  const activity = await getRecentLedgerActivity(counting, window);

  assert.equal(expected.rows.length, 12, "6 of the 9 edge instants fall in March (Bahrain), 2 legs each");
  assert.deepEqual(activity.points.map((p) => p.id).sort(), expected.rows.map((r) => String(r.id)).sort());
  assert.equal(issued.length, 1);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL enable_seqscan = off");
    const plan = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN ${issued[0]}`, [
      merchantId,
      window.from,
      window.to,
    ]);
    const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
    assert.match(text, /Index Cond: \(.*occurred_at >=/, text);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
