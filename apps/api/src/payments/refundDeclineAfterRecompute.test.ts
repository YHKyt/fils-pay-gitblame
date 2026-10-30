/**
 * The admin status recompute derives the status from transactions.refunded_fils,
 * which also holds the reservation of a refund still at the acquirer (or
 * whose acquirer call timed out and has not been retried yet). Run in that
 * window, it marks the transaction 'refunded'. If the refund then declines,
 * processRefund released the reservation but left that status: a captured
 * transaction with nothing refunded read 'refunded', could not be refunded
 * (refundValidation refuses the status), and the recompute skips 'refunded'
 * rows, so nothing could repair it. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { toFils } from "@filspay/money";
import { recordKycReview } from "../onboarding/review.js";
import { withTransaction } from "../db/withTransaction.js";
import { recomputeTransactionStatusesForMerchant } from "../admin/transactionStatusRecompute.js";
import type { AcquirerOutcome, AcquirerRefundResult, AcquirerSimulator } from "../acquirer/types.js";
import { authorizeTransaction } from "./authorize.js";
import { captureTransaction } from "./capture.js";
import { processRefund } from "./processRefund.js";

const databaseUrl = process.env.DATABASE_URL;

for (const outcome of ["declined", "error"] as const) {
  test(`a refund that ends ${outcome} after a status recompute leaves the transaction refundable`, { skip: !databaseUrl }, async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 5 });
    try {
      const m = await pool.query<{ id: string }>(
        `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
        [`refund-${outcome}-recompute ${randomUUID()}`],
      );
      const merchantId = m.rows[0]!.id;
      await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });

      let releaseRefund: (o: AcquirerOutcome) => void = () => {};
      let refundArrived: () => void = () => {};
      const arrived = new Promise<void>((res) => (refundArrived = res));
      const acquirer: AcquirerSimulator = {
        async authorize() {
          return { outcome: "approved", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 };
        },
        async capture(req) {
          return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
        },
        refund(req): Promise<AcquirerRefundResult> {
          return new Promise((res) => {
            releaseRefund = (o) => res({ outcome: o, acquirerReference: req.acquirerReference, latencyMs: 0 });
            refundArrived();
          });
        },
      };
      const actor = { type: "merchant_api_key" as const, id: randomUUID() };

      const auth = await authorizeTransaction(pool, acquirer, {
        merchantId,
        amountFils: toFils(10_000),
        card: { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" },
        idempotencyKey: randomUUID(),
        cardFingerprintKey: Buffer.alloc(32),
      });
      const id = (auth.body as { id: string }).id;
      const cap = await captureTransaction(pool, acquirer, { transactionId: id, merchantId, idempotencyKey: randomUUID(), actor });
      assert.equal(cap.statusCode, 200);

      const refund = processRefund(pool, acquirer, { transactionId: id, merchantId, idempotencyKey: randomUUID(), actor });
      await arrived;

      // An operator runs "Recompute transaction statuses" meanwhile.
      await withTransaction(pool, (client) => recomputeTransactionStatusesForMerchant(client, merchantId));

      releaseRefund(outcome);
      const result = await refund;
      assert.notEqual(result.statusCode, 200);

      const row = await pool.query<{ status: string; refunded_fils: string }>(
        `SELECT status, refunded_fils FROM transactions WHERE id = $1`,
        [id],
      );
      assert.equal(Number(row.rows[0]!.refunded_fils), 0);
      assert.equal(row.rows[0]!.status, "captured", "nothing was refunded, yet the status says otherwise");

      // And the merchant can still refund it.
      releaseRefund = () => {};
      const retryAcquirer: AcquirerSimulator = {
        ...acquirer,
        async refund(req) {
          return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
        },
      };
      const again = await processRefund(pool, retryAcquirer, { transactionId: id, merchantId, idempotencyKey: randomUUID(), actor });
      assert.equal(again.statusCode, 200, JSON.stringify(again.body));
    } finally {
      await pool.end();
    }
  });
}
