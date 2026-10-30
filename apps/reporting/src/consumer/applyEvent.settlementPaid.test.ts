/**
 * Regression test: a payout reaches the payout trends. The consumer never
 * read settlement.paid, so a trend row kept the status it had when the batch
 * closed ('closed') after the batch was paid.
 *
 * Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { drainPast } from "./testSupport.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("applyEvent.settlementPaid.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const config = { consumerBatchLimit: 500 };

test.after(async () => {
  await pool.end();
});

test("settlement.paid moves the payout trend to 'paid' with paid_at", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`payout trend ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const batch = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
     VALUES ($1, '2026-03-05', 'closed', 10_000, 250, 9_750, now()) RETURNING id`,
    [merchantId],
  );
  const batchId = batch.rows[0]!.id;
  const closed = await enqueueEvent(pool, {
    eventType: "settlement.batch_closed",
    aggregateType: "settlement_batch",
    aggregateId: batchId,
    payload: { merchantId, batchId, batchDate: "2026-03-05", grossFils: 10_000, feeFils: 250, netPayoutFils: 9_750 },
  });
  await drainPast(pool, config, [closed.id]);

  // The payout, then its event, as payout_notify.go enqueues it.
  const paidAt = new Date("2026-03-06T06:00:00Z");
  await pool.query(`UPDATE settlement_batches SET status = 'paid', paid_at = $2 WHERE id = $1`, [batchId, paidAt]);
  const paid = await enqueueEvent(pool, {
    eventType: "settlement.paid",
    aggregateType: "settlement_batch",
    aggregateId: batchId,
    payload: { merchantId, batchId, batchDate: "2026-03-05", netPayoutFils: 9_750 },
  });
  await drainPast(pool, config, [paid.id]);

  const trend = await pool.query<{ status: string; paid_at: Date | null }>(
    `SELECT status, paid_at FROM merchant_payout_trends WHERE settlement_batch_id = $1`,
    [batchId],
  );
  assert.equal(trend.rows[0]?.status, "paid");
  assert.equal(trend.rows[0]?.paid_at?.toISOString(), paidAt.toISOString());
});
