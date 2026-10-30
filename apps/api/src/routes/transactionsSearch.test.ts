/**
 * Regression tests: GET /v1/transactions?search= treats the search as
 * literal text. LIKE wildcards in it used to act as wildcards, and a NUL
 * byte or a repeated parameter reached Postgres.
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
  throw new Error("transactionsSearch.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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
    [`Search Test ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const owner = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: owner.rows[0]!.id, label: "search" });
  return { merchantId, rawKey: issued.rawKey };
}

async function authorizeWithReference(rawKey: string, reference: string): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils: 1_000, card: VALID_CARD, reference },
  });
  assert.equal(res.statusCode, 201, res.body);
}

async function search(rawKey: string, query: string) {
  return app.inject({ method: "GET", url: `/v1/transactions?${query}`, headers: { authorization: `Bearer ${rawKey}` } });
}

async function referencesFor(rawKey: string, term: string): Promise<string[]> {
  const res = await search(rawKey, `search=${encodeURIComponent(term)}`);
  assert.equal(res.statusCode, 200, res.body);
  return (res.json().transactions as { reference: string }[]).map((t) => t.reference).sort();
}

test("LIKE wildcards in search match only themselves", async () => {
  const { rawKey } = await approvedMerchant();
  for (const reference of ["order_1", "orderX1", "50%off", "500off", "back\\slash", "backXslash"]) {
    await authorizeWithReference(rawKey, reference);
  }
  // The old code: "order_1" -> [order_1, orderX1]; "%" -> all six rows.
  // (A bare "_" is not asserted: every acquirer reference is "acq_<uuid>".)
  assert.deepEqual(await referencesFor(rawKey, "order_1"), ["order_1"]);
  assert.deepEqual(await referencesFor(rawKey, "r_1"), ["order_1"]);
  assert.deepEqual(await referencesFor(rawKey, "50%"), ["50%off"]);
  assert.deepEqual(await referencesFor(rawKey, "%"), ["50%off"]);
  assert.deepEqual(await referencesFor(rawKey, "back\\"), ["back\\slash"]);
  // Plain substring and case-insensitive matching still work.
  assert.deepEqual(await referencesFor(rawKey, "ORDER"), ["orderX1", "order_1"].sort());
});

test("a NUL byte or a repeated search parameter is a 400, not a 500", async () => {
  const { rawKey } = await approvedMerchant();
  for (const query of ["search=%00", "search=a%00b", "search=a&search=b"]) {
    const res = await search(rawKey, query);
    assert.equal(res.statusCode, 400, `${query}: ${res.body}`);
    assert.equal(res.json().error, "invalid_request");
  }
});

test("search still finds a transaction by its exact id", async () => {
  const { rawKey } = await approvedMerchant();
  await authorizeWithReference(rawKey, "by-id");
  const listed = await search(rawKey, "");
  const id = listed.json().transactions[0].id as string;
  const res = await search(rawKey, `search=${id}`);
  assert.deepEqual((res.json().transactions as { id: string }[]).map((t) => t.id), [id]);
});
