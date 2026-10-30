/**
 * Regression: incident 2026-05-14 — "two customers charged on one link".
 * payPaymentLink used to capture first and finalize the link afterwards. When
 * authorize+capture outlived the reservation timeout, a second pay request
 * re-claimed the link, charged its own card and finalized; the first request
 * then captured anyway and still answered 200. A gated acquirer holds the
 * first request inside the acquirer call while its reservation expires.
 * Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import type { AcquirerSimulator } from "../acquirer/types.js";
import { recordKycReview } from "../onboarding/review.js";
import { payPaymentLink } from "./pay.js";
import { getPublicPaymentLink } from "./read.js";

const databaseUrl = process.env.DATABASE_URL;
const CARD_A = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const CARD_B = { pan: "5555555555554444", expiryMonth: 12, expiryYear: 2030, cvv: "321" };
const config = { paymentLinkReservationTimeoutSeconds: 60 };

/** Always-approving acquirer whose next authorize or capture call can be held open. */
function gatedAcquirer() {
  let armed: "authorize" | "capture" | null = null;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => (signalEntered = resolve));
  const hold = async (stage: "authorize" | "capture") => {
    if (armed !== stage) return;
    armed = null;
    signalEntered();
    await gate;
  };
  const acquirer: AcquirerSimulator = {
    async authorize() {
      await hold("authorize");
      return { outcome: "approved", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 };
    },
    async capture(req) {
      await hold("capture");
      return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
    },
    async refund(req) {
      return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
    },
  };
  return { acquirer, arm: (stage: "authorize" | "capture") => (armed = stage), entered, release: () => release() };
}

async function linkFixture(pool: Pool) {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
    `paylink-race ${randomUUID()}`,
  ]);
  const merchantId = m.rows[0]!.id;
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const token = `race-${randomUUID()}`;
  const l = await pool.query<{ id: string }>(
    `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
     VALUES ($1, $2, 4750, now() + interval '1 hour', 'merchant_api_key', gen_random_uuid()) RETURNING id`,
    [merchantId, token],
  );
  return { merchantId, token, linkId: l.rows[0]!.id };
}

async function expireReservation(pool: Pool, linkId: string) {
  await pool.query(
    `UPDATE payment_links SET reserved_at = now() - interval '2 minutes' WHERE id = $1 AND status = 'reserved'`,
    [linkId],
  );
}

async function transactionStatuses(pool: Pool, merchantId: string): Promise<string[]> {
  const r = await pool.query<{ status: string }>(`SELECT status FROM transactions WHERE merchant_id = $1 ORDER BY status`, [
    merchantId,
  ]);
  return r.rows.map((row) => row.status);
}

test("a capture that outlives the reservation timeout cannot be followed by a second charge", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });
  try {
    const { merchantId, token, linkId } = await linkFixture(pool);
    const gate = gatedAcquirer();
    gate.arm("capture");

    const first = payPaymentLink(pool, gate.acquirer, config, { token, card: CARD_A, idempotencyKey: randomUUID() });
    await gate.entered; // first request is inside the acquirer capture call...
    await expireReservation(pool, linkId); // ...for longer than the reservation timeout
    const second = await payPaymentLink(pool, gate.acquirer, config, { token, card: CARD_B, idempotencyKey: randomUUID() });
    gate.release();
    const firstRes = await first;

    assert.deepEqual(await transactionStatuses(pool, merchantId), ["captured"], "one link, one charge");
    assert.equal(firstRes.statusCode, 200, JSON.stringify(firstRes.body));
    assert.equal(second.statusCode, 409, JSON.stringify(second.body));
  } finally {
    await pool.end();
  }
});

test("an authorize that outlives the reservation timeout voids itself instead of capturing", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });
  try {
    const { merchantId, token, linkId } = await linkFixture(pool);
    const gate = gatedAcquirer();
    gate.arm("authorize");

    const first = payPaymentLink(pool, gate.acquirer, config, { token, card: CARD_A, idempotencyKey: randomUUID() });
    await gate.entered; // first request is inside the acquirer authorize call...
    await expireReservation(pool, linkId); // ...when its reservation times out
    const second = await payPaymentLink(pool, gate.acquirer, config, { token, card: CARD_B, idempotencyKey: randomUUID() });
    gate.release();
    const firstRes = await first;

    assert.deepEqual(await transactionStatuses(pool, merchantId), ["captured", "voided"], "loser's authorization is voided");
    assert.equal(second.statusCode, 200, JSON.stringify(second.body));
    assert.equal(firstRes.statusCode, 409, JSON.stringify(firstRes.body));
    const link = await pool.query<{ status: string; transaction_id: string }>(
      `SELECT status, transaction_id FROM payment_links WHERE id = $1`,
      [linkId],
    );
    assert.equal(link.rows[0]!.status, "paid");
    assert.equal(link.rows[0]!.transaction_id, (second.body as { transactionId: string }).transactionId);
  } finally {
    await pool.end();
  }
});

