/**
 * Reconciliation after settlement has run. The fixtures write rows exactly as
 * apps/api (capture, processRefund) and apps/settlement (CloseBatch,
 * PayoutBatch, carried shortfall) write them, so the report is checked
 * against what the two services really leave in the database:
 *
 *  - payout legs are not earnings: they pay out what the batches count;
 *  - a refund deducted by a batch is no longer pending (CloseBatch sets
 *    refunds.settlement_batch_id and never stamps the refund's event);
 *  - a shortfall carried into a later batch is counted once.
 *
 * Real Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { getReconciliationReport } from "./query.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("reconciliationSettled.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

test.after(async () => {
  await pool.end();
});

const MDR_BPS = 250;

async function merchant(): Promise<string> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Recon Settled Test ${randomUUID()}`, MDR_BPS],
  );
  return m.rows[0]!.id;
}

/** Bahrain business day `date` at hour `h` (UTC+3). */
function at(date: string, h: number): Date {
  return new Date(`${date}T${String(h).padStart(2, "0")}:00:00+03:00`);
}

/** captureTransaction: gross and MDR fee leg pairs plus the 'captured' event. */
async function capture(merchantId: string, amountFils: number, when: Date): Promise<{ txnId: string; feeFils: number }> {
  const feeFils = Math.round((amountFils * MDR_BPS) / 10_000); // exact for the amounts used here
  const ref = `acq_${randomUUID()}`;
  const t = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
     VALUES ($1, 'captured', $2, $2, $3, $4) RETURNING id`,
    [merchantId, amountFils, ref, when],
  );
  const txnId = t.rows[0]!.id;
  const g = randomUUID();
  await pool.query(
    `INSERT INTO ledger_entries
       (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES
       ($1, $2, $3, 'card_scheme_clearing', 'debit',  $4, $6, 'capture: gross'),
       ($1, $2, $3, 'merchant_payable',     'credit', $4, $6, 'capture: gross'),
       ($1, $2, $3, 'merchant_payable',     'debit',  $5, $6, 'capture: MDR fee'),
       ($1, $2, $3, 'platform_fee_revenue', 'credit', $5, $6, 'capture: MDR fee')`,
    [g, merchantId, txnId, amountFils, feeFils, when],
  );
  await pool.query(
    `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, actor_id, metadata, occurred_at)
     VALUES ($1, 'captured', $2, 'merchant_api_key', $3, $4, $5)`,
    [txnId, amountFils, randomUUID(), JSON.stringify({ feeFils, discountBps: 0, acquirerReference: ref }), when],
  );
  return { txnId, feeFils };
}

/** processRefund: refunds row, gross and fee-reversal leg pairs, negative event. */
async function refund(
  merchantId: string,
  txnId: string,
  amountFils: number,
  feeReversedFils: number,
  full: boolean,
  when: Date,
): Promise<string> {
  await pool.query(`UPDATE transactions SET refunded_fils = refunded_fils + $2, status = $3 WHERE id = $1`, [
    txnId,
    amountFils,
    full ? "refunded" : "partially_refunded",
  ]);
  const r = await pool.query<{ id: string }>(
    `INSERT INTO refunds
       (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status,
        acquirer_reference, reason, created_by_type, created_by_id, occurred_at)
     VALUES ($1, $2, $3, $4, 'succeeded', $5, 'unspecified', 'merchant_api_key', $6, $7) RETURNING id`,
    [txnId, merchantId, amountFils, feeReversedFils, `acq_${randomUUID()}`, randomUUID(), when],
  );
  const refundId = r.rows[0]!.id;
  const g = randomUUID();
  await pool.query(
    `INSERT INTO ledger_entries
       (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES
       ($1, $2, $3, 'merchant_payable',     'debit',  $4, $6, 'refund: gross'),
       ($1, $2, $3, 'card_scheme_clearing', 'credit', $4, $6, 'refund: gross'),
       ($1, $2, $3, 'platform_fee_revenue', 'debit',  $5, $6, 'refund: MDR fee reversal'),
       ($1, $2, $3, 'merchant_payable',     'credit', $5, $6, 'refund: MDR fee reversal')`,
    [g, merchantId, txnId, amountFils, feeReversedFils, when],
  );
  await pool.query(
    `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, actor_id, metadata, occurred_at)
     VALUES ($1, $2, $3, 'merchant_api_key', $4, $5, $6)`,
    [txnId, full ? "refunded" : "refund_partial", -amountFils, randomUUID(), JSON.stringify({ refundId, feeReversedFils }), when],
  );
  return refundId;
}

/**
 * CloseBatch + PayoutBatch for one business day: stamps the day's capture
 * events, claims every unbatched refund (not the refund events), adds any
 * carried shortfall, freezes the batch, then posts the payout leg pair (dated
 * now(), as PayoutBatch does) when the net is positive.
 */
async function settleAndPay(merchantId: string, date: string, gross: number, fee: number): Promise<number> {
  const b = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status) VALUES ($1, $2, 'open') RETURNING id`,
    [merchantId, date],
  );
  const batchId = b.rows[0]!.id;
  await pool.query(
    `UPDATE transaction_events te SET settlement_batch_id = $2
       FROM transactions t
      WHERE t.id = te.transaction_id AND t.merchant_id = $1
        AND te.event_type = 'captured' AND te.settlement_batch_id IS NULL
        AND te.occurred_at >= $3 AND te.occurred_at < $4`,
    [merchantId, batchId, at(date, 0), new Date(at(date, 0).getTime() + 86_400_000)],
  );
  const claimed = await pool.query<{ net: string }>(
    `WITH c AS (UPDATE refunds SET settlement_batch_id = $2
                 WHERE merchant_id = $1 AND status = 'succeeded' AND settlement_batch_id IS NULL AND occurred_at < $3
                 RETURNING amount_fils - fee_reversed_fils AS d)
     SELECT COALESCE(SUM(d), 0) AS net FROM c`,
    [merchantId, batchId, new Date(at(date, 0).getTime() + 86_400_000)],
  );
  const carried = await pool.query<{ net: string }>(
    `WITH c AS (UPDATE settlement_batches SET carried_forward_to_batch_id = $2
                 WHERE merchant_id = $1 AND id <> $2 AND status = 'paid' AND net_payout_fils < 0
                   AND carried_forward_to_batch_id IS NULL
                 RETURNING net_payout_fils)
     SELECT COALESCE(SUM(net_payout_fils), 0) AS net FROM c`,
    [merchantId, batchId],
  );
  const net = gross - fee - Number(claimed.rows[0]!.net) + Number(carried.rows[0]!.net);
  await pool.query(
    `UPDATE settlement_batches SET status = 'paid', gross_fils = $2, fee_fils = $3, net_payout_fils = $4,
            closed_at = now(), paid_at = now() WHERE id = $1`,
    [batchId, gross, fee, net],
  );
  if (net > 0) {
    await pool.query(
      `INSERT INTO ledger_entries
         (entry_group_id, merchant_id, settlement_batch_id, account_id, direction, amount_fils, occurred_at, description)
       VALUES
         ($1, $2, $3, 'merchant_payable', 'debit',  $4, now(), 'settlement payout: batch paid'),
         ($1, $2, $3, 'platform_cash',    'credit', $4, now(), 'settlement payout: batch paid')`,
      [randomUUID(), merchantId, batchId, net],
    );
  }
  return net;
}

