/**
 * Negotiated discount at capture, against a real, migrated Postgres (no DB
 * mocking). The discount reduces the amount the MDR is charged on
 * (docs/ARCHITECTURE.md, apps/settlement ComputeSettlementFee) and is booked
 * inside captureTransaction, so every capture path — the merchant capture
 * route and the payment-link checkout — gets it exactly once per capture.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import type { AcquirerSimulator } from "../acquirer/types.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { payPaymentLink } from "../paymentLinks/pay.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "discountAdjustment.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

const approvingAcquirer: AcquirerSimulator = {
  async authorize() {
    return { outcome: "approved", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 };
  },
  async capture(req) {
    return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
  },
  async refund(req) {
    return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
  },
};

async function merchant(mdrBps: number, discountBps: number) {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, negotiated_discount_bps) VALUES ($1, $2, $3) RETURNING id`,
    [`Discount Test ${randomUUID()}`, mdrBps, discountBps],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const rawKey = (await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "t" })).rawKey;
  return { merchantId, rawKey };
}

async function authorize(rawKey: string, amountFils: number): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils, card: VALID_CARD },
  });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json() as { id: string }).id;
}

function capture(rawKey: string, transactionId: string, payload: { amountFils?: number } = {}) {
  return app.inject({
    method: "POST",
    url: `/v1/transactions/${transactionId}/capture`,
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload,
  });
}

/** Net fee the platform kept on a transaction (fee credits less any debits). */
async function netPlatformFee(transactionId: string): Promise<number> {
  const r = await pool.query<{ net: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)::text AS net
       FROM ledger_entries WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue'`,
    [transactionId],
  );
  return Number(r.rows[0]!.net);
}

async function assertBalanced(transactionId: string): Promise<void> {
  const r = await pool.query<{ entry_group_id: string; debits: string; credits: string }>(
    `SELECT entry_group_id,
            SUM(CASE WHEN direction = 'debit' THEN amount_fils ELSE 0 END)::text AS debits,
            SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE 0 END)::text AS credits
       FROM ledger_entries WHERE transaction_id = $1 GROUP BY entry_group_id`,
    [transactionId],
  );
  assert.ok(r.rows.length > 0);
  for (const g of r.rows) assert.equal(g.debits, g.credits, `group ${g.entry_group_id} unbalanced`);
}

test("the discount reduces the amount the MDR is charged on: 602 fils @ 275 bps, 12.5% off = 14 fils", async () => {
  // Discount first: 602 - round(602 * 12.5%) = 602 - 75 = 527; 527 @ 2.75% =
  // 14.49 -> 14. (Fee first, as before: 17 - round(17 * 12.5%) = 15.)
  const { rawKey } = await merchant(275, 1250);
  const txnId = await authorize(rawKey, 602);
  const res = await capture(rawKey, txnId);
  assert.equal(res.statusCode, 200, res.body);

  assert.equal(await netPlatformFee(txnId), 14);
  const ev = await pool.query<{ fee: string }>(
    `SELECT metadata->>'feeFils' AS fee FROM transaction_events
      WHERE transaction_id = $1 AND event_type IN ('captured', 'partially_captured')`,
    [txnId],
  );
  assert.deepEqual(ev.rows.map((r) => Number(r.fee)), [14]);
  await assertBalanced(txnId);
});

test("a merchant with no negotiated discount is charged the plain MDR", async () => {
  const { rawKey } = await merchant(275, 0);
  const txnId = await authorize(rawKey, 602);
  assert.equal((await capture(rawKey, txnId)).statusCode, 200);
  assert.equal(await netPlatformFee(txnId), 17); // 602 @ 2.75% = 16.555 -> 17
  await assertBalanced(txnId);
});

test("a payment-link capture gets the negotiated discount too", async () => {
  const { merchantId } = await merchant(275, 1250);
  const token = `disc-${randomUUID()}`;
  await pool.query(
    `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
     VALUES ($1, $2, 602, now() + interval '1 hour', 'merchant_api_key', gen_random_uuid())`,
    [merchantId, token],
  );
  const result = await payPaymentLink(pool, approvingAcquirer, { paymentLinkReservationTimeoutSeconds: 60, cardFingerprintKey: Buffer.alloc(32) }, {
    token,
    card: VALID_CARD,
    idempotencyKey: randomUUID(),
  });
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  const txnId = (result.body as { transactionId: string }).transactionId;

  assert.equal(await netPlatformFee(txnId), 14);
  await assertBalanced(txnId);
});

test("concurrent partial captures each get their own discount, booked once", async () => {
  // 12,000 + 8,000 at 250 bps with 10% off: (12,000 - 1,200) @ 2.5% = 270 and
  // (8,000 - 800) @ 2.5% = 180, so 450 in total — never 440/460 from one
  // capture's discount being applied twice and the other's never.
  const { rawKey } = await merchant(250, 1000);
  for (let i = 0; i < 5; i++) {
    const txnId = await authorize(rawKey, 20_000);
    const [a, b] = await Promise.all([
      capture(rawKey, txnId, { amountFils: 12_000 }),
      capture(rawKey, txnId, { amountFils: 8_000 }),
    ]);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);

    assert.equal(await netPlatformFee(txnId), 450);
    await assertBalanced(txnId);
  }
});
