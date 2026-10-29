/**
 * Regression tests: amountFils on authorize (POST /v1/transactions) and
 * capture must be validated before the acquirer is ever called. A zero
 * amount used to be authorized at the acquirer and then fail the
 * transactions CHECK (amount_fils > 0) on insert -> 500, leaving an
 * authorization at the acquirer with no transaction row; strings, floats,
 * negatives and unsafe integers made toFils throw a RangeError -> 500.
 * All must be 400 invalid_amount with zero acquirer calls.
 *
 * Real, migrated Postgres; requires DATABASE_URL (run `npm run migrate` first).
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
  throw new Error("transactionsAmountValidation.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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

const pool = new Pool({ connectionString: databaseUrl, max: 3 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

// JSON can't carry NaN or Infinity; they serialize to null, which is covered.
const BAD_AMOUNTS: unknown[] = [0, -1, -500, 1.5, 0.001, "100", "abc", null, true, {}, [100], 2 ** 53, 1e300];

/** Spies on the real simulator: counts calls, still delegates. */
function spyOnAcquirer() {
  const calls = { authorize: 0, capture: 0 };
  const realAuthorize = app.acquirer.authorize.bind(app.acquirer);
  const realCapture = app.acquirer.capture.bind(app.acquirer);
  app.acquirer.authorize = async (req) => {
    calls.authorize += 1;
    return realAuthorize(req);
  };
  app.acquirer.capture = async (req) => {
    calls.capture += 1;
    return realCapture(req);
  };
  return {
    calls,
    restore() {
      app.acquirer.authorize = realAuthorize;
      app.acquirer.capture = realCapture;
    },
  };
}

async function approvedMerchantKey(): Promise<string> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Amount Validation Test ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const owner = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: owner.rows[0]!.id, label: "amount" });
  return issued.rawKey;
}

test("authorize: an invalid amountFils is 400 invalid_amount and the acquirer is never called", async () => {
  const rawKey = await approvedMerchantKey();
  const spy = spyOnAcquirer();
  try {
    for (const amountFils of BAD_AMOUNTS) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/transactions",
        headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
        payload: { amountFils, card: VALID_CARD, reference: "amount-check" },
      });
      assert.equal(res.statusCode, 400, `amountFils=${JSON.stringify(amountFils)} -> ${res.body}`);
      assert.equal(res.json().error, "invalid_amount", `amountFils=${JSON.stringify(amountFils)}`);
    }
    assert.equal(spy.calls.authorize, 0, "acquirer.authorize must not be called for an invalid amount");

    const ok = await app.inject({
      method: "POST",
      url: "/v1/transactions",
      headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
      payload: { amountFils: 1500, card: VALID_CARD, reference: "amount-check" },
    });
    assert.equal(ok.statusCode, 201, ok.body);
    assert.equal(spy.calls.authorize, 1);
  } finally {
    spy.restore();
  }
});

test("capture: an invalid amountFils is 400 invalid_amount and the acquirer is never called", async () => {
  const rawKey = await approvedMerchantKey();
  const auth = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils: 10_000, card: VALID_CARD, reference: "amount-check" },
  });
  assert.equal(auth.statusCode, 201, auth.body);
  const txnId = auth.json().id as string;

  const spy = spyOnAcquirer();
  try {
    for (const amountFils of BAD_AMOUNTS) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/transactions/${txnId}/capture`,
        headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
        payload: { amountFils },
      });
      assert.equal(res.statusCode, 400, `amountFils=${JSON.stringify(amountFils)} -> ${res.body}`);
      assert.equal(res.json().error, "invalid_amount", `amountFils=${JSON.stringify(amountFils)}`);
    }
    assert.equal(spy.calls.capture, 0, "acquirer.capture must not be called for an invalid amount");

    const row = await pool.query<{ status: string; captured_fils: string }>(
      `SELECT status, captured_fils FROM transactions WHERE id = $1`,
      [txnId],
    );
    assert.equal(row.rows[0]!.status, "authorized");
    assert.equal(Number(row.rows[0]!.captured_fils), 0);

    const ok = await app.inject({
      method: "POST",
      url: `/v1/transactions/${txnId}/capture`,
      headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
      payload: { amountFils: 4_000 },
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(spy.calls.capture, 1);
  } finally {
    spy.restore();
  }
});
