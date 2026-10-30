/**
 * Regression tests: the authorize body (POST /v1/transactions) must be
 * validated before the acquirer is ever called. A value Postgres refuses on
 * the INSERT that follows an approval leaves an authorization at the
 * acquirer with no transaction row.
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
  throw new Error("transactionsInputValidation.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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

/** Counts acquirer authorizations that came back approved; still delegates. */
function spyOnAcquirer() {
  const calls = { authorize: 0, approved: 0 };
  const realAuthorize = app.acquirer.authorize.bind(app.acquirer);
  app.acquirer.authorize = async (req) => {
    calls.authorize += 1;
    const result = await realAuthorize(req);
    if (result.outcome === "approved") calls.approved += 1;
    return result;
  };
  return {
    calls,
    restore() {
      app.acquirer.authorize = realAuthorize;
    },
  };
}

async function approvedMerchant(): Promise<{ merchantId: string; rawKey: string }> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Input Validation Test ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const owner = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: owner.rows[0]!.id, label: "input-validation" });
  return { merchantId, rawKey: issued.rawKey };
}

function authorizeRequest(rawKey: string, idempotencyKey: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": idempotencyKey },
    payload,
  });
}

async function transactionCount(merchantId: string): Promise<number> {
  const result = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM transactions WHERE merchant_id = $1`, [
    merchantId,
  ]);
  return result.rows[0]!.c;
}

test("a NUL byte in reference is a 400 before the acquirer authorizes the card", async () => {
  await app.ready();
  const { merchantId, rawKey } = await approvedMerchant();
  const key = randomUUID();
  const spy = spyOnAcquirer();
  try {
    // The old code answered 500 on every attempt and the acquirer approved
    // each one: three authorizations on the card, zero transaction rows.
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await authorizeRequest(rawKey, key, { amountFils: 10_000, card: VALID_CARD, reference: "order\u00001" });
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(res.json().error, "invalid_request");
    }
    assert.equal(spy.calls.authorize, 0, "the acquirer must not be called");
    assert.equal(spy.calls.approved, 0);
    assert.equal(await transactionCount(merchantId), 0);
  } finally {
    spy.restore();
  }

  // The key is not wedged: a corrected request with the same key succeeds.
  const ok = await authorizeRequest(rawKey, key, { amountFils: 10_000, card: VALID_CARD, reference: "order-1" });
  assert.equal(ok.statusCode, 201, ok.body);
  assert.equal(ok.json().reference, "order-1");
  assert.equal(await transactionCount(merchantId), 1);
});

test("a non-string reference is a 400, not stored as its JSON text", async () => {
  const { merchantId, rawKey } = await approvedMerchant();
  for (const reference of [123, { a: 1 }, ["x"], true]) {
    const res = await authorizeRequest(rawKey, randomUUID(), { amountFils: 1_000, card: VALID_CARD, reference });
    assert.equal(res.statusCode, 400, `${JSON.stringify(reference)}: ${res.body}`);
  }
  assert.equal(await transactionCount(merchantId), 0);

  // Omitted and null both still mean "no reference".
  for (const payload of [{ amountFils: 1_000, card: VALID_CARD }, { amountFils: 1_000, card: VALID_CARD, reference: null }]) {
    const res = await authorizeRequest(rawKey, randomUUID(), payload);
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().reference, null);
  }
});

test("a malformed card is a 400 invalid_card, not a 500 from the acquirer", async () => {
  const { merchantId, rawKey } = await approvedMerchant();
  const spy = spyOnAcquirer();
  try {
    for (const card of [{}, "4242424242424242", [], { pan: 4242424242424242 }, { pan: null }, { ...VALID_CARD, pan: "4242" }, { ...VALID_CARD, pan: "4242-4242-4242-4242" }]) {
      const res = await authorizeRequest(rawKey, randomUUID(), { amountFils: 1_000, card });
      assert.equal(res.statusCode, 400, `${JSON.stringify(card)}: ${res.body}`);
      assert.equal(res.json().error, "invalid_card");
    }
    assert.equal(spy.calls.authorize, 0, "the acquirer must not be called");
  } finally {
    spy.restore();
  }
  assert.equal(await transactionCount(merchantId), 0);

  const ok = await authorizeRequest(rawKey, randomUUID(), { amountFils: 1_000, card: VALID_CARD });
  assert.equal(ok.statusCode, 201, ok.body);
});
