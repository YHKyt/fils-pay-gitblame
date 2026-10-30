/**
 * AR1: admin login had no way to resend the one-time code. POST
 * /v1/admin/auth/otp/resend mirrors the merchant /v1/auth/otp/resend:
 * pending session required, 30 s throttle (429 resend_too_soon), old
 * challenge consumed, guess budget carried over, code exposed only under
 * the dev flag that production forces off. Real Postgres.
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
  throw new Error("adminOtpResend.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const baseEnv = {
  DATABASE_URL: databaseUrl,
  OTP_DEV_EXPOSE: "true",
  SETTLEMENT_INTERNAL_TOKEN: "test-settlement-token",
  ACQUIRER_CALLBACK_SIGNING_SECRET: "test-acquirer-callback-secret",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
};
const config = loadConfig({ ...baseEnv, NODE_ENV: "test" });

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const PASSWORD = "admin-resend-password-9000!";

function parseCookie(setCookie: string | string[] | undefined, name: string): string {
  const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const c of all) {
    const first = c.split(";")[0]!;
    if (first.startsWith(`${name}=`)) return first;
  }
  throw new Error(`expected a Set-Cookie header for ${name}`);
}

async function createAdmin(): Promise<string> {
  const email = `resend-${randomUUID()}@admin.test`;
  await pool.query(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, 'Resend Test', 'support')`,
    [email, await hashPassword(PASSWORD, config)],
  );
  return email;
}

async function login(target: ReturnType<typeof buildApp>, cookieName: string, email: string) {
  const res = await target.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password: PASSWORD } });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { devOtpCode?: string };
  return { cookie: parseCookie(res.headers["set-cookie"], cookieName), code: body.devOtpCode };
}

/** Moves the session's current challenge 31 s into the past so the throttle passes. */
async function ageCurrentChallenge(email: string): Promise<void> {
  await pool.query(
    `UPDATE admin_otp_challenges SET created_at = now() - interval '31 seconds'
      WHERE id IN (SELECT s.otp_challenge_id FROM admin_sessions s JOIN admin_users u ON u.id = s.admin_user_id
                    WHERE u.email = $1 AND s.authenticated = false)`,
    [email],
  );
}

test("resend issues a new code; the old code no longer verifies, the new one does", async () => {
  const email = await createAdmin();
  const { cookie, code: oldCode } = await login(app, config.adminCookieName, email);
  assert.ok(oldCode);
  await ageCurrentChallenge(email);

  const resend = await app.inject({ method: "POST", url: "/v1/admin/auth/otp/resend", headers: { cookie } });
  assert.equal(resend.statusCode, 200, resend.body);
  const body = resend.json() as { otpRequired: boolean; otpExpiresAt: string; devOtpCode?: string };
  assert.equal(body.otpRequired, true);
  assert.ok(new Date(body.otpExpiresAt).getTime() > Date.now());
  assert.ok(body.devOtpCode);

  if (oldCode !== body.devOtpCode) {
    const stale = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/otp/verify",
      headers: { cookie },
      payload: { code: oldCode },
    });
    // Same status the merchant verify returns for a superseded challenge.
    assert.equal(stale.statusCode, 401, stale.body);
    assert.equal((stale.json() as { error: string }).error, "invalid_code");
  }

  const fresh = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie },
    payload: { code: body.devOtpCode },
  });
  assert.equal(fresh.statusCode, 200, fresh.body);
  assert.equal((fresh.json() as { authenticated: boolean }).authenticated, true);

  // The pending cookie was rotated away at promotion; resend on it is 401.
  const after = await app.inject({ method: "POST", url: "/v1/admin/auth/otp/resend", headers: { cookie } });
  assert.equal(after.statusCode, 401, after.body);
  assert.equal((after.json() as { error: string }).error, "no_pending_session");

  // So is resend on the authenticated cookie.
  const authed = parseCookie(fresh.headers["set-cookie"], config.adminCookieName);
  const onAuthed = await app.inject({ method: "POST", url: "/v1/admin/auth/otp/resend", headers: { cookie: authed } });
  assert.equal(onAuthed.statusCode, 401, onAuthed.body);
});

test("resend within 30 s is refused with 429 resend_too_soon", async () => {
  const email = await createAdmin();
  const { cookie } = await login(app, config.adminCookieName, email);
  const res = await app.inject({ method: "POST", url: "/v1/admin/auth/otp/resend", headers: { cookie } });
  assert.equal(res.statusCode, 429, res.body);
  assert.equal((res.json() as { error: string }).error, "resend_too_soon");
});

test("resend never resets the guess budget", async () => {
  const email = await createAdmin();
  const { cookie } = await login(app, config.adminCookieName, email);
  const wrong = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie },
    payload: { code: "000000x" },
  });
  assert.equal(wrong.statusCode, 401, wrong.body);
  await ageCurrentChallenge(email);
  const res = await app.inject({ method: "POST", url: "/v1/admin/auth/otp/resend", headers: { cookie } });
  assert.equal(res.statusCode, 200, res.body);
  const row = await pool.query<{ attempt_count: number }>(
    `SELECT c.attempt_count FROM admin_otp_challenges c JOIN admin_sessions s ON s.otp_challenge_id = c.id
       JOIN admin_users u ON u.id = s.admin_user_id WHERE u.email = $1 AND s.authenticated = false`,
    [email],
  );
  assert.equal(row.rows[0]?.attempt_count, 1);
});

test("resend without a session is 401 no_pending_session", async () => {
  const res = await app.inject({ method: "POST", url: "/v1/admin/auth/otp/resend" });
  assert.equal(res.statusCode, 401, res.body);
  assert.equal((res.json() as { error: string }).error, "no_pending_session");
  const bogus = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/resend",
    headers: { cookie: `${config.adminCookieName}=not-a-real-token` },
  });
  assert.equal(bogus.statusCode, 401, bogus.body);
});

test("production never returns the resent code, even with OTP_DEV_EXPOSE=true", async () => {
  const prodConfig = loadConfig({ ...baseEnv, NODE_ENV: "production" });
  assert.equal(prodConfig.otpDevExpose, false);
  const prodApp = buildApp(prodConfig, pool);
  try {
    const email = await createAdmin();
    const { cookie, code } = await login(prodApp, prodConfig.adminCookieName, email);
    assert.equal(code, undefined);
    await ageCurrentChallenge(email);
    const res = await prodApp.inject({ method: "POST", url: "/v1/admin/auth/otp/resend", headers: { cookie } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((res.json() as { devOtpCode?: string }).devOtpCode, undefined);
    assert.ok(!res.body.includes("devOtpCode"));
  } finally {
    await prodApp.close();
  }
});
