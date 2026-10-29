/**
 * merchant_balances.cached_payable_fils caches the merchant_payable ledger
 * account (ADR-0004), so capture and refund must move it with their legs.
 * They used to leave it alone and settlement's batch close added the net
 * instead, which double-counted every capture a rebuild had already read
 * from the ledger. Requires `DATABASE_URL` (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { toFils } from "@filspay/money";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import type { AcquirerRefundResult, AcquirerSimulator } from "../acquirer/types.js";
import { processRefund } from "./processRefund.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("payableCache.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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

const approvingAcquirer: AcquirerSimulator = {
  authorize() {
    throw new Error("not used");
  },
  capture() {
    throw new Error("not used");
  },
  refund(req): Promise<AcquirerRefundResult> {
    return Promise.resolve({ outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 });
  },
};

async function cacheAndLedger(merchantId: string): Promise<{ cached: number | null; ledger: number }> {
  const cached = await pool.query<{ fils: string }>(
    `SELECT cached_payable_fils AS fils FROM merchant_balances WHERE merchant_id = $1`,
    [merchantId],
  );
  const ledger = await pool.query<{ fils: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0) AS fils
       FROM ledger_entries WHERE merchant_id = $1 AND account_id = 'merchant_payable'`,
    [merchantId],
  );
  return { cached: cached.rows[0] ? Number(cached.rows[0].fils) : null, ledger: Number(ledger.rows[0]!.fils) };
}

test("capture and refund move the balance cache by exactly what they post to merchant_payable", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Payable Cache ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const { rawKey } = await issueApiKey(pool, config, { merchantId, createdBy: user.rows[0]!.id, label: "cache" });
  const headers = () => ({ authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() });

  const authorized = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: headers(),
    payload: {
      amountFils: 10_000,
      card: { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" },
      reference: "cache",
    },
  });
  assert.equal(authorized.statusCode, 201, authorized.body);
  const txnId = (authorized.json() as { id: string }).id;
  const captured = await app.inject({
    method: "POST",
    url: `/v1/transactions/${txnId}/capture`,
    headers: headers(),
    payload: {},
  });
  assert.equal(captured.statusCode, 200, captured.body);

  const afterCapture = await cacheAndLedger(merchantId);
  assert.equal(afterCapture.ledger, 9_750);
  assert.equal(afterCapture.cached, afterCapture.ledger, "capture must move the cache with merchant_payable");

  const key = await pool.query<{ id: string }>(`SELECT id FROM api_keys WHERE merchant_id = $1`, [merchantId]);
  const refunded = await processRefund(pool, approvingAcquirer, {
    transactionId: txnId,
    merchantId,
    amountFils: toFils(4_000),
    idempotencyKey: randomUUID(),
    actor: { type: "merchant_api_key", id: key.rows[0]!.id },
  });
  assert.equal(refunded.statusCode, 200, JSON.stringify(refunded.body));

  const afterRefund = await cacheAndLedger(merchantId);
  assert.ok(afterRefund.ledger < afterCapture.ledger);
  assert.equal(afterRefund.cached, afterRefund.ledger, "refund must move the cache with merchant_payable");
});
