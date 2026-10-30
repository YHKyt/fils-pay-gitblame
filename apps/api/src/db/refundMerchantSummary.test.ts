/**
 * refund_merchant_summary must show refunds made after the migration ran
 * (0104). It was a materialized view that nothing ever refreshed, so it was
 * frozen at deploy time. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("refundMerchantSummary.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 2 });

after(async () => {
  await pool.end();
});

test("a refund recorded today appears in refund_merchant_summary on its Bahrain business date", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Refund Summary Test ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const t = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
     VALUES ($1, 'partially_refunded', 10000, 10000, $2, '2026-10-29T20:00:00Z') RETURNING id`,
    [merchantId, `acq-${randomUUID()}`],
  );
  const transactionId = t.rows[0]!.id;
  // 22:30 UTC on 29 Oct is 01:30 on 30 Oct in Bahrain.
  await pool.query(
    `INSERT INTO refunds (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status, acquirer_reference,
                          reason, created_by_type, created_by_id, occurred_at)
     VALUES ($1, $2, 4000, 100, 'succeeded', $3, 'customer_request', 'merchant_api_key', $4, '2026-10-29T22:30:00Z'),
            ($1, $2, 1000,  25, 'succeeded', $3, 'customer_request', 'merchant_api_key', $4, '2026-10-30T10:00:00Z'),
            ($1, $2, 9999,   0, 'failed',    $3, 'customer_request', 'merchant_api_key', $4, '2026-10-30T11:00:00Z')`,
    [transactionId, merchantId, `acq-r-${randomUUID()}`, randomUUID()],
  );

  const r = await pool.query<{
    business_date: string;
    refund_count: string;
    total_refunded_fils: string;
    total_fee_reversed_fils: string;
    original_captured_fils: string;
  }>(
    `SELECT business_date::date::text AS business_date, refund_count::text, total_refunded_fils::text,
            total_fee_reversed_fils::text, original_captured_fils::text
       FROM refund_merchant_summary WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.deepEqual(r.rows, [
    {
      business_date: "2026-10-30",
      refund_count: "2",
      total_refunded_fils: "5000",
      total_fee_reversed_fils: "125",
      original_captured_fils: "10000",
    },
  ]);
});
