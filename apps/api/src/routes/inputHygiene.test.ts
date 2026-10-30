/**
 * Regression: request text that Postgres cannot store or parse used to
 * answer 500. A NUL character in any JSON body field, query value or path
 * parameter (22021 / 22P05), a client timestamp whose offset Postgres
 * rejects (22009), and signup values outside the business_type CHECK or the
 * CHAR(2) country column. Each must be a 400. Requires DATABASE_URL.
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
import { containsNul } from "../plugins/rejectNul.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("inputHygiene.test.ts requires DATABASE_URL (run `npm run migrate` first)");
}
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
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

async function merchant() {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
    `Input Hygiene ${randomUUID()}`,
  ]);
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `o-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const key = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "hygiene" });
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

const SIGNUP_PROFILE = {
  legalName: "Hygiene Trading W.L.L.",
  registrationNumber: "CR-1",
  businessType: "llc",
  contactEmail: "a@example.test",
  contactPhone: "+97317000000",
  addressLine1: "Road 1",
  city: "Manama",
};

function signup(businessProfile: Record<string, unknown>, email = `s-${randomUUID()}@example.test`) {
  return app.inject({
    method: "POST",
    url: "/v1/merchants",
    payload: { businessProfile, owner: { email, password: "Passw0rd!Passw0rd" } },
  });
}

function assert400(res: { statusCode: number; body: string }, label: string) {
  assert.equal(res.statusCode, 400, `${label}: ${res.body}`);
}

test("containsNul finds a NUL in nested strings and keys, and nothing else", () => {
  assert.equal(containsNul({ a: [{ b: "x\u0000" }] }), true);
  assert.equal(containsNul({ "k\u0000": 1 }), true);
  assert.equal(containsNul({ a: ["x", 1, null, true], b: { c: "y" } }), false);
  assert.equal(containsNul(undefined), false);
});

test("a NUL in a JSON body field is a 400 on every text surface", async () => {
  const m = await merchant();
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  const cases: Array<[string, { method: "POST" | "PATCH"; url: string; headers: Record<string, string>; payload: object }]> = [
    ["link reference", { method: "POST", url: `/v1/merchants/${m.merchantId}/payment-links`, headers: m.apiKey, payload: { amountFils: 5_000, expiresAt, reference: "a\u0000b" } }],
    ["link description", { method: "POST", url: `/v1/merchants/${m.merchantId}/payment-links`, headers: m.apiKey, payload: { amountFils: 5_000, expiresAt, description: "a\u0000b" } }],
    ["api key label", { method: "POST", url: `/v1/merchants/${m.merchantId}/api-keys`, headers: m.session, payload: { label: "a\u0000b" } }],
    ["business profile", { method: "PATCH", url: `/v1/merchants/${m.merchantId}/business-profile`, headers: m.session, payload: { legalName: "a\u0000b" } }],
    ["webhook url", { method: "POST", url: `/v1/merchants/${m.merchantId}/webhook-endpoints`, headers: m.session, payload: { url: "https://example.com/a\u0000b" } }],
    ["saved filter name", { method: "POST", url: "/v1/reporting/saved-filters", headers: m.apiKey, payload: { name: "a\u0000b", filter: { status: "captured" } } }],
    ["saved filter body", { method: "POST", url: "/v1/reporting/saved-filters", headers: m.apiKey, payload: { name: "ok", filter: { status: "a\u0000b" } } }],
  ];
  for (const [label, req] of cases) {
    assert400(await app.inject(req), label);
  }
  assert400(await signup({ ...SIGNUP_PROFILE, legalName: "a\u0000b" }), "signup legalName");
  assert400(await signup(SIGNUP_PROFILE, "o\u0000@example.test"), "signup email");

  const links = await pool.query(`SELECT 1 FROM payment_links WHERE merchant_id = $1`, [m.merchantId]);
  assert.equal(links.rows.length, 0, "nothing was stored");
});

test("a NUL in a query value or inside the JSON report filter is a 400", async () => {
  const m = await merchant();
  assert400(await app.inject({ method: "GET", url: "/v1/transactions?q=a%00b", headers: m.apiKey }), "transactions q");
  const filter = encodeURIComponent(JSON.stringify({ status: "x\u0000y" }));
  assert400(await app.inject({ method: "GET", url: `/v1/reporting/transactions?filter=${filter}`, headers: m.apiKey }), "report filter");
});

test("a timestamp Postgres cannot place in a time zone is a 400, not a 500", async () => {
  const m = await merchant();
  const filter = encodeURIComponent(JSON.stringify({ from: "+275760-09-13T00:00:00Z" }));
  assert400(await app.inject({ method: "GET", url: `/v1/reporting/transactions?filter=${filter}`, headers: m.apiKey }), "filter year 275760");
  const cursor = Buffer.from(`2026-01-01 00:00:00+99|${randomUUID()}`).toString("base64url");
  assert400(await app.inject({ method: "GET", url: `/v1/reporting/transactions?cursor=${cursor}`, headers: m.apiKey }), "cursor offset +99");
});

test("signup with an unknown businessType or a 3-letter country is a 400; a valid one is 201", async () => {
  const corp = await signup({ ...SIGNUP_PROFILE, businessType: "corp" });
  assert400(corp, "businessType corp");
  const bhr = await signup({ ...SIGNUP_PROFILE, country: "BHR" });
  assert400(bhr, "country BHR");
  const ok = await signup({ ...SIGNUP_PROFILE, country: "BH" });
  assert.equal(ok.statusCode, 201, ok.body);
});
