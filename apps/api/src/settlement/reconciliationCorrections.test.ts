/**
 * Reconciliation: a journaled correction (CSV import, journaled balance
 * adjustment, admin credit) moves merchant_payable with no transaction. Until
 * a close claims it (settlement_batch_corrections, 0113) it is pending; once
 * claimed, the claiming batch's net carries it. Either way the period must
 * explain to zero. Route-level, real Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { toFils } from "@filspay/money";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { postLedgerAdjustment } from "../admin/ledgerAdjustments.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("reconciliationCorrections.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Recon Correction Test ${randomUUID()}`],
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

async function adjust(merchantId: string, amountFils: number): Promise<string> {
  const client = await pool.connect();
  try {
    return (await postLedgerAdjustment(client, merchantId, toFils(amountFils, { allowNegative: true }), "CSV adjustment import"))!;
  } finally {
    client.release();
  }
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
  return res.json() as { gapFils: number; explained: boolean; pendingUnbatchedFils: number; ledgerMerchantPayableNetFils: number };
}

test("an unclaimed journaled adjustment is pending, so the period explains to zero", async () => {
  const { merchantId, rawKey } = await merchant();
  await adjust(merchantId, 4_755);
  await adjust(merchantId, -1_000);

  const report = await reconcile(rawKey);
  assert.equal(report.ledgerMerchantPayableNetFils, 3_755, JSON.stringify(report));
  assert.equal(report.pendingUnbatchedFils, 3_755, JSON.stringify(report));
  assert.equal(report.gapFils, 0, JSON.stringify(report));
  assert.equal(report.explained, true);
});

test("a claimed adjustment counts once, through the batch that settled it", async () => {
  const { merchantId, rawKey } = await merchant();
  const group = await adjust(merchantId, 4_750);
  const batch = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, net_payout_fils, closed_at)
     VALUES ($1, $2, 'closed', 4750, now()) RETURNING id`,
    [merchantId, todayBahrain()],
  );
  await pool.query(
    `INSERT INTO settlement_batch_corrections (entry_group_id, settlement_batch_id, merchant_id, net_fils)
     VALUES ($1, $2, $3, 4750)`,
    [group, batch.rows[0]!.id, merchantId],
  );

  const report = await reconcile(rawKey);
  assert.equal(report.pendingUnbatchedFils, 0, JSON.stringify(report));
  assert.equal(report.gapFils, 0, JSON.stringify(report));
  assert.equal(report.explained, true);
});

test("a non-correction unbatched posting (no contra leg) is not treated as pending", async () => {
  const { merchantId, rawKey } = await merchant();
  // e.g. the pre-fix March sweep's scheme_rounding_residue group: never paid
  // out by a close, so it must still show as an unexplained gap.
  const g = randomUUID();
  await pool.query(
    `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES ($1, $2, 'scheme_rounding_residue', 'debit', 7, now(), 'sweep'),
            ($1, $2, 'merchant_payable', 'credit', 7, now(), 'sweep')`,
    [g, merchantId],
  );

  const report = await reconcile(rawKey);
  assert.equal(report.pendingUnbatchedFils, 0, JSON.stringify(report));
  assert.equal(report.gapFils, 7, JSON.stringify(report));
  assert.equal(report.explained, false);
});
