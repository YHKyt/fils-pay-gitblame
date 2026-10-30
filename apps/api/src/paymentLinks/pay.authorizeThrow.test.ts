/**
 * When the acquirer authorize call THROWS during a public link payment (a
 * timeout or socket error, not a decline), payPaymentLink rethrew without
 * releasing its reservation: the link stayed 'reserved' for the whole lease
 * (60 s), so the customer's immediate retry got 409 payment_link_processing.
 *
 * The throw happens before finalize, and only the finalize winner captures,
 * so handing the link back cannot cause a second charge. The acquirer may
 * still have authorized: a same-key retry resends the same acquirer key and
 * gets that authorization back instead of placing a second hold.
 * Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import type { AcquirerAuthorizeResult, AcquirerSimulator } from "../acquirer/types.js";
import { recordKycReview } from "../onboarding/review.js";
import { payPaymentLink } from "./pay.js";

const databaseUrl = process.env.DATABASE_URL;
const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const config = { paymentLinkReservationTimeoutSeconds: 60, cardFingerprintKey: Buffer.alloc(32) };

/** Idempotent per key, like a real acquirer; the next authorize acts, then its answer is lost to a timeout. */
function timingOutAcquirer() {
  const authorizations = new Map<string, AcquirerAuthorizeResult>();
  const captures = new Set<string>();
  const state = { authorizeTimeouts: 1 };
  const acquirer: AcquirerSimulator = {
    async authorize(req) {
      let result = authorizations.get(req.idempotencyKey);
      if (!result) {
        result = { outcome: "approved", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 };
        authorizations.set(req.idempotencyKey, result);
      }
      if (state.authorizeTimeouts > 0) {
        state.authorizeTimeouts -= 1;
        throw new Error("acquirer timeout");
      }
      return result;
    },
    async capture(req) {
      captures.add(req.idempotencyKey);
      return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
    },
    async refund(req) {
      return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
    },
  };
  return { acquirer, authorizations, captures };
}

test("an authorize call that throws hands the link back, and the same-key retry pays it once", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });
  try {
    const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
      `paylink-authorize-throw ${randomUUID()}`,
    ]);
    const merchantId = m.rows[0]!.id;
    await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
    const token = `authz-throw-${randomUUID()}`;
    const l = await pool.query<{ id: string }>(
      `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
       VALUES ($1, $2, 4750, now() + interval '1 hour', 'merchant_api_key', gen_random_uuid()) RETURNING id`,
      [merchantId, token],
    );
    const linkId = l.rows[0]!.id;
    const fake = timingOutAcquirer();
    const input = { token, card: CARD, idempotencyKey: randomUUID() };

    await assert.rejects(payPaymentLink(pool, fake.acquirer, config, input), /acquirer timeout/);

    const afterThrow = await pool.query<{ status: string; reserved_at: Date | null }>(
      `SELECT status, reserved_at FROM payment_links WHERE id = $1`,
      [linkId],
    );

    // The customer retries straight away, well inside the 60 s lease.
    const retry = await payPaymentLink(pool, fake.acquirer, config, input);
    assert.equal(retry.statusCode, 200, JSON.stringify(retry.body));
    assert.deepEqual(afterThrow.rows[0], { status: "active", reserved_at: null }, "the link stayed reserved after the throw");

    assert.equal(fake.authorizations.size, 1, "the retry placed a second authorization on the card");
    assert.equal(fake.captures.size, 1);
    const txns = await pool.query<{ status: string; captured_fils: string; acquirer_reference: string }>(
      `SELECT status, captured_fils, acquirer_reference FROM transactions WHERE merchant_id = $1`,
      [merchantId],
    );
    assert.equal(txns.rows.length, 1);
    assert.equal(txns.rows[0]!.status, "captured");
    assert.equal(Number(txns.rows[0]!.captured_fils), 4750);
    assert.equal(txns.rows[0]!.acquirer_reference, [...fake.authorizations.values()][0]!.acquirerReference);
    const link = await pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [linkId]);
    assert.equal(link.rows[0]!.status, "paid");
  } finally {
    await pool.end();
  }
});
