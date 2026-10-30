/**
 * Regression: no upper bound on amountFils. Any safe integer was accepted
 * (9,007,199,254,740,991 fils authorized), so a merchant's sums passed
 * Number.MAX_SAFE_INTEGER: captures of MAX_SAFE_INTEGER and 2 fils were
 * summarized as 9,007,199,254,740,992. Every amount the API takes is now
 * capped at MAX_AMOUNT_FILS (10,000,000.000 BD) with the endpoint's
 * existing 400 code. Requires DATABASE_URL (migrated Postgres).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { parseCreditRequestInput } from "../admin/creditRequestValidation.js";
import { AppError } from "../lib/errors.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("amountUpperBound.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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
    [`Amount Cap Test ${randomUUID()}`],
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


/** lib/requestParams.ts MAX_AMOUNT_FILS, written out so this test does not
 *  depend on the constant it checks. */
const MAX_AMOUNT_FILS = 10_000_000_000;
const OVER = MAX_AMOUNT_FILS + 1;

test("authorize and capture: above MAX_AMOUNT_FILS is 400 invalid_amount; the cap itself is accepted", async () => {
  const { rawKey } = await approvedMerchant();
  const headers = () => ({ authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() });

  for (const amountFils of [OVER, Number.MAX_SAFE_INTEGER]) {
    const res = await app.inject({ method: "POST", url: "/v1/transactions", headers: headers(), payload: { amountFils, card: VALID_CARD } });
    assert.equal(res.statusCode, 400, `amountFils=${amountFils} -> ${res.body}`);
    assert.equal(res.json().error, "invalid_amount");
  }

  const ok = await app.inject({ method: "POST", url: "/v1/transactions", headers: headers(), payload: { amountFils: MAX_AMOUNT_FILS, card: VALID_CARD } });
  assert.equal(ok.statusCode, 201, ok.body);

  const capture = await app.inject({
    method: "POST",
    url: `/v1/transactions/${ok.json().id}/capture`,
    headers: headers(),
    payload: { amountFils: OVER },
  });
  assert.equal(capture.statusCode, 400, capture.body);
  assert.equal(capture.json().error, "invalid_amount");
});

test("payment link create: above MAX_AMOUNT_FILS is 400 invalid_amount", async () => {
  const { merchantId, rawKey } = await approvedMerchant();
  const create = (amountFils: number) =>
    app.inject({
      method: "POST",
      url: `/v1/merchants/${merchantId}/payment-links`,
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { amountFils, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
  const over = await create(OVER);
  assert.equal(over.statusCode, 400, over.body);
  assert.equal(over.json().error, "invalid_amount");
  const ok = await create(MAX_AMOUNT_FILS);
  assert.equal(ok.statusCode, 201, ok.body);
});

test("refund: amountFils above MAX_AMOUNT_FILS is 400 invalid_request", async () => {
  const { rawKey } = await approvedMerchant();
  const res = await app.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { transactionId: randomUUID(), amountFils: OVER },
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error, "invalid_request");
});

test("support credit: baseAmountFils above MAX_AMOUNT_FILS is 400 invalid_amount", () => {
  const body = { baseAmountFils: OVER, reasonCode: "goodwill", effectiveDate: "2026-10-01" };
  assert.throws(
    () => parseCreditRequestInput(body, new Date("2026-10-30T09:00:00Z")),
    (err: unknown) => err instanceof AppError && err.statusCode === 400 && err.code === "invalid_amount",
  );
  const ok = parseCreditRequestInput({ ...body, baseAmountFils: MAX_AMOUNT_FILS }, new Date("2026-10-30T09:00:00Z"));
  assert.equal(ok.baseAmountFils, MAX_AMOUNT_FILS);
});
