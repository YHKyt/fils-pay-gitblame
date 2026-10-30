/**
 * Capture racing a refund that is still at the acquirer. The refund reserves
 * its amount in transactions.refunded_fils before the acquirer call; a
 * capture landing in that window must not derive the status from the
 * reservation, which a decline then releases. Requires `DATABASE_URL`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { toFils } from "@filspay/money";
import { recordKycReview } from "../onboarding/review.js";
import type { AcquirerOutcome, AcquirerRefundResult, AcquirerSimulator } from "../acquirer/types.js";
import { authorizeTransaction } from "./authorize.js";
import { captureTransaction } from "./capture.js";
import { processRefund } from "./processRefund.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("capturePendingRefund.test.ts requires DATABASE_URL (run `npm run migrate` first)");
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

test.after(async () => {
  await pool.end();
});

test("capturing the rest while a refund is in flight does not report a refund that then declines", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Capture Pending Refund ${randomUUID()}`],
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
  });
  const id = (auth.body as { id: string }).id;
  const first = await captureTransaction(pool, acquirer, {
    transactionId: id,
    merchantId,
    amountFils: toFils(4_000),
    idempotencyKey: randomUUID(),
    actor,
  });
  assert.equal(first.statusCode, 200);

  // Refund 4,000 of the 4,000 captured; it reserves and waits at the acquirer.
  const refund = processRefund(pool, acquirer, {
    transactionId: id,
    merchantId,
    amountFils: toFils(4_000),
    idempotencyKey: randomUUID(),
    actor,
  });
  await arrived;

  // The rest is captured while that refund is still undecided.
  const rest = await captureTransaction(pool, acquirer, {
    transactionId: id,
    merchantId,
    idempotencyKey: randomUUID(),
    actor,
  });
  assert.equal(rest.statusCode, 200);

  releaseRefund("declined");
  const refunded = await refund;
  assert.equal(refunded.statusCode, 402);

  const row = await pool.query<{ status: string; captured_fils: string; refunded_fils: string }>(
    `SELECT status, captured_fils, refunded_fils FROM transactions WHERE id = $1`,
    [id],
  );
  const refunds = await pool.query(`SELECT 1 FROM refunds WHERE transaction_id = $1`, [id]);
  assert.equal(refunds.rowCount, 0, "no refund succeeded");
  assert.equal(Number(row.rows[0]!.captured_fils), 10_000);
  assert.equal(Number(row.rows[0]!.refunded_fils), 0);
  assert.equal(row.rows[0]!.status, "captured", "nothing was refunded, so the fully captured transaction reads captured");
  assert.equal((rest.body as { status: string }).status, "captured", "the capture response does not report the pending refund");
});
