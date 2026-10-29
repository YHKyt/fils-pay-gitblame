/**
 * GET /v1/auth/me for an admin's "view as merchant" grant: the merchant
 * dashboard can only render (and show its impersonation banner) if `me`
 * answers for the fp_impersonation cookie, read-only. Real Postgres, like
 * the other route tests (run `npm run migrate` first).
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
  throw new Error("authMeImpersonation.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  SETTLEMENT_INTERNAL_TOKEN: "test-settlement-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

function parseCookie(setCookieHeader: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const header of headers) {
    if (header && header.startsWith(`${name}=`)) return header.split(";")[0] as string;
  }
  throw new Error(`expected a Set-Cookie header for ${name}`);
}

const ADMIN_PASSWORD = "admin-test-password-9000!";

async function signedInSupportAdmin(): Promise<string> {
  const email = `me-imp-${randomUUID()}@admin.test`;
  await pool.query(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, 'Test support', 'support')`,
    [email, await hashPassword(ADMIN_PASSWORD, config)],
  );
  const loginRes = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/login",
    payload: { email, password: ADMIN_PASSWORD },
  });
  assert.equal(loginRes.statusCode, 200, loginRes.body);
  const verifyRes = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie: parseCookie(loginRes.headers["set-cookie"], config.adminCookieName) },
    payload: { code: (loginRes.json() as { devOtpCode: string }).devOtpCode },
  });
  assert.equal(verifyRes.statusCode, 200, verifyRes.body);
  return parseCookie(verifyRes.headers["set-cookie"], config.adminCookieName);
}

test("GET /v1/auth/me answers read-only for an impersonation grant, and 401 once it is ended", async () => {
  const adminCookie = await signedInSupportAdmin();
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Me Imp ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;

  const startRes = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/impersonate`,
    headers: { cookie: adminCookie },
  });
  assert.equal(startRes.statusCode, 201, startRes.body);
  const started = startRes.json() as { grantId: string; expiresAt: string };
  const impCookie = parseCookie(startRes.headers["set-cookie"], config.impersonationCookieName);

  const meRes = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: impCookie } });
  assert.equal(meRes.statusCode, 200, meRes.body);
  const me = meRes.json() as {
    merchantUserId: string | null;
    email: string | null;
    role: string;
    merchant: { id: string };
    impersonation?: { grantId: string; expiresAt: string; readOnly: boolean };
  };
  assert.equal(me.merchant.id, merchantId);
  assert.equal(me.role, "support");
  assert.equal(me.merchantUserId, null);
  assert.equal(me.email, null);
  assert.deepEqual(me.impersonation, { grantId: started.grantId, expiresAt: started.expiresAt, readOnly: true });

  // The admin's own session cookie is still not merchant authority.
  const adminOnly = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: adminCookie } });
  assert.equal(adminOnly.statusCode, 401);

  const endRes = await app.inject({
    method: "POST",
    url: `/v1/admin/impersonation/${started.grantId}/end`,
    headers: { cookie: adminCookie },
  });
  assert.equal(endRes.statusCode, 204);
  const cleared = endRes.headers["set-cookie"];
  assert.match(String(cleared), new RegExp(`${config.impersonationCookieName}=;`));

  const afterEnd = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: impCookie } });
  assert.equal(afterEnd.statusCode, 401);
});

test("GET /v1/auth/me with no cookie is still 401", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/auth/me" });
  assert.equal(res.statusCode, 401);
});
