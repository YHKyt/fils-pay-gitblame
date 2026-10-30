/**
 * Origin/Referer check for cookie-authenticated state-changing /v1 calls.
 * The pure decision is unit-tested; one `app.inject` pass proves the hook is
 * wired and runs before any handler (no DB needed: refused requests never
 * reach a query, allowed ones go to the 404 handler).
 */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { isForbiddenCrossOrigin, type OriginCheckInput } from "./originCheck.js";

const base: OriginCheckInput = {
  method: "POST",
  url: "/v1/merchants/m1/refunds",
  hasAuthorization: false,
  hasAuthCookie: true,
  origin: undefined,
  referer: undefined,
  host: "pay.example.test:8080",
  allowedOrigins: ["https://checkout.example.test"],
};

test("cross-origin cookie POST is refused", () => {
  assert.equal(isForbiddenCrossOrigin({ ...base, origin: "https://evil.example" }), true);
  assert.equal(isForbiddenCrossOrigin({ ...base, origin: "null" }), true);
  assert.equal(isForbiddenCrossOrigin({ ...base, origin: "http://pay.example.test.evil.example" }), true);
  assert.equal(isForbiddenCrossOrigin({ ...base, referer: "https://evil.example/page" }), true);
  assert.equal(isForbiddenCrossOrigin({ ...base, method: "DELETE", origin: "https://evil.example" }), true);
});

test("same host, configured checkout origin, and non-browser calls are allowed", () => {
  // nginx forwards $host without the port: hostname compare.
  assert.equal(isForbiddenCrossOrigin({ ...base, origin: "http://pay.example.test:8080" }), false);
  assert.equal(isForbiddenCrossOrigin({ ...base, host: "pay.example.test", origin: "http://pay.example.test:8080" }), false);
  assert.equal(isForbiddenCrossOrigin({ ...base, origin: "https://checkout.example.test" }), false);
  assert.equal(isForbiddenCrossOrigin({ ...base, referer: "http://pay.example.test/dashboard" }), false);
  // No Origin and no Referer: curl / server-to-server / test harness.
  assert.equal(isForbiddenCrossOrigin(base), false);
});

test("exempt: safe methods, Authorization header, no auth cookie, non-/v1", () => {
  const evil = { ...base, origin: "https://evil.example" };
  assert.equal(isForbiddenCrossOrigin({ ...evil, method: "GET" }), false);
  assert.equal(isForbiddenCrossOrigin({ ...evil, method: "OPTIONS" }), false);
  assert.equal(isForbiddenCrossOrigin({ ...evil, hasAuthorization: true }), false);
  assert.equal(isForbiddenCrossOrigin({ ...evil, hasAuthCookie: false }), false);
  assert.equal(isForbiddenCrossOrigin({ ...evil, url: "/healthz" }), false);
});

test("hook refuses a forged cookie request before any handler", async (t) => {
  const config = loadConfig({
    DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none",
    NODE_ENV: "test",
    KYC_UPLOAD_DIR: tmpdir(),
    INTERNAL_API_TOKEN: "test-internal-token",
    WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
    CHECKOUT_BASE_URL: "https://checkout.example.test",
  });
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1 });
  const app = buildApp(config, pool);
  t.after(async () => {
    await app.close();
    await pool.end();
  });

  const forged = await app.inject({
    method: "POST",
    url: "/v1/no-such-route",
    headers: { origin: "https://evil.example", cookie: `${config.cookieName}=x`, host: "pay.example.test" },
    payload: {},
  });
  assert.equal(forged.statusCode, 403);
  assert.equal(forged.json().error, "forbidden_origin");

  const adminForged = await app.inject({
    method: "POST",
    url: "/v1/no-such-route",
    headers: { origin: "https://evil.example", cookie: `${config.adminCookieName}=x`, host: "pay.example.test" },
    payload: {},
  });
  assert.equal(adminForged.statusCode, 403);

  const sameOrigin = await app.inject({
    method: "POST",
    url: "/v1/no-such-route",
    headers: { origin: "http://pay.example.test:8080", cookie: `${config.cookieName}=x`, host: "pay.example.test" },
    payload: {},
  });
  assert.equal(sameOrigin.statusCode, 404);

  const apiKeyClient = await app.inject({
    method: "POST",
    url: "/v1/no-such-route",
    headers: { origin: "https://evil.example", authorization: "Bearer k", cookie: `${config.cookieName}=x` },
    payload: {},
  });
  assert.equal(apiKeyClient.statusCode, 404);

  // CORS: /v1 never reflects an arbitrary Origin.
  assert.equal(forged.headers["access-control-allow-origin"], undefined);
  assert.equal(sameOrigin.headers["access-control-allow-origin"], undefined);
});
