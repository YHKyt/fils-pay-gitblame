/**
 * Regression test (docs/audit/large-export-upload.md): an "Import
 * adjustments" upload larger than the API's request body limit (Fastify's
 * default bodyLimit, 1 MiB — the console sends the CSV as a JSON field) must
 * be refused with a clean 413 that tells finance the file is too large. It
 * used to come back as a 500 internal_error, logged as an unhandled error,
 * which read as an API crash.
 *
 * Real, migrated Postgres; requires DATABASE_URL (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../adminAuth/passwords.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "adminAdjustmentImport.bodyLimit.test.ts requires DATABASE_URL to point at a real, migrated Postgres",
  );
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  SETTLEMENT_INTERNAL_TOKEN: "test-settlement-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const ADMIN_PASSWORD = "admin-test-password-9000!";

async function signedInFinanceAdmin(): Promise<string> {
  const email = `adj-import-limit-${randomUUID()}@admin.test`;
  await pool.query(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, $2, 'Test finance', 'finance')`,
    [email, await hashPassword(ADMIN_PASSWORD, config)],
  );
  const loginRes = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/login",
    payload: { email, password: ADMIN_PASSWORD },
  });
  assert.equal(loginRes.statusCode, 200, loginRes.body);
  const setCookie = loginRes.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie])
    .find((header) => header?.startsWith(`${config.adminCookieName}=`))
    ?.split(";")[0];
  assert.ok(cookie, "expected the admin session cookie");

  const verifyRes = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie },
    payload: { code: (loginRes.json() as { devOtpCode?: string }).devOtpCode },
  });
  assert.equal(verifyRes.statusCode, 200, verifyRes.body);
  return cookie;
}

test("an adjustments CSV over the request body limit is a 413, not a 500, and posts nothing", async () => {
  const cookie = await signedInFinanceAdmin();
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
     VALUES ($1, 250, 'active', false) RETURNING id`,
    [`Adj Import Limit ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;

  // ~1.5 MiB of well-formed rows: over the 1 MiB default, under any proxy limit.
  const row = `${merchantId},1.000,bulk statement correction\n`;
  const csvContent = `merchantId,amount,reason\n${row.repeat(Math.ceil((1.5 * 1024 * 1024) / row.length))}`;

  const res = await app.inject({
    method: "POST",
    url: "/v1/admin/adjustment-imports",
    headers: { cookie },
    payload: { csvContent, originalFilename: "too-big.csv" },
  });

  assert.equal(res.statusCode, 413, res.body);
  assert.equal(res.json().error, "payload_too_large");

  const legs = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM ledger_entries WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(legs.rows[0]!.n, 0, "a refused upload must not post anything");
});
