/**
 * Regression: the `currency` field was ignored. `{"amountFils":1500,
 * "currency":"USD"}` was authorized as 1,500 fils of BHD. FilsPay is
 * BHD-only, so a currency other than "BHD" is now 400 unsupported_currency
 * before the acquirer is called; leaving it out or sending "BHD" still
 * works. Requires DATABASE_URL (migrated Postgres).
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
  throw new Error("currencyBhdOnly.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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

async function approvedMerchant(): Promise<{ merchantId: string; rawKey: string }> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Currency Test ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const owner = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: owner.rows[0]!.id, label: "amount" });
  return { merchantId, rawKey: issued.rawKey };
}



const BAD_CURRENCIES: unknown[] = ["USD", "bhd", "", null, 48, { code: "BHD" }];

test("authorize: a currency other than BHD is 400 unsupported_currency and the acquirer is never called", async () => {
  const { rawKey } = await approvedMerchant();
  const headers = () => ({ authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() });
  let calls = 0;
  const realAuthorize = app.acquirer.authorize.bind(app.acquirer);
  app.acquirer.authorize = async (req) => {
    calls += 1;
    return realAuthorize(req);
  };
  try {
    for (const currency of BAD_CURRENCIES) {
      const res = await app.inject({ method: "POST", url: "/v1/transactions", headers: headers(), payload: { amountFils: 1500, currency, card: VALID_CARD } });
      assert.equal(res.statusCode, 400, `currency=${JSON.stringify(currency)} -> ${res.body}`);
      assert.equal(res.json().error, "unsupported_currency");
    }
    assert.equal(calls, 0);

    const bhd = await app.inject({ method: "POST", url: "/v1/transactions", headers: headers(), payload: { amountFils: 1500, currency: "BHD", card: VALID_CARD } });
    assert.equal(bhd.statusCode, 201, bhd.body);
    assert.equal(bhd.json().currency, "BHD");
    const none = await app.inject({ method: "POST", url: "/v1/transactions", headers: headers(), payload: { amountFils: 1500, card: VALID_CARD } });
    assert.equal(none.statusCode, 201, none.body);

    const capture = await app.inject({
      method: "POST",
      url: `/v1/transactions/${bhd.json().id}/capture`,
      headers: headers(),
      payload: { amountFils: 1500, currency: "USD" },
    });
    assert.equal(capture.statusCode, 400, capture.body);
    assert.equal(capture.json().error, "unsupported_currency");
  } finally {
    app.acquirer.authorize = realAuthorize;
  }
});

test("payment link create and refund: a currency other than BHD is 400 unsupported_currency", async () => {
  const { merchantId, rawKey } = await approvedMerchant();
  const link = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/payment-links`,
    headers: { authorization: `Bearer ${rawKey}` },
    payload: { amountFils: 2000, currency: "USD", expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  assert.equal(link.statusCode, 400, link.body);
  assert.equal(link.json().error, "unsupported_currency");

  const refund = await app.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { transactionId: randomUUID(), amountFils: 100, currency: "EUR" },
  });
  assert.equal(refund.statusCode, 400, refund.body);
  assert.equal(refund.json().error, "unsupported_currency");
});
