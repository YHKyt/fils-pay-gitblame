/**
 * Regression test: refunds reach the daily volume rollup. The consumer never
 * read refund.succeeded (not in REPORTING_EVENT_TYPES, no applier), so a
 * refunded merchant's reports showed the capture and never the refund.
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
  throw new Error("applyEvent.refund.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const config = { consumerBatchLimit: 500 };

test.after(async () => {
  await pool.end();
});

test("refund.succeeded is consumed into merchant_daily_volume, bucketed by Asia/Bahrain date", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`refund rollup ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;

  const refund = await enqueueEvent(pool, {
    eventType: "refund.succeeded",
    aggregateType: "transaction",
    aggregateId: randomUUID(),
    payload: {
      merchantId,
      refundId: randomUUID(),
      amountFils: 1_250,
      feeReversedFils: 31,
      refundedTotalFils: 1_250,
      newStatus: "partially_refunded",
    },
  });
  // 22:30 UTC on 1 March is 01:30 on 2 March in Bahrain.
  await pool.query(`UPDATE outbox_events SET created_at = '2026-03-01T22:30:00Z' WHERE id = $1`, [refund.id.toString()]);

  await drainPast(pool, config, [refund.id]);

  const rows = await pool.query<{ volume_date: string; refund_count: number; refund_gross_fils: string }>(
    `SELECT volume_date::text, refund_count, refund_gross_fils::text
       FROM merchant_daily_volume WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.deepEqual(rows.rows, [{ volume_date: "2026-03-02", refund_count: 1, refund_gross_fils: "1250" }]);
});
