/**
 * Regression tests: malformed query/path parameters are client errors.
 * `limit=abc`, unparseable `from`/`to` (an Invalid Date reaching SQL), a
 * non-UUID transaction id (Postgres 22P02) and a well-formed-JSON-but-bad
 * report filter all used to come back as 500 internal_error.
 *
 * Real, migrated Postgres; requires DATABASE_URL (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { errorHandler } from "../plugins/errorHandler.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("invalidParams.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 3 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

async function apiKeyHeaders(): Promise<Record<string, string>> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Invalid Params Test ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const owner = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: owner.rows[0]!.id, label: "params" });
  return { authorization: `Bearer ${issued.rawKey}` };
}

async function expect400(headers: Record<string, string>, method: "GET" | "POST", url: string, code: string) {
  const res = await app.inject({
    method,
    url,
    headers: method === "POST" ? { ...headers, "idempotency-key": randomUUID() } : headers,
    ...(method === "POST" ? { payload: {} } : {}),
  });
  assert.equal(res.statusCode, 400, `${method} ${url} -> ${res.body}`);
  assert.equal(res.json().error, code, `${method} ${url} -> ${res.body}`);
}

test("GET /v1/transactions rejects a non-numeric limit and unparseable from/to with 400", async () => {
  const headers = await apiKeyHeaders();
  await expect400(headers, "GET", "/v1/transactions?limit=abc", "invalid_request");
  await expect400(headers, "GET", "/v1/transactions?from=garbage", "invalid_request");
  await expect400(headers, "GET", "/v1/transactions?to=garbage", "invalid_request");

  const ok = await app.inject({ method: "GET", url: "/v1/transactions?limit=5&from=2026-01-01T00:00:00Z", headers });
  assert.equal(ok.statusCode, 200, ok.body);
});

test("GET /v1/transactions with a garbage cursor is 400, not 500", async () => {
  const headers = await apiKeyHeaders();
  const cursor = Buffer.from("not-a-timestamp|not-a-uuid", "utf8").toString("base64url");
  await expect400(headers, "GET", `/v1/transactions?cursor=${cursor}`, "invalid_request");
});

test("GET /v1/transactions/export rejects unparseable from/to with 400", async () => {
  const headers = await apiKeyHeaders();
  await expect400(headers, "GET", "/v1/transactions/export?from=garbage", "invalid_request");
  await expect400(headers, "GET", "/v1/transactions/export?to=2026-13-45", "invalid_request");
});

test("a non-UUID transaction id in the path is 400 invalid_id on every transaction route", async () => {
  const headers = await apiKeyHeaders();
  await expect400(headers, "GET", "/v1/transactions/not-a-uuid", "invalid_id");
  await expect400(headers, "GET", "/v1/transactions/not-a-uuid/events", "invalid_id");
  await expect400(headers, "POST", "/v1/transactions/not-a-uuid/capture", "invalid_id");
  await expect400(headers, "POST", "/v1/transactions/not-a-uuid/void", "invalid_id");

  const missing = await app.inject({ method: "GET", url: `/v1/transactions/${randomUUID()}`, headers });
  assert.equal(missing.statusCode, 404, missing.body);
});

test("GET /v1/reporting/transactions rejects a filter that is valid JSON but not a valid filter", async () => {
  const headers = await apiKeyHeaders();
  const bad = [
    "null",
    "[]",
    JSON.stringify({ from: "garbage" }),
    JSON.stringify({ to: 12345 }),
    JSON.stringify({ merchantId: "not-a-uuid" }),
    JSON.stringify({ status: ["captured"] }),
  ];
  for (const filter of bad) {
    await expect400(headers, "GET", `/v1/reporting/transactions?filter=${encodeURIComponent(filter)}`, "invalid_filter");
  }
  await expect400(headers, "GET", "/v1/reporting/transactions?filter=%7Bnope", "invalid_filter");

  const ok = await app.inject({
    method: "GET",
    url: `/v1/reporting/transactions?filter=${encodeURIComponent(JSON.stringify({ from: "2026-01-01T00:00:00Z" }))}`,
    headers,
  });
  assert.equal(ok.statusCode, 200, ok.body);
});

test("error handler: invalid uuid/timestamp input reaching Postgres is 400; other pg errors stay 500", async () => {
  const bare = Fastify({ logger: false });
  bare.setErrorHandler(errorHandler);
  bare.get("/uuid", async () => pool.query(`SELECT $1::uuid`, ["nope"]));
  bare.get("/timestamp", async () => pool.query(`SELECT $1::timestamptz`, ["nope"]));
  // A NaN money value into a bigint is also 22P02, but it is a server bug.
  bare.get("/bigint", async () => pool.query(`SELECT $1::bigint`, [Number.NaN]));
  bare.get("/syntax", async () => pool.query(`SELECT FROM WHERE`));
  try {
    for (const [url, status] of [["/uuid", 400], ["/timestamp", 400], ["/bigint", 500], ["/syntax", 500]] as const) {
      const res = await bare.inject({ method: "GET", url });
      assert.equal(res.statusCode, status, `${url}: ${res.body}`);
    }
  } finally {
    await bare.close();
  }
});
