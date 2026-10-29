/**
 * Capture idempotency is scoped to the transaction: reusing a capture key on
 * a DIFFERENT transaction must be rejected, not answered with the first
 * transaction's stored response. Route-level, real Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("captureIdempotency.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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

async function approvedMerchantKey(): Promise<string> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Capture Idem Test ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  return (await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "t" })).rawKey;
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

function capture(rawKey: string, transactionId: string, key: string) {
  return app.inject({
    method: "POST",
    url: `/v1/transactions/${transactionId}/capture`,
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": key },
    payload: {},
  });
}

test("a capture key reused on a different transaction is a 422, and the second transaction is untouched", async () => {
  const rawKey = await approvedMerchantKey();
  const txnA = await authorize(rawKey, 5_000);
  const txnB = await authorize(rawKey, 7_000);
  const key = `order-${randomUUID()}`;

  const first = await capture(rawKey, txnA, key);
  assert.equal(first.statusCode, 200, first.body);

  const second = await capture(rawKey, txnB, key);
  // Before the fix this replayed txnA's 200 body: the caller was told B was
  // captured while B stayed 'authorized' and was never charged.
  assert.equal(second.statusCode, 422, second.body);
  assert.equal(second.json().error, "idempotency_key_reused");

  const b = await pool.query<{ status: string; captured_fils: string }>(
    `SELECT status, captured_fils FROM transactions WHERE id = $1`,
    [txnB],
  );
  assert.equal(b.rows[0]!.status, "authorized");
  assert.equal(Number(b.rows[0]!.captured_fils), 0);

  // Same key on the same transaction still replays.
  const replay = await capture(rawKey, txnA, key);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json(), first.json());
});
