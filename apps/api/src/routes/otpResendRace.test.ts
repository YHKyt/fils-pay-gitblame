/**
 * h2 lane report: /otp/resend read the current challenge (30 s throttle and
 * the attempt_count to carry over) outside its transaction. Parallel
 * resends all passed the throttle and each issued a new challenge. The
 * read now happens under a row lock inside the transaction, so exactly one
 * resend wins and the rest are throttled. Real Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool, type PoolClient } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("otpResendRace.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
// Forces the interleaving the race needs: each resend's transaction waits
// at its "retire the old challenge" UPDATE until two have reached it (or
// 500 ms, when the fix makes the second stop before it).
let arrived = 0;
let releaseBoth!: () => void;
const bothArrived = new Promise<void>((resolve) => (releaseBoth = resolve));
class RacingPool extends Pool {
  override async connect(): Promise<PoolClient>;
  override async connect(...args: unknown[]): Promise<unknown> {
    if (args.length > 0) return (super.connect as (...a: unknown[]) => unknown)(...args);
    const client = await super.connect();
    const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
    (client as unknown as { query: unknown }).query = async (...a: unknown[]) => {
      if (typeof a[0] === "string" && a[0].startsWith("UPDATE otp_challenges SET consumed_at = now() WHERE id = $1")) {
        arrived += 1;
        if (arrived === 2) releaseBoth();
        await Promise.race([bothArrived, new Promise((resolve) => setTimeout(resolve, 500))]);
      }
      return query(...a);
    };
    return client;
  }
}
const pool = new RacingPool({ connectionString: databaseUrl, max: 8 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

test("parallel OTP resends issue one new challenge; the rest are throttled", async () => {
  const email = `resendrace-${randomUUID()}@example.test`;
  const password = "resend-race-password-456";
  const signup = await app.inject({
    method: "POST",
    url: "/v1/merchants",
    payload: {
      businessProfile: {
        legalName: "Resend Race Co",
        registrationNumber: `RC-${randomUUID().slice(0, 8)}`,
        businessType: "llc",
        contactEmail: `contact-${randomUUID()}@example.test`,
        contactPhone: "+97300000000",
        addressLine1: "1 Test Street",
        city: "Manama",
      },
      owner: { email, password },
    },
  });
  assert.equal(signup.statusCode, 201, signup.body);
  const merchantId = (signup.json() as { merchantId?: string; merchant?: { id: string }; id?: string }).merchantId
    ?? (signup.json() as { merchant?: { id: string } }).merchant?.id
    ?? (signup.json() as { id: string }).id;

  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email, password } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;

  await pool.query(
    `UPDATE otp_challenges SET created_at = now() - interval '1 minute'
      WHERE id = (SELECT otp_challenge_id FROM sessions WHERE token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex'))`,
    [cookie.split("=")[1]],
  );

  const results = await Promise.all(
    Array.from({ length: 2 }, () => app.inject({ method: "POST", url: "/v1/auth/otp/resend", headers: { cookie } })),
  );
  const codes = results.map((r) => r.statusCode).sort();
  assert.deepEqual(codes, [200, 429], `resend statuses: ${codes.join(",")}`);

  const user = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM otp_challenges c JOIN merchant_users u ON u.id = c.merchant_user_id WHERE u.email = $1`,
    [email],
  );
  assert.equal(user.rows[0]!.n, 2, "the login challenge plus exactly one resend");
});