function tomorrowBahrain(): string {
  return new Date(Date.now() + 3 * 3_600_000 + 86_400_000).toISOString().slice(0, 10);
}

test("a paid batch is explained when the window also holds its payout legs", async () => {
  const m = await merchant();
  await capture(m, 100_000, at("2026-07-01", 10)); // fee 2,500
  const net = await settleAndPay(m, "2026-07-01", 100_000, 2_500);
  assert.equal(net, 97_500);

  // The window runs to tomorrow, so it includes the payout legs posted now().
  const r = await getReconciliationReport(pool, { merchantId: m, from: "2026-07-01", to: tomorrowBahrain() });
  assert.equal(r.ledgerMerchantPayableNetFils, 97_500, JSON.stringify(r));
  assert.equal(r.settlementNetPayoutFils, 97_500, JSON.stringify(r));
  assert.equal(r.gapFils, 0, JSON.stringify(r));
  assert.equal(r.explained, true);
});

test("a refund the batch deducted is not pending any more", async () => {
  const m = await merchant();
  const { txnId } = await capture(m, 100_000, at("2026-07-02", 10)); // fee 2,500
  await refund(m, txnId, 10_000, 250, false, at("2026-07-02", 11)); // net -9,750
  const net = await settleAndPay(m, "2026-07-02", 100_000, 2_500);
  assert.equal(net, 87_750);

  const r = await getReconciliationReport(pool, { merchantId: m, from: "2026-07-02", to: "2026-07-03" });
  assert.equal(r.pendingUnbatchedFils, 0, JSON.stringify(r));
  assert.equal(r.ledgerMerchantPayableNetFils, 87_750, JSON.stringify(r));
  assert.equal(r.settlementNetPayoutFils, 87_750, JSON.stringify(r));
  assert.equal(r.gapFils, 0, JSON.stringify(r));
  assert.equal(r.explained, true);
});

test("a shortfall carried into the next batch is counted once", async () => {
  const m = await merchant();
  const { txnId } = await capture(m, 100_000, at("2026-07-03", 10));
  assert.equal(await settleAndPay(m, "2026-07-03", 100_000, 2_500), 97_500);
  await refund(m, txnId, 100_000, 2_500, true, at("2026-07-04", 10));
  assert.equal(await settleAndPay(m, "2026-07-04", 0, 0), -97_500);
  await capture(m, 200_000, at("2026-07-05", 10)); // fee 5,000
  assert.equal(await settleAndPay(m, "2026-07-05", 200_000, 5_000), 97_500); // 195,000 - 97,500 carried

  // Earnings in the window: 97,500 - 97,500 + 195,000 = 195,000.
  const r = await getReconciliationReport(pool, { merchantId: m, from: "2026-07-03", to: "2026-07-06" });
  assert.equal(r.ledgerMerchantPayableNetFils, 195_000, JSON.stringify(r));
  assert.equal(r.settlementNetPayoutFils, 195_000, JSON.stringify(r));
  assert.equal(r.pendingUnbatchedFils, 0, JSON.stringify(r));
  assert.equal(r.gapFils, 0, JSON.stringify(r));
  assert.equal(r.explained, true);
});
