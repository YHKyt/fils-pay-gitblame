/**
 * Reconciliation with refunds: a refund journals a gross reversal and a fee
 * reversal on merchant_payable but is never part of a settlement batch, so
 * pendingUnbatchedFils must carry it too or every period with a refund
 * reports an unexplained gap. Route-level, real Postgres.
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
  throw new Error("reconciliationRefund.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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

async function merchant(mdrBps: number) {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Recon Refund Test ${randomUUID()}`, mdrBps],
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

async function post(rawKey: string, url: string, payload: object) {
  return app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload,
  });
}

function todayBahrain(): string {
  return new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
}

function nextDay(d: string): string {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
}

async function captureAndRefund(rawKey: string): Promise<string> {
  const auth = await post(rawKey, "/v1/transactions", { amountFils: 10_000, card: VALID_CARD });
  assert.equal(auth.statusCode, 201, auth.body);
  const txnId = auth.json().id as string;
  const cap = await post(rawKey, `/v1/transactions/${txnId}/capture`, {});
  assert.equal(cap.statusCode, 200, cap.body);
  const refund = await post(rawKey, "/v1/refunds", { transactionId: txnId, amountFils: 4_000, reason: "test" });
  assert.equal(refund.statusCode, 200, refund.body);
  return txnId;
}

test("a refund claimed by a closed batch is counted in the batch, not again as pending", async () => {
  const { merchantId, rawKey } = await merchant(250);
  const txnId = await captureAndRefund(rawKey);
  const from = todayBahrain();

  // What CloseBatch does: the batch nets the refund (9,750 - 3,900) and
  // stamps both the capture event and the refund with its id.
  const b = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
     VALUES ($1, $2, 'closed', 10000, 250, 5850, now()) RETURNING id`,
    [merchantId, from],
  );
  await pool.query(
    `UPDATE transaction_events SET settlement_batch_id = $2
      WHERE transaction_id = $1 AND event_type IN ('captured', 'partially_captured')`,
    [txnId, b.rows[0]!.id],
  );
  await pool.query(`UPDATE refunds SET settlement_batch_id = $2 WHERE transaction_id = $1`, [txnId, b.rows[0]!.id]);

  const res = await app.inject({
    method: "GET",
    url: `/v1/settlement/reconciliation?from=${from}&to=${nextDay(from)}`,
    headers: { authorization: `Bearer ${rawKey}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const report = res.json() as { settlementNetPayoutFils: number; pendingUnbatchedFils: number; gapFils: number };
  assert.equal(report.settlementNetPayoutFils, 5_850);
  assert.equal(report.pendingUnbatchedFils, 0, JSON.stringify(report));
  assert.equal(report.gapFils, 0, JSON.stringify(report));
});

test("a period with a partial refund still explains to zero", async () => {
  const { rawKey } = await merchant(250);
  const auth = await post(rawKey, "/v1/transactions", { amountFils: 10_000, card: VALID_CARD });
  assert.equal(auth.statusCode, 201, auth.body);
  const txnId = auth.json().id as string;
  const cap = await post(rawKey, `/v1/transactions/${txnId}/capture`, {});
  assert.equal(cap.statusCode, 200, cap.body);
  const refund = await post(rawKey, "/v1/refunds", { transactionId: txnId, amountFils: 4_000, reason: "test" });
  assert.equal(refund.statusCode, 200, refund.body);

  const from = todayBahrain();
  const res = await app.inject({
    method: "GET",
    url: `/v1/settlement/reconciliation?from=${from}&to=${nextDay(from)}`,
    headers: { authorization: `Bearer ${rawKey}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const report = res.json() as { ledgerMerchantPayableNetFils: number; pendingUnbatchedFils: number; gapFils: number; explained: boolean };

  // Capture: +10,000 gross, -250 fee. Refund of 4,000: -4,000 gross, +100 fee reversed.
  assert.equal(report.ledgerMerchantPayableNetFils, 10_000 - 250 - 4_000 + 100);
  assert.equal(report.pendingUnbatchedFils, 10_000 - 250 - 4_000 + 100, JSON.stringify(report));
  assert.equal(report.gapFils, 0, JSON.stringify(report));
  assert.equal(report.explained, true);
});

/** One balanced ledger group: merchant_payable against a counter-account. */
async function payableLeg(merchantId: string, direction: "debit" | "credit", amountFils: number, counter: string, at: string) {
  const other = direction === "debit" ? "credit" : "debit";
  await pool.query(
    `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES ($1, $2, 'merchant_payable', $3, $5, $6, 'test'), ($1, $2, $7, $4, $5, $6, 'test')`,
    [randomUUID(), merchantId, direction, other, amountFils, at, counter],
  );
}

test("a negative batch carried into a later batch in the same period is not counted twice", async () => {
  const { merchantId, rawKey } = await merchant(250);

  // 2026-04-01: a 100,000 refund of an earlier capture (2,500 fee reversed).
  // Its batch closes at -97,500, pays nothing, and the shortfall is carried.
  await payableLeg(merchantId, "debit", 100_000, "card_scheme_clearing", "2026-04-01T09:00:00Z");
  await payableLeg(merchantId, "credit", 2_500, "platform_fee_revenue", "2026-04-01T09:00:00Z");
  // 2026-04-03: a 100,000 capture at 2.50%. Its batch deducts the carried
  // shortfall: 97,500 - 97,500 = 0.
  await payableLeg(merchantId, "credit", 100_000, "card_scheme_clearing", "2026-04-03T09:00:00Z");
  await payableLeg(merchantId, "debit", 2_500, "platform_fee_revenue", "2026-04-03T09:00:00Z");

  const d3 = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
     VALUES ($1, '2026-04-03', 'closed', 100000, 2500, 0, now()) RETURNING id`,
    [merchantId],
  );
  await pool.query(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at, paid_at, carried_forward_to_batch_id)
     VALUES ($1, '2026-04-01', 'paid', 0, 0, -97500, now(), now(), $2)`,
    [merchantId, d3.rows[0]!.id],
  );

  const expectations: Array<[string, string, number]> = [
    ["2026-04-01", "2026-04-05", 0], // both batches: the shortfall once
    ["2026-04-01", "2026-04-02", -97_500], // the refund day alone
    ["2026-04-03", "2026-04-04", 97_500], // the capture day alone
  ];
  for (const [from, to, ledger] of expectations) {
    const res = await app.inject({
      method: "GET",
      url: `/v1/settlement/reconciliation?from=${from}&to=${to}`,
      headers: { authorization: `Bearer ${rawKey}` },
    });
    assert.equal(res.statusCode, 200, res.body);
    const report = res.json() as { ledgerMerchantPayableNetFils: number; gapFils: number };
    assert.equal(report.ledgerMerchantPayableNetFils, ledger);
    assert.equal(report.gapFils, 0, `${from}..${to}: ${JSON.stringify(report)}`);
  }
});
