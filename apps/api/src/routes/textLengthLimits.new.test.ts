/**
 * Regression: free-text fields had no upper bound. A fuzz run stored 10k and
 * 100k-character payment-link references, descriptions and refund reasons
 * (every column behind them is TEXT). Each field now has a cap: one
 * character over is the route's usual 400, exactly at the cap is accepted.
 * Lone UTF-16 surrogates, which pg silently rewrites to U+FFFD, are a 400
 * too. Requires DATABASE_URL (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";
import { hashPassword } from "../adminAuth/passwords.js";
import { TEXT_LIMITS } from "../lib/requestParams.js";
import { containsLoneSurrogate } from "../plugins/rejectNul.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("textLengthLimits.new.test.ts requires DATABASE_URL (run `npm run migrate` first)");
}
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  INTERNAL_API_TOKEN: "test-internal-token",
  SETTLEMENT_INTERNAL_TOKEN: "test-settlement-token",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const ADMIN_PASSWORD = "admin-test-password-9000!";
let adminPasswordHash: string | null = null;

function text(length: number): string {
  return "x".repeat(length);
}

type Res = { statusCode: number; body: string; json: () => unknown };

function assertRejected(res: Res, code: string, field: string, label: string): void {
  assert.equal(res.statusCode, 400, `${label}: ${res.body}`);
  const body = res.json() as { error: string; message?: string };
  assert.equal(body.error, code, `${label}: ${res.body}`);
  assert.match(body.message ?? "", new RegExp(`${field} must be at most \\d+ characters`), `${label}: ${res.body}`);
}

function assertAccepted(res: Res, label: string): void {
  assert.ok(res.statusCode >= 200 && res.statusCode < 300, `${label}: ${res.statusCode} ${res.body}`);
}

async function merchant() {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
    `Length Caps ${randomUUID()}`,
  ]);
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `o-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  await pool.query(
    `INSERT INTO merchant_business_profiles
       (merchant_id, legal_name, registration_number, business_type, contact_email, contact_phone, address_line1, city)
     VALUES ($1, 'Caps W.L.L.', 'CR-1', 'llc', 'a@example.test', '+97317000000', 'Road 1', 'Manama')
     ON CONFLICT (merchant_id) DO NOTHING`,
    [merchantId],
  );
  const key = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "caps" });
  const raw = randomToken(32);
  await pool.query(
    `INSERT INTO sessions (merchant_user_id, token_hash, authenticated, expires_at) VALUES ($1, $2, true, now() + interval '1 hour')`,
    [u.rows[0]!.id, sha256Hex(raw)],
  );
  return {
    merchantId,
    apiKey: { authorization: `Bearer ${key.rawKey}` },
    session: { cookie: `${config.cookieName}=${raw}` },
  };
}

function parseCookie(setCookieHeader: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const header of headers) {
    if (header && header.startsWith(`${name}=`)) return header.split(";")[0] as string;
  }
  throw new Error(`expected a Set-Cookie header for ${name}`);
}

async function signedInAdmin(role: "finance" | "super_admin"): Promise<string> {
  adminPasswordHash ??= await hashPassword(ADMIN_PASSWORD, config);
  const email = `caps-${randomUUID()}@admin.test`;
  await pool.query(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, $3, $4)`,
    [email, adminPasswordHash, `Caps ${role}`, role],
  );
  const login = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password: ADMIN_PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = parseCookie(login.headers["set-cookie"], config.adminCookieName);
  const verify = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie },
    payload: { code: (login.json() as { devOtpCode?: string }).devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return parseCookie(verify.headers["set-cookie"], config.adminCookieName);
}

async function capturedTransaction(apiKey: Record<string, string>): Promise<string> {
  const auth = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { ...apiKey, "idempotency-key": randomUUID() },
    payload: { amountFils: 10_000, card: VALID_CARD },
  });
  assert.equal(auth.statusCode, 201, auth.body);
  const id = (auth.json() as { id: string }).id;
  const cap = await app.inject({
    method: "POST",
    url: `/v1/transactions/${id}/capture`,
    headers: { ...apiKey, "idempotency-key": randomUUID() },
    payload: {},
  });
  assert.equal(cap.statusCode, 200, cap.body);
  return id;
}

const expiresAt = () => new Date(Date.now() + 86_400_000).toISOString();

test("the caps are the documented values", () => {
  assert.equal(TEXT_LIMITS.reference, 128);
  assert.equal(TEXT_LIMITS.description, 500);
  assert.equal(TEXT_LIMITS.reason, 1000);
  assert.equal(TEXT_LIMITS.notes, 1000);
  assert.equal(TEXT_LIMITS.url, 2048);
});

test("payment link reference and description: over the cap is 400, at the cap is 201", async () => {
  const m = await merchant();
  const url = `/v1/merchants/${m.merchantId}/payment-links`;
  for (const [field, max] of [["reference", TEXT_LIMITS.reference], ["description", TEXT_LIMITS.description]] as const) {
    for (const length of [max + 1, 100_000]) {
      const res = await app.inject({ method: "POST", url, headers: m.apiKey, payload: { amountFils: 5_000, expiresAt: expiresAt(), [field]: text(length) } });
      assertRejected(res, "invalid_request", field, `link ${field} ${length}`);
    }
    const ok = await app.inject({ method: "POST", url, headers: m.apiKey, payload: { amountFils: 5_000, expiresAt: expiresAt(), [field]: text(max) } });
    assertAccepted(ok, `link ${field} at cap`);
  }
  const stored = await pool.query(`SELECT 1 FROM payment_links WHERE merchant_id = $1`, [m.merchantId]);
  assert.equal(stored.rows.length, 2, "only the two at-cap links were stored");
});

test("authorize reference: over the cap is 400 before the acquirer, at the cap is 201", async () => {
  const m = await merchant();
  const over = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { ...m.apiKey, "idempotency-key": randomUUID() },
    payload: { amountFils: 1_000, card: VALID_CARD, reference: text(10_000) },
  });
  assertRejected(over, "invalid_request", "reference", "authorize reference");
  const none = await pool.query(`SELECT 1 FROM transactions WHERE merchant_id = $1`, [m.merchantId]);
  assert.equal(none.rows.length, 0, "no transaction for the rejected request");

  const ok = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { ...m.apiKey, "idempotency-key": randomUUID() },
    payload: { amountFils: 1_000, card: VALID_CARD, reference: text(TEXT_LIMITS.reference) },
  });
  assert.equal(ok.statusCode, 201, ok.body);
});

test("refund reason: over the cap is 400 on both refund routes, at the cap is accepted", async () => {
  const m = await merchant();
  const txId = await capturedTransaction(m.apiKey);
  for (const url of ["/v1/refunds", `/v1/merchants/${m.merchantId}/refunds`]) {
    const res = await app.inject({
      method: "POST",
      url,
      headers: { ...m.apiKey, "idempotency-key": randomUUID() },
      payload: { transactionId: txId, amountFils: 1_000, reason: text(TEXT_LIMITS.reason + 1) },
    });
    assertRejected(res, "invalid_request", "reason", `refund reason ${url}`);
  }
  const refunds = await pool.query(`SELECT 1 FROM refunds WHERE transaction_id = $1`, [txId]);
  assert.equal(refunds.rows.length, 0, "no refund for the rejected requests");

  const ok = await app.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: { ...m.apiKey, "idempotency-key": randomUUID() },
    payload: { transactionId: txId, amountFils: 1_000, reason: text(TEXT_LIMITS.reason) },
  });
  assertAccepted(ok, "refund reason at cap");
});

test("webhook url: over 2048 characters is 400 invalid_url on create and update, at the cap is accepted", async () => {
  const m = await merchant();
  const base = "https://example.com/";
  const atCap = base + text(TEXT_LIMITS.url - base.length);
  const over = await app.inject({
    method: "POST",
    url: `/v1/merchants/${m.merchantId}/webhook-endpoints`,
    headers: m.session,
    payload: { url: atCap + "x" },
  });
  assertRejected(over, "invalid_url", "url", "webhook create");

  const created = await app.inject({
    method: "POST",
    url: `/v1/merchants/${m.merchantId}/webhook-endpoints`,
    headers: m.session,
    payload: { url: atCap },
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = (created.json() as { id: string }).id;

  const patch = await app.inject({
    method: "PATCH",
    url: `/v1/merchants/${m.merchantId}/webhook-endpoints/${id}`,
    headers: m.session,
    payload: { url: base + text(100_000) },
  });
  assertRejected(patch, "invalid_url", "url", "webhook update");
});

test("business profile text: over the cap is 400 on PATCH and signup, at the cap is accepted", async () => {
  const m = await merchant();
  const url = `/v1/merchants/${m.merchantId}/business-profile`;
  const fields: Array<[string, number]> = [
    ["legalName", TEXT_LIMITS.legalName],
    ["registrationNumber", TEXT_LIMITS.registrationNumber],
    ["contactPhone", TEXT_LIMITS.contactPhone],
    ["addressLine1", TEXT_LIMITS.addressLine],
    ["addressLine2", TEXT_LIMITS.addressLine],
    ["city", TEXT_LIMITS.city],
    ["postalCode", TEXT_LIMITS.postalCode],
  ];
  for (const [field, max] of fields) {
    const res = await app.inject({ method: "PATCH", url, headers: m.session, payload: { [field]: text(max + 1) } });
    assertRejected(res, "invalid_request", field, `profile ${field}`);
    const ok = await app.inject({ method: "PATCH", url, headers: m.session, payload: { [field]: text(max) } });
    assert.equal(ok.statusCode, 200, `profile ${field} at cap: ${ok.body}`);
  }
  const email = await app.inject({ method: "PATCH", url, headers: m.session, payload: { contactEmail: `${text(TEXT_LIMITS.contactEmail)}@x.test` } });
  assertRejected(email, "invalid_request", "contactEmail", "profile contactEmail");

  const profile = {
    legalName: "Caps Trading W.L.L.",
    registrationNumber: "CR-1",
    businessType: "llc",
    contactEmail: "a@example.test",
    contactPhone: "+97317000000",
    addressLine1: "Road 1",
    city: "Manama",
  };
  const signup = (businessProfile: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/v1/merchants",
      payload: { businessProfile, owner: { email: `s-${randomUUID()}@example.test`, password: "Passw0rd!Passw0rd" } },
    });
  assertRejected(await signup({ ...profile, legalName: text(TEXT_LIMITS.legalName + 1) }), "invalid_request", "legalName", "signup legalName");
  const ok = await signup({ ...profile, legalName: text(TEXT_LIMITS.legalName) });
  assert.equal(ok.statusCode, 201, ok.body);
});

test("api key label and saved filter name: over 100 is 400, at 100 is 201", async () => {
  const m = await merchant();
  const keyUrl = `/v1/merchants/${m.merchantId}/api-keys`;
  assertRejected(await app.inject({ method: "POST", url: keyUrl, headers: m.session, payload: { label: text(TEXT_LIMITS.label + 1) } }), "invalid_request", "label", "api key label");
  assertAccepted(await app.inject({ method: "POST", url: keyUrl, headers: m.session, payload: { label: text(TEXT_LIMITS.label) } }), "api key label at cap");

  const filterUrl = "/v1/reporting/saved-filters";
  const filter = { status: "captured" };
  assertRejected(await app.inject({ method: "POST", url: filterUrl, headers: m.apiKey, payload: { name: text(TEXT_LIMITS.label + 1), filter } }), "invalid_request", "name", "saved filter name");
  assertAccepted(await app.inject({ method: "POST", url: filterUrl, headers: m.apiKey, payload: { name: text(TEXT_LIMITS.label), filter } }), "saved filter name at cap");
});

test("admin balance adjustment reason: over the cap is 400, at the cap is 200", async () => {
  const cookie = await signedInAdmin("finance");
  const m = await merchant();
  await pool.query(`INSERT INTO merchant_balances (merchant_id, cached_payable_fils) VALUES ($1, 100000) ON CONFLICT (merchant_id) DO NOTHING`, [m.merchantId]);
  const url = `/v1/admin/merchants/${m.merchantId}/balance-adjustments`;
  assertRejected(
    await app.inject({ method: "POST", url, headers: { cookie }, payload: { deltaFils: 1_000, reason: text(TEXT_LIMITS.reason + 1) } }),
    "invalid_request",
    "reason",
    "balance adjustment",
  );
  const ok = await app.inject({ method: "POST", url, headers: { cookie }, payload: { deltaFils: 1_000, reason: text(TEXT_LIMITS.reason) } });
  assert.equal(ok.statusCode, 200, ok.body);
});

test("admin credit reject reason: over the cap or not a string is 400, at the cap is 200", async () => {
  const maker = await signedInAdmin("finance");
  const checker = await signedInAdmin("super_admin");
  const m = await merchant();
  const issued = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${m.merchantId}/credits`,
    headers: { cookie: maker },
    payload: { reasonCode: "goodwill", effectiveDate: new Date().toISOString().slice(0, 10), baseAmountFils: 120_000 },
  });
  assert.equal(issued.statusCode, 201, issued.body);
  const credit = issued.json() as { id: string; status: string };
  assert.equal(credit.status, "pending_approval");

  const url = `/v1/admin/credits/${credit.id}/reject`;
  assertRejected(await app.inject({ method: "POST", url, headers: { cookie: checker }, payload: { reason: text(TEXT_LIMITS.reason + 1) } }), "invalid_request", "reason", "credit reject");
  const notString = await app.inject({ method: "POST", url, headers: { cookie: checker }, payload: { reason: ["x"] } });
  assert.equal(notString.statusCode, 400, notString.body);
  const ok = await app.inject({ method: "POST", url, headers: { cookie: checker }, payload: { reason: text(TEXT_LIMITS.reason) } });
  assert.equal(ok.statusCode, 200, ok.body);
});

test("admin KYC review notes and bulk-approve notes: over the cap is 400, at the cap is accepted", async () => {
  const cookie = await signedInAdmin("finance");
  const reviewed = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [`Caps KYC ${randomUUID()}`]);
  const reviewUrl = `/v1/admin/merchants/${reviewed.rows[0]!.id}/kyc-reviews`;
  assertRejected(
    await app.inject({ method: "POST", url: reviewUrl, headers: { cookie }, payload: { outcome: "rejected", notes: text(TEXT_LIMITS.notes + 1) } }),
    "invalid_request",
    "notes",
    "kyc review notes",
  );
  assertAccepted(
    await app.inject({ method: "POST", url: reviewUrl, headers: { cookie }, payload: { outcome: "rejected", notes: text(TEXT_LIMITS.notes) } }),
    "kyc review notes at cap",
  );

  const bulk = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [`Caps Bulk ${randomUUID()}`]);
  const bulkUrl = "/v1/admin/merchants/bulk-approve";
  assertRejected(
    await app.inject({ method: "POST", url: bulkUrl, headers: { cookie }, payload: { merchantIds: [bulk.rows[0]!.id], notes: text(TEXT_LIMITS.notes + 1) } }),
    "invalid_request",
    "notes",
    "bulk approve notes",
  );
  assertAccepted(
    await app.inject({ method: "POST", url: bulkUrl, headers: { cookie }, payload: { merchantIds: [bulk.rows[0]!.id], notes: text(TEXT_LIMITS.notes) } }),
    "bulk approve notes at cap",
  );
});

test("adjustment CSV reason: over the cap is 400 invalid_csv_row, at the cap is 201", async () => {
  const cookie = await signedInAdmin("finance");
  const m = await merchant();
  const csv = (reason: string) => `merchantId,amount,reason\n${m.merchantId},1.25,${reason}\n`;
  const over = await app.inject({
    method: "POST",
    url: "/v1/admin/adjustment-imports",
    headers: { cookie },
    payload: { csvContent: csv(text(TEXT_LIMITS.reason + 1)), originalFilename: "caps.csv" },
  });
  assert.equal(over.statusCode, 400, over.body);
  assert.equal((over.json() as { error: string }).error, "invalid_csv_row");
  const ok = await app.inject({
    method: "POST",
    url: "/v1/admin/adjustment-imports",
    headers: { cookie },
    payload: { csvContent: csv(text(TEXT_LIMITS.reason)), originalFilename: "caps.csv" },
  });
  assert.equal(ok.statusCode, 201, ok.body);
});

test("a lone UTF-16 surrogate in any body field is a 400; a valid pair is accepted", async () => {
  assert.equal(containsLoneSurrogate({ a: ["ok", "\uD83D"] }), true);
  assert.equal(containsLoneSurrogate({ a: "\uDE00x" }), true);
  assert.equal(containsLoneSurrogate({ "k\uD800": 1 }), true);
  assert.equal(containsLoneSurrogate({ a: "pay 😀", b: 1, c: null }), false);

  const m = await merchant();
  const url = `/v1/merchants/${m.merchantId}/payment-links`;
  // JSON escapes, as a client would send them on the wire.
  const lone = await app.inject({
    method: "POST",
    url,
    headers: { ...m.apiKey, "content-type": "application/json" },
    payload: `{"amountFils":5000,"expiresAt":"${expiresAt()}","reference":"a\\ud800b"}`,
  });
  assert.equal(lone.statusCode, 400, lone.body);
  assert.equal((lone.json() as { error: string }).error, "invalid_request");

  const pair = await app.inject({
    method: "POST",
    url,
    headers: { ...m.apiKey, "content-type": "application/json" },
    payload: `{"amountFils":5000,"expiresAt":"${expiresAt()}","reference":"a\\ud83d\\ude00b"}`,
  });
  assert.equal(pair.statusCode, 201, pair.body);
});
