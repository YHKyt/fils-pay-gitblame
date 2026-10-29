/**
 * Regression tests: PATCH /v1/merchants/:merchantId/business-profile with a
 * key that is not an editable field used to interpolate `undefined` as a
 * column name into the UPDATE -> invalid SQL -> 500. Unknown keys (and a
 * non-object body) must be 400, and must not change the profile.
 *
 * Real, migrated Postgres; requires DATABASE_URL (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("businessProfile.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 3 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

/** A merchant with a business profile and an authenticated owner session. */
async function ownerWithProfile(): Promise<{ merchantId: string; cookie: string }> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Business Profile Test ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  await pool.query(
    `INSERT INTO merchant_business_profiles
       (merchant_id, legal_name, registration_number, business_type, contact_email, contact_phone, address_line1, city)
     VALUES ($1, 'Original Legal Name', 'CR-1', 'llc', 'a@example.test', '+97300000000', 'Road 1', 'Manama')`,
    [merchantId],
  );
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  const rawToken = randomToken(32);
  await pool.query(
    `INSERT INTO sessions (merchant_user_id, token_hash, authenticated, expires_at)
     VALUES ($1, $2, true, now() + interval '1 hour')`,
    [user.rows[0]!.id, sha256Hex(rawToken)],
  );
  return { merchantId, cookie: `${config.cookieName}=${rawToken}` };
}

test("PATCH business-profile with an unknown key is 400, not 500, and changes nothing", async () => {
  const { merchantId, cookie } = await ownerWithProfile();
  const bodies: unknown[] = [
    { legalNmae: "typo" },
    { legalName: "New Name", merchantId: randomUUID() },
    { updatedAt: "2020-01-01" },
    { toString: "x" },
  ];
  for (const payload of bodies) {
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/merchants/${merchantId}/business-profile`,
      headers: { cookie },
      payload: payload as Record<string, unknown>,
    });
    assert.equal(res.statusCode, 400, `${JSON.stringify(payload)} -> ${res.body}`);
    assert.equal(res.json().error, "invalid_request");
  }

  const row = await pool.query<{ legal_name: string }>(
    `SELECT legal_name FROM merchant_business_profiles WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(row.rows[0]!.legal_name, "Original Legal Name");
});

test("PATCH business-profile with a non-object JSON body is 400", async () => {
  const { merchantId, cookie } = await ownerWithProfile();
  const res = await app.inject({
    method: "PATCH",
    url: `/v1/merchants/${merchantId}/business-profile`,
    headers: { cookie, "content-type": "application/json" },
    payload: '["legalName"]',
  });
  assert.equal(res.statusCode, 400, res.body);
});

test("PATCH business-profile with known keys still updates", async () => {
  const { merchantId, cookie } = await ownerWithProfile();
  const res = await app.inject({
    method: "PATCH",
    url: `/v1/merchants/${merchantId}/business-profile`,
    headers: { cookie },
    payload: { legalName: "Renamed WLL", addressLine2: null },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().legalName, "Renamed WLL");
});
