/**
 * When the capture of a link payment throws (an acquirer timeout), the link
 * deliberately stays 'paid' against its authorized transaction and reads
 * 'processing' "until the merchant captures or voids the authorization"
 * (pay.ts). Voiding it left the link 'paid' with a voided transaction: the
 * checkout and the merchant's list said paid although no money moved, the
 * customer could not pay, and the merchant could not cancel the link.
 * Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import type { AcquirerSimulator } from "../acquirer/types.js";
import { recordKycReview } from "../onboarding/review.js";
import { voidTransaction } from "../payments/void.js";
import { payPaymentLink } from "./pay.js";
import { getPublicPaymentLink } from "./read.js";

const databaseUrl = process.env.DATABASE_URL;
const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const config = { paymentLinkReservationTimeoutSeconds: 60, cardFingerprintKey: Buffer.alloc(32) };

test("voiding a link payment whose capture timed out reopens the link", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });
  try {
    const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
      `paylink-void-processing ${randomUUID()}`,
    ]);
    const merchantId = m.rows[0]!.id;
    await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
    const token = `void-processing-${randomUUID()}`;
    const l = await pool.query<{ id: string }>(
      `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
       VALUES ($1, $2, 4750, now() + interval '1 hour', 'merchant_api_key', gen_random_uuid()) RETURNING id`,
      [merchantId, token],
    );
    const linkId = l.rows[0]!.id;

    let captureThrows = true;
    const acquirer: AcquirerSimulator = {
      async authorize() {
        return { outcome: "approved", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 };
      },
      async capture(req) {
        if (captureThrows) throw new Error("acquirer timeout");
        return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
      },
      async refund(req) {
        return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
      },
    };

    await assert.rejects(payPaymentLink(pool, acquirer, config, { token, card: CARD, idempotencyKey: randomUUID() }));
    const bound = await pool.query<{ transaction_id: string }>(`SELECT transaction_id FROM payment_links WHERE id = $1`, [linkId]);
    const txnId = bound.rows[0]!.transaction_id;
    assert.equal((await getPublicPaymentLink(pool, token, 60))?.status, "processing");

    // The merchant resolves the stuck payment by voiding the authorization.
    const voided = await voidTransaction(pool, {
      transactionId: txnId,
      merchantId,
      actor: { type: "merchant_api_key", id: randomUUID() },
    });
    assert.equal(voided.statusCode, 200);

    const pub = await getPublicPaymentLink(pool, token, 60);
    assert.notEqual(pub?.status, "paid", "the checkout says paid, but nothing was charged");

    // The customer can pay it now.
    captureThrows = false;
    const again = await payPaymentLink(pool, acquirer, config, { token, card: CARD, idempotencyKey: randomUUID() });
    assert.equal(again.statusCode, 200, JSON.stringify(again.body));
    const captured = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM transactions WHERE merchant_id = $1 AND captured_fils > 0`,
      [merchantId],
    );
    assert.equal(captured.rows[0]!.n, "1");
  } finally {
    await pool.end();
  }
});
