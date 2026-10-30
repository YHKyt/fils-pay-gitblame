/**
 * A suspended or closed merchant is cut off everywhere it authenticates:
 * login, live sessions and API keys all require merchants.status = 'active'.
 * The public checkout has no merchant credential, so it skipped that gate:
 * an open payment link of a suspended merchant still authorized and captured
 * the customer's card, and the money landed on a payable that settlement
 * will not pay out. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import type { AcquirerSimulator } from "../acquirer/types.js";
import { recordKycReview } from "../onboarding/review.js";
import { payPaymentLink } from "./pay.js";

const databaseUrl = process.env.DATABASE_URL;
const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const config = { paymentLinkReservationTimeoutSeconds: 60, cardFingerprintKey: Buffer.alloc(32) };

function countingAcquirer() {
  const calls = { authorize: 0, capture: 0 };
  const acquirer: AcquirerSimulator = {
    async authorize() {
      calls.authorize += 1;
      return { outcome: "approved", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 };
    },
    async capture(req) {
      calls.capture += 1;
      return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
    },
    async refund(req) {
      return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
    },
  };
  return { acquirer, calls };
}

for (const status of ["suspended", "closed"] as const) {
  test(`a ${status} merchant's payment link does not charge the customer`, { skip: !databaseUrl }, async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 5 });
    try {
      const m = await pool.query<{ id: string }>(
        `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
        [`paylink-${status} ${randomUUID()}`],
      );
      const merchantId = m.rows[0]!.id;
      await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
      const token = `paylink-${status}-${randomUUID()}`;
      await pool.query(
        `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
         VALUES ($1, $2, 4750, now() + interval '1 hour', 'merchant_api_key', gen_random_uuid())`,
        [merchantId, token],
      );
      await pool.query(`UPDATE merchants SET status = $2 WHERE id = $1`, [merchantId, status]);

      const fake = countingAcquirer();
      const result = await payPaymentLink(pool, fake.acquirer, config, { token, card: CARD, idempotencyKey: randomUUID() });

      assert.notEqual(result.statusCode, 200, JSON.stringify(result.body));
      assert.equal(fake.calls.authorize, 0, "the card was sent to the acquirer");
      assert.equal(fake.calls.capture, 0, "the card was captured");
      const txns = await pool.query(`SELECT 1 FROM transactions WHERE merchant_id = $1`, [merchantId]);
      assert.equal(txns.rows.length, 0);
      const link = await pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE token = $1`, [token]);
      assert.equal(link.rows[0]!.status, "active", "the refused attempt left the link reserved");
    } finally {
      await pool.end();
    }
  });
}
