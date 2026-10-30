/**
 * A settlement batch must show the refunds it netted off the payout. The
 * Go close deducts claimed refunds (amount - fee reversed) from net, but the
 * batch DTOs only carried gross/fee/net, so a same-day full refund showed
 * "Gross 100.000, Fee 2.500, Net 0" with nothing explaining the gap.
 * Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { getSettlementBatch, listSettlementBatches } from "./query.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "batchRefundDeduction.test.ts requires DATABASE_URL to point at a real, migrated Postgres",
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 2 });

after(async () => {
  await pool.end();
});

async function createMerchant(): Promise<string> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Batch Refund Test ${randomUUID()}`],
  );
  return m.rows[0]!.id;
}

async function createBatch(
  merchantId: string,
  batchDate: string,
  gross: number,
  fee: number,
  net: number,
): Promise<string> {
  const b = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
     VALUES ($1, $2, 'closed', $3, $4, $5, now()) RETURNING id`,
    [merchantId, batchDate, gross, fee, net],
  );
  return b.rows[0]!.id;
}

async function createSettledRefund(
  merchantId: string,
  batchId: string,
  amountFils: number,
  feeReversedFils: number,
  occurredAt: string,
): Promise<void> {
  const t = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
     VALUES ($1, 'refunded', $2, $2, $3, $4) RETURNING id`,
    [merchantId, amountFils, `ref-${randomUUID()}`, occurredAt],
  );
  await pool.query(
    `INSERT INTO refunds (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status, acquirer_reference,
                          created_by_type, created_by_id, occurred_at, settlement_batch_id)
     VALUES ($1, $2, $3, $4, 'succeeded', $5, 'merchant_api_key', $6, $7, $8)`,
    [
      t.rows[0]!.id,
      merchantId,
      amountFils,
      feeReversedFils,
      `rf-${randomUUID()}`,
      randomUUID(),
      occurredAt,
      batchId,
    ],
  );
}

test("a batch with a same-day full refund reports refundDeductionFils and gross - fee - refunds = net", async () => {
  const merchantId = await createMerchant();
  // 100.000 BHD captured, 2.500 fee, then refunded in full with the fee reversed.
  const batchId = await createBatch(merchantId, "2026-09-01", 100000, 2500, 0);
  await createSettledRefund(
    merchantId,
    batchId,
    100000,
    2500,
    "2026-09-01T10:00:00Z",
  );

  const detail = await getSettlementBatch(pool, { merchantId, batchId });
  assert.ok(detail);
  assert.equal(detail.refundDeductionFils, 97500);
  assert.equal(detail.carriedInFils, 0);
  assert.equal(
    detail.grossFils - detail.feeFils - detail.refundDeductionFils,
    detail.netPayoutFils,
  );

  const list = await listSettlementBatches(pool, { merchantId });
  const listed = list.batches.find((b) => b.id === batchId);
  assert.ok(listed);
  assert.equal(listed.refundDeductionFils, 97500);
  assert.equal(
    listed.grossFils - listed.feeFils - listed.refundDeductionFils,
    listed.netPayoutFils,
  );
});

test("a batch with no refunds reports zero deductions", async () => {
  const merchantId = await createMerchant();
  const batchId = await createBatch(merchantId, "2026-09-02", 10000, 250, 9750);
  const detail = await getSettlementBatch(pool, { merchantId, batchId });
  assert.ok(detail);
  assert.equal(detail.refundDeductionFils, 0);
  assert.equal(detail.carriedInFils, 0);
});

test("carriedInFils is the negative shortfall an earlier batch carried forward", async () => {
  const merchantId = await createMerchant();
  const earlier = await createBatch(merchantId, "2026-09-03", 0, 0, -500);
  const later = await createBatch(merchantId, "2026-09-04", 10000, 250, 9250);
  await pool.query(
    `UPDATE settlement_batches SET carried_forward_to_batch_id = $1 WHERE id = $2`,
    [later, earlier],
  );

  const detail = await getSettlementBatch(pool, { merchantId, batchId: later });
  assert.ok(detail);
  assert.equal(detail.carriedInFils, -500);
  assert.equal(
    detail.grossFils -
      detail.feeFils -
      detail.refundDeductionFils +
      detail.carriedInFils,
    detail.netPayoutFils,
  );
});
