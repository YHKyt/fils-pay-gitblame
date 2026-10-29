/**
 * Regression: "test merchants keep showing up in the real settlement run".
 * The transaction-status recompute tool used to clear merchants.test_mode as
 * a side effect (whenever the merchant had no open authorizations), taking a
 * sandbox merchant live so the daily close settled it. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../adminAuth/passwords.js";

const databaseUrl = process.env.DATABASE_URL;

test("recompute-statuses leaves a sandbox merchant in sandbox", { skip: !databaseUrl }, async () => {
  const config = loadConfig({
    DATABASE_URL: databaseUrl!,
    NODE_ENV: "test",
    OTP_DEV_EXPOSE: "true",
    SETTLEMENT_INTERNAL_TOKEN: "test-settlement-token",
    WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  });
  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  const app = buildApp(config, pool);
  try {
    // finance admin, signed in through the real login + OTP flow
    const password = "admin-test-password-9000!";
    const email = `recompute-${randomUUID()}@admin.test`;
    await pool.query(
      `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, 'Finance', 'finance')`,
      [email, await hashPassword(password, config)],
    );
    const login = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password } });
    assert.equal(login.statusCode, 200, login.body);
    const setCookie = ([] as string[]).concat(login.headers["set-cookie"] ?? []);
    let cookie = setCookie.find((c) => c.startsWith(`${config.adminCookieName}=`))!.split(";")[0]!;
    const verify = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/otp/verify",
      headers: { cookie },
      payload: { code: (login.json() as { devOtpCode?: string }).devOtpCode },
    });
    assert.equal(verify.statusCode, 200, verify.body);
    // OTP verify rotates the admin session token (no session fixation).
    cookie = ([] as string[])
      .concat(verify.headers["set-cookie"] ?? [])
      .find((c) => c.startsWith(`${config.adminCookieName}=`))!
      .split(";")[0]!;

    // sandbox merchant with a settled (not open) transaction: the old code
    // flipped test_mode off exactly in this state
    const m = await pool.query<{ id: string }>(
      `INSERT INTO merchants (display_name, mdr_bps, status, test_mode) VALUES ($1, 250, 'active', true) RETURNING id`,
      [`sandbox ${randomUUID()}`],
    );
    const merchantId = m.rows[0]!.id;
    await pool.query(
      `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
       VALUES ($1, 'captured', 5000, 5000, $2, now())`,
      [merchantId, `acq-${randomUUID()}`],
    );

    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/merchants/${merchantId}/transactions/recompute-statuses`,
      headers: { cookie },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual((res.json() as { flagsUpdated: string[] }).flagsUpdated, []);

    const after = await pool.query<{ test_mode: boolean }>(`SELECT test_mode FROM merchants WHERE id = $1`, [merchantId]);
    assert.equal(after.rows[0]!.test_mode, true, "a status recompute must not take a sandbox merchant live");
  } finally {
    await app.close();
    await pool.end();
  }
});
