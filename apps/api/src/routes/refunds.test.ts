/**
 * Route-level tests for `POST /v1/refunds` (FP-300) through `app.inject`
 * against a real, migrated Postgres. Requires `DATABASE_URL`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import type { AcquirerSimulator } from "../acquirer/types.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("refunds.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)");
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

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function createApprovedMerchantWithApiKey(label: string, mdrBps = 250) {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Refund Route Merchant ${label} ${randomUUID()}`, mdrBps],
  );
  const merchantId = merchantResult.rows[0]!.id;
  const userResult = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: userResult.rows[0]!.id, label });
  return { merchantId, rawKey: issued.rawKey };
}

function authHeader(rawKey: string) {
  return { authorization: `Bearer ${rawKey}` };
}

async function capturedTransaction(rawKey: string, amountFils: number): Promise<string> {
  const auth = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { ...authHeader(rawKey), "idempotency-key": randomUUID() },
    payload: { amountFils, card: VALID_CARD, reference: "refund-route" },
  });
  assert.equal(auth.statusCode, 201, auth.body);
  const id = auth.json().id as string;
  const cap = await app.inject({
    method: "POST",
    url: `/v1/transactions/${id}/capture`,
    headers: { ...authHeader(rawKey), "idempotency-key": randomUUID() },
    payload: {},
  });
  assert.equal(cap.statusCode, 200, cap.body);
  return id;
}

// Regression: the reason was only type-checked. Postgres TEXT rejects
// U+0000, and the reason is first written in the journal step, after the
// acquirer has refunded the card, so the INSERT failed there: the cardholder
// got 10,000 fils back, the merchant_payable reversal was never posted (the
// next payout still included it), the request was a 500 and the key stayed
// in_progress for good.
test("a NUL byte in reason is a 400 before the acquirer is called", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("refund-nul-reason");
  const txnId = await capturedTransaction(rawKey, 10_000);

  const acquirer = app.acquirer as { refund: AcquirerSimulator["refund"] };
  const realRefund = acquirer.refund;
  let acquirerRefundCalls = 0;
  acquirer.refund = (req) => {
    acquirerRefundCalls += 1;
    return realRefund(req);
  };
  try {
    const res = await app.inject({
      method: "POST",
      url: "/v1/refunds",
      headers: { ...authHeader(rawKey), "idempotency-key": randomUUID(), "content-type": "application/json" },
      payload: JSON.stringify({ transactionId: txnId, amountFils: 10_000, reason: "duplicate\u0000" }),
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().error, "invalid_request");
    assert.equal(acquirerRefundCalls, 0, "the acquirer must not be asked to refund");
  } finally {
    acquirer.refund = realRefund;
  }

  const row = await pool.query<{ refunded_fils: string }>(`SELECT refunded_fils FROM transactions WHERE id = $1`, [
    txnId,
  ]);
  assert.equal(Number(row.rows[0]!.refunded_fils), 0);

  const clean = await app.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: { ...authHeader(rawKey), "idempotency-key": randomUUID() },
    payload: { transactionId: txnId, amountFils: 10_000, reason: "duplicate" },
  });
  assert.equal(clean.statusCode, 200, clean.body);
  const payable = await pool.query<{ net: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)::text AS net
       FROM ledger_entries WHERE transaction_id = $1 AND account_id = 'merchant_payable'`,
    [txnId],
  );
  // 10,000 captured at 2.50% (250 fee), fully refunded with the fee reversed.
  assert.equal(Number(payable.rows[0]!.net), 0);
});
