/**
 * Regression tests: Fastify's own request-parsing errors (malformed JSON,
 * empty JSON body, unsupported Content-Type, ...) are client errors and must
 * come back as their 4xx with a stable error code. They used to fall through
 * plugins/errorHandler.ts to a 500 internal_error. A genuine server bug must
 * still be a 500.
 *
 * Real, migrated Postgres; requires DATABASE_URL (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { errorHandler } from "./errorHandler.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("errorHandler.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

test("a malformed JSON body is 400 invalid_json, not 500", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { "content-type": "application/json" },
    payload: '{"amountFils": 100,',
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error, "invalid_json");
});

test("an empty body with Content-Type application/json is 400 invalid_json", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { "content-type": "application/json" },
    payload: "",
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error, "invalid_json");
});

test("an unsupported Content-Type is 415 unsupported_media_type", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { "content-type": "application/xml" },
    payload: "<amountFils>100</amountFils>",
  });
  assert.equal(res.statusCode, 415, res.body);
  assert.equal(res.json().error, "unsupported_media_type");
});

test("a body over the limit keeps its 413 payload_too_large mapping", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ pad: "x".repeat(1024 * 1024 + 1) }),
  });
  assert.equal(res.statusCode, 413, res.body);
  assert.equal(res.json().error, "payload_too_large");
});

test("a genuine server error is still 500 internal_error, even if it carries a 4xx statusCode", async () => {
  const bare = Fastify({ logger: false });
  bare.setErrorHandler(errorHandler);
  bare.get("/bug", async () => {
    throw new TypeError("cannot read properties of undefined");
  });
  bare.get("/bug-with-status", async () => {
    const err = new Error("upstream said 404") as Error & { statusCode: number; code: string };
    err.statusCode = 404;
    err.code = "UPSTREAM_NOT_FOUND";
    throw err;
  });
  try {
    for (const url of ["/bug", "/bug-with-status"]) {
      const res = await bare.inject({ method: "GET", url });
      assert.equal(res.statusCode, 500, `${url}: ${res.body}`);
      assert.deepEqual(res.json(), { error: "internal_error" });
    }
  } finally {
    await bare.close();
  }
});
