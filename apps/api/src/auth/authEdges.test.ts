/**
 * Merchant-plane authentication edge cases, via `app.inject(...)` against a
 * real, migrated Postgres. Requires DATABASE_URL (run `npm run migrate`).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "./passwords.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("authEdges.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const PASSWORD = "auth-edges-password-123!";

function parseCookie(setCookieHeader: string | string[] | undefined): string {
  const header = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!header) throw new Error("expected a Set-Cookie header in the response");
  return header.split(";")[0] as string;
}

async function signup(label: string): Promise<{ merchantId: string; email: string }> {
  const email = `${label}-${randomUUID()}@example.test`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/merchants",
    payload: {
      businessProfile: {
        legalName: `Auth Edges ${label}`,
        registrationNumber: `RC-${randomUUID().slice(0, 8)}`,
        businessType: "llc",
        contactEmail: `contact-${randomUUID()}@example.test`,
        contactPhone: "+97300000000",
        addressLine1: "1 Test Street",
        city: "Manama",
      },
      owner: { email, password: PASSWORD },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return { merchantId: (res.json() as { merchantId: string }).merchantId, email };
}

async function login(merchantId: string, email: string): Promise<{ cookie: string; code: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { merchantId, email, password: PASSWORD },
  });
  assert.equal(res.statusCode, 200, res.body);
  return { cookie: parseCookie(res.headers["set-cookie"]), code: (res.json() as { devOtpCode: string }).devOtpCode };
}

async function loginAndVerify(merchantId: string, email: string): Promise<string> {
  const { cookie, code } = await login(merchantId, email);
  const res = await app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie }, payload: { code } });
  assert.equal(res.statusCode, 200, res.body);
  return parseCookie(res.headers["set-cookie"]);
}

for (const status of ["suspended", "closed"] as const) {
  test(`a ${status} merchant's existing sessions and API keys stop authenticating`, async () => {
    const { merchantId, email } = await signup(`status-${status}`);
    const cookie = await loginAndVerify(merchantId, email);

    const keyRes = await app.inject({
      method: "POST",
      url: `/v1/merchants/${merchantId}/api-keys`,
      headers: { cookie },
      payload: { label: "edge" },
    });
    assert.equal(keyRes.statusCode, 201, keyRes.body);
    const bearer = `Bearer ${(keyRes.json() as { rawKey: string }).rawKey}`;

    const before = await app.inject({ method: "GET", url: "/v1/transactions", headers: { authorization: bearer } });
    assert.equal(before.statusCode, 200, before.body);
    assert.equal((await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie } })).statusCode, 200);

    await pool.query(`UPDATE merchants SET status = $2 WHERE id = $1`, [merchantId, status]);

    // Login already refuses a non-active merchant; a session or key issued
    // before the status change must not outlive it.
    const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie } });
    assert.equal(me.statusCode, 401, "session cookie still authenticates /v1/auth/me");
    const listByCookie = await app.inject({ method: "GET", url: "/v1/transactions", headers: { cookie } });
    assert.equal(listByCookie.statusCode, 401, "session cookie still authenticates requireMerchantAuth");
    const listByKey = await app.inject({ method: "GET", url: "/v1/transactions", headers: { authorization: bearer } });
    assert.equal(listByKey.statusCode, 401, "API key still authenticates requireMerchantAuth");
    const authorize = await app.inject({
      method: "POST",
      url: "/v1/transactions",
      headers: { authorization: bearer, "idempotency-key": randomUUID() },
      payload: { amountFils: 1000, card: { number: "4242424242424242", expMonth: 12, expYear: 2030, cvc: "123" } },
    });
    assert.equal(authorize.statusCode, 401, "API key still authenticates requireApiKey (authorize)");

    // Reactivation restores both: suspension is not revocation.
    await pool.query(`UPDATE merchants SET status = 'active' WHERE id = $1`, [merchantId]);
    assert.equal((await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie } })).statusCode, 200);
    const after = await app.inject({ method: "GET", url: "/v1/transactions", headers: { authorization: bearer } });
    assert.equal(after.statusCode, 200, after.body);
  });
}

async function attempt(url: string, payload: Record<string, string>): Promise<number> {
  return (await app.inject({ method: "POST", url, payload })).statusCode;
}

const LOCKOUT_CASES = [
  {
    plane: "merchant",
    url: "/v1/auth/login",
    table: "merchant_users",
    async account(): Promise<{ id: string; body: Record<string, string> }> {
      const { merchantId, email } = await signup("lockout");
      const row = await pool.query<{ id: string }>(
        `SELECT id FROM merchant_users WHERE merchant_id = $1 AND email = $2`,
        [merchantId, email],
      );
      return { id: row.rows[0]!.id, body: { merchantId, email } };
    },
  },
  {
    plane: "admin",
    url: "/v1/admin/auth/login",
    table: "admin_users",
    async account(): Promise<{ id: string; body: Record<string, string> }> {
      const email = `lockout-${randomUUID()}@admin.test`;
      const row = await pool.query<{ id: string }>(
        `INSERT INTO admin_users (email, password_hash, display_name, role)
         VALUES ($1, $2, 'Lockout', 'super_admin') RETURNING id`,
        [email, await hashPassword(PASSWORD, config)],
      );
      return { id: row.rows[0]!.id, body: { email } };
    },
  },
] as const;

for (const c of LOCKOUT_CASES) {
  test(`${c.plane} login locks the account after repeated wrong passwords, even in parallel`, async () => {
    const { id, body } = await c.account();
    const max = config.loginMaxFailedAttempts;
    assert.ok(max > 1 && max <= 20, "test assumes a small attempt limit");

    // Parallel guesses must not all slip under the limit while argon2 runs.
    const guesses = await Promise.all(
      Array.from({ length: max * 3 }, (_, i) => attempt(c.url, { ...body, password: `wrong-${i}` })),
    );
    assert.ok(guesses.every((s) => s === 401));
    const counted = await pool.query<{ failed_login_count: number }>(
      `SELECT failed_login_count FROM ${c.table} WHERE id = $1`,
      [id],
    );
    assert.equal(counted.rows[0]!.failed_login_count, max, "more password checks ran than the limit allows");

    // Locked: even the right password is refused, with the generic error.
    const locked = await app.inject({ method: "POST", url: c.url, payload: { ...body, password: PASSWORD } });
    assert.equal(locked.statusCode, 401, "correct password accepted on a locked account");
    assert.equal(locked.json().error, "invalid_credentials");

    // Once the lock expires the right password works and clears the count.
    await pool.query(`UPDATE ${c.table} SET locked_until = now() - interval '1 second' WHERE id = $1`, [id]);
    assert.equal(await attempt(c.url, { ...body, password: PASSWORD }), 200);
    const reset = await pool.query<{ failed_login_count: number; locked_until: Date | null }>(
      `SELECT failed_login_count, locked_until FROM ${c.table} WHERE id = $1`,
      [id],
    );
    assert.deepEqual(reset.rows[0], { failed_login_count: 0, locked_until: null });
  });
}

test("parallel otp verifies with the right code yield exactly one live session", async () => {
  const { merchantId, email } = await signup("otp-parallel");
  // A double-submitted verify form. Each round is a fresh login.
  for (let round = 0; round < 5; round += 1) {
    const { cookie, code } = await login(merchantId, email);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie }, payload: { code } }),
      ),
    );
    const ok = results.filter((r) => r.statusCode === 200);
    assert.equal(
      ok.length,
      1,
      `round ${round}: expected one 200, got ${results.map((r) => `${r.statusCode} ${r.json().error ?? ""}`).join(", ")}`,
    );
    const authed = parseCookie(ok[0]!.headers["set-cookie"]);
    const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: authed } });
    assert.equal(me.statusCode, 200, `round ${round}: the cookie from the successful verify does not authenticate`);
  }
});
