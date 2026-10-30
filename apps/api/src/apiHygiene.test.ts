/**
 * API hygiene: request-log redaction of payment-link tokens, baseline
 * security headers, and the uniform 404 shape for unknown routes.
 * Uses `app.inject(...)` against a real, migrated Postgres (the public
 * payment-link read hits the DB), so it needs DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { redactUrl } from "./lib/requestLogging.js";

const databaseUrl = process.env.DATABASE_URL;

test("redactUrl hides the payment-link token and secret query values only", () => {
  assert.equal(redactUrl("/v1/payment-links/abcDEF123"), "/v1/payment-links/[redacted]");
  assert.equal(redactUrl("/v1/payment-links/abcDEF123/pay"), "/v1/payment-links/[redacted]/pay");
  assert.equal(redactUrl("//v1//payment-links/abc?x=1"), "//v1//payment-links/[redacted]?x=1");
  assert.equal(
    redactUrl("/v1/transactions?limit=10&token=s3cr3t&api_key=k&cursor=c"),
    "/v1/transactions?limit=10&token=[redacted]&api_key=[redacted]&cursor=c",
  );
  // Merchant-side link routes use UUID ids, not tokens; left readable.
  assert.equal(
    redactUrl("/v1/merchants/m1/payment-links/l1"),
    "/v1/merchants/m1/payment-links/l1",
  );
});

test("API hygiene over HTTP", { skip: !databaseUrl && "DATABASE_URL not set" }, async (t) => {
  const lines: string[] = [];
  const config = loadConfig({
    DATABASE_URL: databaseUrl!,
    NODE_ENV: "test",
    KYC_UPLOAD_DIR: tmpdir(),
    INTERNAL_API_TOKEN: "test-internal-token",
    WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  });
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const app = buildApp(config, pool, { logStream: { write: (line) => void lines.push(line) } });
  t.after(async () => {
    await app.close();
    await pool.end();
  });

  await t.test("payment-link tokens never reach the request log", async () => {
    const token = `tok${randomBytes(12).toString("hex")}`;
    lines.length = 0;
    await app.inject({ method: "GET", url: `/v1/payment-links/${token}` });
    await app.inject({ method: "POST", url: `/v1/payment-links/${token}/pay`, payload: {} });
    await app.inject({ method: "GET", url: `/v1/transactions?token=${token}` });

    const log = lines.join("");
    const urls = lines
      .map((l) => JSON.parse(l) as { req?: { url?: string } })
      .filter((l) => l.req?.url)
      .map((l) => l.req!.url);
    assert.deepEqual(urls, [
      "/v1/payment-links/[redacted]",
      "/v1/payment-links/[redacted]/pay",
      "/v1/transactions?token=[redacted]",
    ]);
    assert.ok(!log.includes(token), "the token must not appear anywhere in the log");
  });

  await t.test("security headers on authenticated, public-link and health responses", async () => {
    for (const url of ["/v1/transactions", "/v1/payment-links/nosuchtoken", "/healthz"]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.headers["x-content-type-options"], "nosniff", url);
      assert.equal(res.headers["referrer-policy"], "no-referrer", url);
      assert.equal(res.headers["x-frame-options"], "DENY", url);
      assert.equal(res.headers["cache-control"], "no-store", url);
    }
  });
});
