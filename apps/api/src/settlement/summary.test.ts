/**
 * Settlement summary = gross captured IN THE WINDOW. A transaction captured
 * in several partial captures must be counted once, by the amounts its
 * capture events moved — not its running captured_fils total once per event.
 * Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { getSettlementSummary } from "./query.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("summary.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 3 });

after(async () => {
  await pool.end();
});

async function merchant(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Summary Test ${randomUUID()}`],
  );
  return r.rows[0]!.id;
}

async function txnWithCaptures(
  merchantId: string,
  amountFils: number,
  captures: Array<{ amountFils: number; at: string }>,
): Promise<void> {
  const captured = captures.reduce((s, c) => s + c.amountFils, 0);
  const t = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [merchantId, captured === amountFils ? "captured" : "partially_captured", amountFils, captured, `acq_${randomUUID()}`],
  );
  let running = 0;
  for (const c of captures) {
    running += c.amountFils;
    await pool.query(
      `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at)
       VALUES ($1, $2, $3, 'system', $4)`,
      [t.rows[0]!.id, running === amountFils ? "captured" : "partially_captured", c.amountFils, c.at],
    );
  }
}

test("two partial captures of one transaction in the window count once, at the captured amount", async () => {
  const merchantId = await merchant();
  await txnWithCaptures(merchantId, 10_000, [
    { amountFils: 4_000, at: "2026-07-01T09:00:00+03:00" },
    { amountFils: 6_000, at: "2026-07-01T15:00:00+03:00" },
  ]);
  await txnWithCaptures(merchantId, 3_333, [{ amountFils: 3_333, at: "2026-07-01T10:00:00+03:00" }]);

  const summary = await getSettlementSummary(pool, { merchantId, from: "2026-07-01", to: "2026-07-02" });

  assert.equal(summary.transactionCount, 2);
  assert.equal(summary.totalCapturedFils, 13_333); // was 23_333: 10_000 counted once per event
});

test("only the capture events inside the window count toward it", async () => {
  const merchantId = await merchant();
  await txnWithCaptures(merchantId, 5_000, [
    { amountFils: 3_000, at: "2026-07-01T12:00:00+03:00" },
    { amountFils: 2_000, at: "2026-07-02T12:00:00+03:00" },
  ]);

  const day1 = await getSettlementSummary(pool, { merchantId, from: "2026-07-01", to: "2026-07-02" });
  const day2 = await getSettlementSummary(pool, { merchantId, from: "2026-07-02", to: "2026-07-03" });

  assert.equal(day1.totalCapturedFils, 3_000);
  assert.equal(day2.totalCapturedFils, 2_000);
  assert.equal(day1.totalCapturedFils + day2.totalCapturedFils, 5_000, "daily totals add up to what was captured");
});
