/**
 * A pay attempt whose capture hits an acquirer error keeps its authorization
 * so the same Idempotency-Key can retry it. Once the link is paid by another
 * attempt that authorization can never be used: it must be voided, not left
 * holding the first customer's funds (and capturable by the merchant as a
 * second charge for one link). Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import type { AcquirerSimulator } from "../acquirer/types.js";
import { recordKycReview } from "../onboarding/review.js";
import { payPaymentLink } from "./pay.js";
import { cancelPaymentLink } from "./cancel.js";
import { captureTransaction } from "../payments/capture.js";

const databaseUrl = process.env.DATABASE_URL;
const CARD_A = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const CARD_B = { pan: "5555555555554444", expiryMonth: 12, expiryYear: 2030, cvv: "321" };
const config = { paymentLinkReservationTimeoutSeconds: 60, cardFingerprintKey: Buffer.alloc(32) };

test("an authorization kept for a retry is voided once another attempt pays the link", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    let captureCalls = 0;
    const acquirer: AcquirerSimulator = {
      async authorize() {
        return { outcome: "approved", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 };
      },
      async capture(req) {
        captureCalls += 1;
        // The first customer's capture meets an acquirer error (nothing captured).
        return { outcome: captureCalls === 1 ? "error" : "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
      },
      async refund(req) {
        return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
      },
    };

    const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
      `paylink-orphan ${randomUUID()}`,
    ]);
    const merchantId = m.rows[0]!.id;
    await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
    const token = `orphan-${randomUUID()}`;
    await pool.query(
      `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
       VALUES ($1, $2, 4750, now() + interval '1 hour', 'merchant_api_key', gen_random_uuid())`,
      [merchantId, token],
    );

    const first = await payPaymentLink(pool, acquirer, config, { token, card: CARD_A, idempotencyKey: "customer-a" });
    assert.equal(first.statusCode, 502, JSON.stringify(first.body));

    const second = await payPaymentLink(pool, acquirer, config, { token, card: CARD_B, idempotencyKey: "customer-b" });
    assert.equal(second.statusCode, 200, JSON.stringify(second.body));
    const paidTxn = (second.body as { transactionId: string }).transactionId;

    // Customer A retries with its own key: the link is paid by B.
    const retry = await payPaymentLink(pool, acquirer, config, { token, card: CARD_A, idempotencyKey: "customer-a" });
    assert.equal(retry.statusCode, 409, JSON.stringify(retry.body));

    const rows = await pool.query<{ id: string; status: string; active_holds: number }>(
      `SELECT t.id, t.status,
              (SELECT COUNT(*) FROM holds h WHERE h.transaction_id = t.id AND h.status = 'active')::int AS active_holds
         FROM transactions t WHERE t.merchant_id = $1`,
      [merchantId],
    );
    const others = rows.rows.filter((r) => r.id !== paidTxn);
    assert.equal(others.length, 1);
    assert.deepEqual(
      others.map((r) => [r.status, r.active_holds]),
      [["voided", 0]],
      "customer A's unused authorization is released, not left open and capturable",
    );
  } finally {
    await pool.end();
  }
});

test("an authorization kept for a retry is voided when the merchant cancels the link", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const acquirer: AcquirerSimulator = {
      async authorize() {
        return { outcome: "approved", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 };
      },
      async capture(req) {
        return { outcome: "error", acquirerReference: req.acquirerReference, latencyMs: 0 };
      },
      async refund(req) {
        return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
      },
    };
    const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
      `paylink-orphan-cancel ${randomUUID()}`,
    ]);
    const merchantId = m.rows[0]!.id;
    await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
    const token = `orphan-${randomUUID()}`;
    const l = await pool.query<{ id: string }>(
      `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
       VALUES ($1, $2, 4750, now() + interval '1 hour', 'merchant_api_key', gen_random_uuid()) RETURNING id`,
      [merchantId, token],
    );

    const first = await payPaymentLink(pool, acquirer, config, { token, card: CARD_A, idempotencyKey: "customer-a" });
    assert.equal(first.statusCode, 502, JSON.stringify(first.body));

    const canceled = await cancelPaymentLink(pool, { id: l.rows[0]!.id, merchantId, reservationTimeoutSeconds: 60 });
    assert.equal(canceled.outcome, "canceled");

    const rows = await pool.query<{ status: string; active_holds: number }>(
      `SELECT t.status,
              (SELECT COUNT(*) FROM holds h WHERE h.transaction_id = t.id AND h.status = 'active')::int AS active_holds
         FROM transactions t WHERE t.merchant_id = $1`,
      [merchantId],
    );
    assert.deepEqual(
      rows.rows.map((r) => [r.status, r.active_holds]),
      [["voided", 0]],
    );
  } finally {
    await pool.end();
  }
});

test("a link whose kept authorization the merchant captured cannot be paid a second time", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    let captureCalls = 0;
    const acquirer: AcquirerSimulator = {
      async authorize() {
        return { outcome: "approved", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 };
      },
      async capture(req) {
        captureCalls += 1;
        return { outcome: captureCalls === 1 ? "error" : "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
      },
      async refund(req) {
        return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
      },
    };
    const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
      `paylink-orphan-captured ${randomUUID()}`,
    ]);
    const merchantId = m.rows[0]!.id;
    await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
    const token = `orphan-${randomUUID()}`;
    await pool.query(
      `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
       VALUES ($1, $2, 4750, now() + interval '1 hour', 'merchant_api_key', gen_random_uuid())`,
      [merchantId, token],
    );

    const first = await payPaymentLink(pool, acquirer, config, { token, card: CARD_A, idempotencyKey: "customer-a" });
    assert.equal(first.statusCode, 502, JSON.stringify(first.body));

    // The merchant sees customer A's authorized transaction and captures it.
    const kept = await pool.query<{ id: string }>(`SELECT id FROM transactions WHERE merchant_id = $1`, [merchantId]);
    const manual = await captureTransaction(pool, acquirer, {
      transactionId: kept.rows[0]!.id,
      merchantId,
      idempotencyKey: randomUUID(),
      actor: { type: "merchant_api_key", id: randomUUID() },
    });
    assert.equal(manual.statusCode, 200, JSON.stringify(manual.body));

    // Customer B must not be charged for the same link.
    const second = await payPaymentLink(pool, acquirer, config, { token, card: CARD_B, idempotencyKey: "customer-b" });
    assert.equal(second.statusCode, 409, JSON.stringify(second.body));
    assert.equal((second.body as { error: string }).error, "payment_link_already_paid");
    const captured = await pool.query(`SELECT 1 FROM transactions WHERE merchant_id = $1 AND captured_fils > 0`, [merchantId]);
    assert.equal(captured.rowCount, 1, "one link, one captured charge");
  } finally {
    await pool.end();
  }
});
