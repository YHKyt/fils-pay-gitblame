/**
 * Regression: the single KYC review (POST /v1/admin/merchants/:id/kyc-reviews)
 * decided a merchant in any onboarding status, so a finance admin could reject
 * an already-approved merchant (kyc_passed true -> false) or decide the same
 * merchant twice. The review now refuses a merchant already in a final state
 * (approved/rejected) with 409 merchant_not_under_review and writes nothing,
 * while still allowing a merchant awaiting a decision (submitted after signup,
 * or under_review once documents are uploaded) — the documented happy path a
 * signup -> approve flow depends on.
 *
 * Route level: real Postgres (DATABASE_URL), real admin login.
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
  throw new Error("adminKycReviewStatus.test.ts requires DATABASE_URL (run `npm run migrate` first)");
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

function parseCookie(header: string | string[] | undefined, name: string): string {
  for (const h of Array.isArray(header) ? header : [header]) {
    if (h && h.startsWith(`${name}=`)) return h.split(";")[0] as string;
  }
  throw new Error(`expected a Set-Cookie header for ${name}`);
}

async function signedInFinanceAdmin(): Promise<{ id: string; cookie: string }> {
  const password = "admin-test-password-9000!";
  const email = `kyc-status-${randomUUID()}@admin.test`;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, $2, $3, 'finance') RETURNING id`,
    [email, await hashPassword(password, config), `kyc-status ${randomUUID().slice(0, 8)}`],
  );
  const login = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password } });
  assert.equal(login.statusCode, 200, login.body);
  const verify = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie: parseCookie(login.headers["set-cookie"], config.adminCookieName) },
    payload: { code: (login.json() as { devOtpCode?: string }).devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return { id: inserted.rows[0]!.id, cookie: parseCookie(verify.headers["set-cookie"], config.adminCookieName) };
}

/** A merchant in the given onboarding status. The status is set directly:
 *  this is the starting state under test, not a review. */
async function merchantIn(status: string, kycPassed = status === "approved"): Promise<string> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, onboarding_status, kyc_passed)
     VALUES ($1, 250, $2, $3) RETURNING id`,
    [`KYC status ${status} ${randomUUID()}`, status, kycPassed],
  );
  return inserted.rows[0]!.id;
}

async function stateOf(merchantId: string, adminUserId: string) {
  const merchant = await pool.query<{ onboarding_status: string; kyc_passed: boolean }>(
    `SELECT onboarding_status, kyc_passed FROM merchants WHERE id = $1`,
    [merchantId],
  );
  const reviews = await pool.query<{ outcome: string }>(
    `SELECT outcome FROM merchant_kyc_reviews WHERE merchant_id = $1 ORDER BY reviewed_at`,
    [merchantId],
  );
  const audit = await pool.query(
    `SELECT 1 FROM admin_audit_log WHERE admin_user_id = $1 AND action = 'kyc_review' AND target_id = $2`,
    [adminUserId, merchantId],
  );
  return {
    onboardingStatus: merchant.rows[0]!.onboarding_status,
    kycPassed: merchant.rows[0]!.kyc_passed,
    reviews: reviews.rows.map((r) => r.outcome),
    auditRows: audit.rowCount,
  };
}

function review(cookie: string, merchantId: string, outcome: "approved" | "rejected") {
  return app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/kyc-reviews`,
    headers: { cookie },
    payload: { outcome, notes: `test ${outcome}` },
  });
}

test("a merchant already in a final state cannot be re-decided: 409, nothing written", async () => {
  const finance = await signedInFinanceAdmin();

  for (const status of ["approved", "rejected"]) {
    for (const outcome of ["approved", "rejected"] as const) {
      const merchantId = await merchantIn(status);
      const before = await stateOf(merchantId, finance.id);

      const res = await review(finance.cookie, merchantId, outcome);
      assert.equal(res.statusCode, 409, `${status} -> ${outcome}: ${res.body}`);
      const body = res.json() as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), ["error", "message"]);
      assert.equal(body.error, "merchant_not_under_review");
      assert.match(String(body.message), new RegExp(`'${status}'`));

      assert.deepEqual(await stateOf(merchantId, finance.id), before, `${status} -> ${outcome} changed something`);
    }
  }
});

test("a submitted or under_review merchant can be decided", async () => {
  const finance = await signedInFinanceAdmin();

  for (const status of ["submitted", "under_review"]) {
    const merchantId = await merchantIn(status);
    const res = await review(finance.cookie, merchantId, "approved");
    assert.equal(res.statusCode, 200, `${status}: ${res.body}`);
    assert.deepEqual(res.json(), { onboardingStatus: "approved", kycPassed: true });
    const after = await stateOf(merchantId, finance.id);
    assert.equal(after.onboardingStatus, "approved");
    assert.deepEqual(after.reviews, ["approved"]);
    assert.equal(after.auditRows, 1);
  }
});

test("an under_review merchant is decided once; a second decision is a 409 and changes nothing", async () => {
  const finance = await signedInFinanceAdmin();
  const merchantId = await merchantIn("under_review");

  const first = await review(finance.cookie, merchantId, "approved");
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json(), { onboardingStatus: "approved", kycPassed: true });

  const second = await review(finance.cookie, merchantId, "rejected");
  assert.equal(second.statusCode, 409, second.body);
  assert.equal(second.json().error, "merchant_not_under_review");

  assert.deepEqual(await stateOf(merchantId, finance.id), {
    onboardingStatus: "approved",
    kycPassed: true,
    reviews: ["approved"],
    auditRows: 1,
  });
});

test("two concurrent decisions on one under_review merchant: exactly one wins", async () => {
  const finance = await signedInFinanceAdmin();
  const merchantId = await merchantIn("under_review");

  const results = await Promise.all([
    review(finance.cookie, merchantId, "approved"),
    review(finance.cookie, merchantId, "rejected"),
  ]);
  const codes = results.map((r) => r.statusCode).sort();
  assert.deepEqual(codes, [200, 409], results.map((r) => r.body).join(" | "));

  const winner = results.find((r) => r.statusCode === 200)!.json() as { onboardingStatus: string };
  const after = await stateOf(merchantId, finance.id);
  assert.deepEqual(after.reviews, [winner.onboardingStatus], "one review row, the winner's");
  assert.equal(after.onboardingStatus, winner.onboardingStatus);
  assert.equal(after.auditRows, 1);
});