test("while capture runs the link reads 'processing', not 'paid'", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });
  try {
    const { token } = await linkFixture(pool);
    const gate = gatedAcquirer();
    gate.arm("capture");

    const first = payPaymentLink(pool, gate.acquirer, config, { token, card: CARD_A, idempotencyKey: randomUUID() });
    await gate.entered; // finalized, capture in flight, no money moved yet
    const during = await getPublicPaymentLink(pool, token, config.paymentLinkReservationTimeoutSeconds);
    const second = await payPaymentLink(pool, gate.acquirer, config, { token, card: CARD_B, idempotencyKey: randomUUID() });
    gate.release();
    const firstRes = await first;
    const after = await getPublicPaymentLink(pool, token, config.paymentLinkReservationTimeoutSeconds);

    assert.equal(during?.status, "processing");
    assert.equal(second.statusCode, 409);
    assert.deepEqual(second.body, { error: "payment_link_processing" });
    assert.equal(firstRes.statusCode, 200, JSON.stringify(firstRes.body));
    assert.equal(after?.status, "paid");
  } finally {
    await pool.end();
  }
});

function acquirerWithCapture(capture: AcquirerSimulator["capture"]): AcquirerSimulator {
  return {
    async authorize() {
      return { outcome: "approved", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 };
    },
    capture,
    async refund(req) {
      return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
    },
  };
}

test("a declined capture frees the link and voids its authorization", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });
  try {
    const { merchantId, token, linkId } = await linkFixture(pool);
    const acquirer = acquirerWithCapture(async (req) => ({ outcome: "declined", acquirerReference: req.acquirerReference, latencyMs: 0 }));
    const res = await payPaymentLink(pool, acquirer, config, { token, card: CARD_A, idempotencyKey: randomUUID() });

    assert.equal(res.statusCode, 402, JSON.stringify(res.body));
    assert.deepEqual(await transactionStatuses(pool, merchantId), ["voided"], "no orphan authorization holding the card");
    const link = await pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [linkId]);
    assert.equal(link.rows[0]!.status, "active");
  } finally {
    await pool.end();
  }
});

// Previously asserted the link went back to 'reserved' with no transaction:
// that reopen is what let a second payer be captured too (next test).
test("a capture that throws keeps the link bound to its authorized transaction", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });
  try {
    const { merchantId, token, linkId } = await linkFixture(pool);
    const acquirer = acquirerWithCapture(async () => {
      throw new Error("acquirer connection reset");
    });
    await assert.rejects(payPaymentLink(pool, acquirer, config, { token, card: CARD_A, idempotencyKey: randomUUID() }));

    const link = await pool.query<{ status: string; transaction_id: string | null }>(
      `SELECT status, transaction_id FROM payment_links WHERE id = $1`,
      [linkId],
    );
    assert.equal(link.rows[0]!.status, "paid");
    assert.notEqual(link.rows[0]!.transaction_id, null);
    assert.deepEqual(await transactionStatuses(pool, merchantId), ["authorized"]);
    // Not captured, so not 'paid' to the outside: a crash here is visible.
    const pub = await getPublicPaymentLink(pool, token, config.paymentLinkReservationTimeoutSeconds);
    assert.equal(pub?.status, "processing");
  } finally {
    await pool.end();
  }
});

test("a capture that throws after the acquirer approved cannot be followed by a second capture", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });
  const trigger = `fp_capture_fail_${randomUUID().replace(/-/g, "")}`;
  try {
    const { merchantId, token, linkId } = await linkFixture(pool);
    // The acquirer approves; the DB then fails while journalling the capture.
    await pool.query(
      `CREATE OR REPLACE FUNCTION ${trigger}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'db failure after acquirer'; END $$ LANGUAGE plpgsql`,
    );
    await pool.query(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON ledger_entries FOR EACH ROW
         WHEN (NEW.merchant_id = '${merchantId}' AND NEW.description = 'capture: gross') EXECUTE FUNCTION ${trigger}()`,
    );
    let approvedCaptures = 0;
    const acquirer = acquirerWithCapture(async (req) => {
      approvedCaptures++;
      return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
    });
    await assert.rejects(payPaymentLink(pool, acquirer, config, { token, card: CARD_A, idempotencyKey: randomUUID() }));
    await pool.query(`DROP TRIGGER ${trigger} ON ledger_entries`);
    await pool.query(`UPDATE payment_links SET reserved_at = now() - interval '2 minutes' WHERE id = $1`, [linkId]);

    const second = await payPaymentLink(pool, acquirer, config, { token, card: CARD_B, idempotencyKey: randomUUID() });

    assert.equal(second.statusCode, 409, JSON.stringify(second.body));
    assert.equal(approvedCaptures, 1, "one link, one acquirer capture");
    assert.deepEqual(await transactionStatuses(pool, merchantId), ["authorized"]);
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON ledger_entries`).catch(() => {});
    await pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`).catch(() => {});
    await pool.end();
  }
});
