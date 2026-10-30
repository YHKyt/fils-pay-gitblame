/**
 * Regression test: GET /v1/transactions?limit=0 answered 200 with one row
 * (listTransactions clamps a limit below 1 up to 1), while the same route
 * already answers 400 invalid_request for a negative or non-numeric limit.
 * Zero is no page size either: it is now the same 400.
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
  throw new Error("transactionsListLimit.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
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

test("GET /v1/transactions: limit=0, a negative or a non-numeric limit is 400 invalid_request; 1..n and no limit page", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`List Limit Test ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const owner = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: owner.rows[0]!.id, label: "list-limit" });
  const authorization = `Bearer ${issued.rawKey}`;

  for (let i = 0; i < 3; i++) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/transactions",
      headers: { authorization, "idempotency-key": randomUUID() },
      payload: { amountFils: 1_000 + i, card: { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" } },
    });
    assert.equal(res.statusCode, 201, res.body);
  }

  const list = (query: string) => app.inject({ method: "GET", url: `/v1/transactions${query}`, headers: { authorization } });

  for (const bad of ["0", "00", "-1", "-5", "abc", "1.5", "2abc"]) {
    const res = await list(`?limit=${bad}`);
    assert.equal(res.statusCode, 400, `limit=${bad} -> ${res.body}`);
    assert.equal(res.json().error, "invalid_request", `limit=${bad} -> ${res.body}`);
  }

  const one = await list("?limit=1");
  assert.equal(one.statusCode, 200, one.body);
  assert.equal(one.json().transactions.length, 1);
  assert.notEqual(one.json().nextCursor, null);

  const two = await list("?limit=2");
  assert.equal(two.json().transactions.length, 2);

  for (const query of ["", "?limit="]) {
    const res = await list(query);
    assert.equal(res.statusCode, 200, `${query} -> ${res.body}`);
    assert.equal(res.json().transactions.length, 3, `${query}: the default page holds all three`);
  }
});
