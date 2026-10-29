/**
 * Reconciliation: pendingUnbatchedFils must use the fee the capture path
 * actually charged (effective-dated schedule, integer half-even rounding,
 * negotiated discount adjustment), or a fully explained period reports a
 * gap. Route-level, real Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("reconciliationPending.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function merchant(mdrBps: number, discountBps = 0) {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, negotiated_discount_bps) VALUES ($1, $2, $3) RETURNING id`,
    [`Recon Pending Test ${randomUUID()}`, mdrBps, discountBps],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const rawKey = (await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "t" })).rawKey;
  return { merchantId, rawKey };
}

async function authorizeAndCapture(rawKey: string, amountFils: number): Promise<void> {
  const auth = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils, card: VALID_CARD },
  });
  assert.equal(auth.statusCode, 201, auth.body);
  const cap = await app.inject({
    method: "POST",
    url: `/v1/transactions/${auth.json().id}/capture`,
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: {},
  });
  assert.equal(cap.statusCode, 200, cap.body);
}

function todayBahrain(): string {
  return new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
}

function nextDay(d: string): string {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
}

async function reconcile(rawKey: string) {
  const from = todayBahrain();
  const res = await app.inject({
    method: "GET",
    url: `/v1/settlement/reconciliation?from=${from}&to=${nextDay(from)}`,
    headers: { authorization: `Bearer ${rawKey}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { gapFils: number; explained: boolean; pendingUnbatchedFils: number };
}

test("a half-fils fee (2.5) is rounded half-even like capture, so the period still explains", async () => {
  const { rawKey } = await merchant(250);
  await authorizeAndCapture(rawKey, 100); // 100 * 2.5% = 2.5 fils -> capture charges 2

  const report = await reconcile(rawKey);
  assert.equal(report.gapFils, 0, JSON.stringify(report));
  assert.equal(report.explained, true);
});

test("an effective-dated fee schedule rate (not merchants.mdr_bps) is what pending is netted at", async () => {
  const { merchantId, rawKey } = await merchant(250);
  await pool.query(
    `INSERT INTO fee_schedules (merchant_id, mdr_bps, effective_from) VALUES ($1, 300, now() - interval '1 day')`,
    [merchantId],
  );
  await authorizeAndCapture(rawKey, 10_000);

  const report = await reconcile(rawKey);
  assert.equal(report.gapFils, 0, JSON.stringify(report));
  assert.equal(report.explained, true);
});

test("a negotiated discount is netted exactly as the ledger adjustment posts it", async () => {
  const { rawKey } = await merchant(250, 1_000);
  await authorizeAndCapture(rawKey, 10_100); // fee 252.5 -> 252; discount 10% of 252 = 25.2 -> 25

  const report = await reconcile(rawKey);
  assert.equal(report.gapFils, 0, JSON.stringify(report));
  assert.equal(report.explained, true);
});
