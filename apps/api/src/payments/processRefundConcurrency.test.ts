/**
 * Concurrency and acquirer-failure regressions for the FP-300 refund path
 * (`processRefund`). These drive `processRefund` directly so two refunds, or
 * a refund and a capture, can be held in flight at the acquirer at the same
 * time. Requires `DATABASE_URL` to point at a real, migrated Postgres.
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
import type {
  AcquirerOutcome,
  AcquirerRefundRequest,
  AcquirerRefundResult,
  AcquirerSimulator,
} from "../acquirer/types.js";
import { processRefund } from "./processRefund.js";
import { captureTransaction } from "./capture.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("processRefundConcurrency.test.ts requires DATABASE_URL (run `npm run migrate` first)");
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

const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function approvedMerchant(label: string, mdrBps = 250) {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Refund Concurrency ${label} ${randomUUID()}`, mdrBps],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `o-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label });
  const k = await pool.query<{ id: string }>(`SELECT id FROM api_keys WHERE merchant_id = $1`, [merchantId]);
  return { merchantId, rawKey: issued.rawKey, actor: { type: "merchant_api_key" as const, id: k.rows[0]!.id } };
}

function authHeader(rawKey: string) {
  return { authorization: `Bearer ${rawKey}` };
}

/** Authorize `amount`, then capture `cap` (full capture when omitted). */
async function authCap(rawKey: string, amount: number, cap?: number): Promise<string> {
  const a = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { ...authHeader(rawKey), "idempotency-key": randomUUID() },
    payload: { amountFils: amount, card: VALID_CARD, reference: "concurrency" },
  });
  assert.equal(a.statusCode, 201, a.body);
  const id = a.json().id as string;
  const c = await app.inject({
    method: "POST",
    url: `/v1/transactions/${id}/capture`,
    headers: { ...authHeader(rawKey), "idempotency-key": randomUUID() },
    payload: cap === undefined ? {} : { amountFils: cap },
  });
  assert.equal(c.statusCode, 200, c.body);
  return id;
}

/** An acquirer whose refund() blocks until the test resolves each gate. */
function gatedAcquirer() {
  const gates: Array<{ req: AcquirerRefundRequest; resolve: (o: AcquirerOutcome) => void }> = [];
  let arrived: () => void = () => {};
  const acq: AcquirerSimulator = {
    authorize() {
      throw new Error("n/a");
    },
    capture(req) {
      return Promise.resolve({ outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 });
    },
    refund(req): Promise<AcquirerRefundResult> {
      return new Promise((res) => {
        gates.push({ req, resolve: (o) => res({ outcome: o, acquirerReference: req.acquirerReference, latencyMs: 0 }) });
        arrived();
      });
    },
  };
  const waitFor = (n: number) =>
    new Promise<void>((res) => {
      const check = () => (gates.length >= n ? res() : (arrived = check));
      check();
    });
  return { acq, gates, waitFor };
}

// Regression: step 3 derived the new refunded total (and hence the status and
// the webhook payload) from transactions.refunded_fils, which also carries
// the reservation of a concurrent refund still in flight. When that other
// refund later declined and released its reservation, the approved refund had
// already pushed the transaction to "refunded" with 10,000 reported, leaving
// the real remaining 5,000 impossible to refund (409 not_refundable).
test("a concurrent refund that declines does not inflate the approved refund's total/status", async () => {
  const m = await approvedMerchant("decline-race");
  const id = await authCap(m.rawKey, 10_000);
  const g = gatedAcquirer();

  const a = processRefund(pool, g.acq, {
    transactionId: id,
    merchantId: m.merchantId,
    amountFils: toFils(5_000),
    idempotencyKey: randomUUID(),
    actor: m.actor,
  });
  const b = processRefund(pool, g.acq, {
    transactionId: id,
    merchantId: m.merchantId,
    amountFils: toFils(5_000),
    idempotencyKey: randomUUID(),
    actor: m.actor,
  });
  await g.waitFor(2);
  g.gates[0]!.resolve("approved");
  const ra = await a;
  g.gates[1]!.resolve("declined");
  const rb = await b;

  assert.equal(ra.statusCode, 200);
  assert.equal(rb.statusCode, 402);
  const ab = ra.body as { transactionStatus: string; refundedTotalFils: number };
  assert.equal(ab.refundedTotalFils, 5_000, "approved refund must report only the 5,000 it refunded");
  assert.equal(ab.transactionStatus, "partially_refunded");

  const txn = await pool.query<{ status: string; refunded_fils: string }>(
    `SELECT status, refunded_fils FROM transactions WHERE id = $1`,
    [id],
  );
  assert.equal(txn.rows[0]!.status, "partially_refunded");
  assert.equal(Number(txn.rows[0]!.refunded_fils), 5_000);

  // The remaining 5,000 is still refundable.
  const third = await app.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: { ...authHeader(m.rawKey), "idempotency-key": randomUUID() },
    payload: { transactionId: id, amountFils: 5_000 },
  });
  assert.equal(third.statusCode, 200, third.body);
  assert.equal(third.json().transactionStatus, "refunded");
});

// Regression: the fee reversal used the captured amount read in step 1. A
// capture that landed between the reservation and the journal left the
// pro-rata share computed against the stale captured amount, so a 4,000
// refund of a now-10,000 capture (fee 250) reversed the whole 250 instead of
// its 100 share.
test("a capture racing the refund does not over-reverse the MDR fee", async () => {
  const m = await approvedMerchant("capture-race");
  const id = await authCap(m.rawKey, 10_000, 4_000); // first capture 4,000 -> fee 100
  const g = gatedAcquirer();

  const refund = processRefund(pool, g.acq, {
    transactionId: id,
    merchantId: m.merchantId,
    amountFils: toFils(4_000),
    idempotencyKey: randomUUID(),
    actor: m.actor,
  });
  await g.waitFor(1);
  // Second capture of the remaining 6,000 (fee 150) lands while the refund is
  // held at the acquirer. Total captured is now 10,000, total fee 250.
  const cap = await captureTransaction(pool, g.acq, {
    transactionId: id,
    merchantId: m.merchantId,
    amountFils: toFils(6_000),
    idempotencyKey: randomUUID(),
    actor: m.actor,
  });
  assert.equal(cap.statusCode, 200, JSON.stringify(cap.body));
  g.gates[0]!.resolve("approved");
  const r = await refund;

  assert.equal(r.statusCode, 200);
  const body = r.body as { feeReversedFils: number };
  // 4,000 refunded of 10,000 captured, total fee 250 -> pro-rata 100.
  assert.equal(body.feeReversedFils, 100, "fee reversal must be the pro-rata share, not the whole fee");

  const reversal = await pool.query<{ amount_fils: string }>(
    `SELECT amount_fils FROM ledger_entries
      WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue' AND description = 'refund: MDR fee reversal'`,
    [id],
  );
  assert.equal(reversal.rows.length, 1);
  assert.equal(Number(reversal.rows[0]!.amount_fils), 100);
});

/// Regression: when acquirer.refund() threw (a timeout/socket error) instead of
// returning an outcome, the exception propagated out of processRefund: the
// step-1 reservation was never released and the key stayed in_progress
// forever. The first fix (97ded12) then released the reservation and retried
// under a NEW acquirer idempotency key; but a timeout can arrive after the
// acquirer refunded, so that retry refunded the cardholder a second time.
// Now the reservation is kept and a same-key retry resends the same
// acquirer key, which the acquirer deduplicates.
test("an acquirer that throws keeps the reservation and a same-key retry reuses the acquirer key", async () => {
  const m = await approvedMerchant("throw");
  const id = await authCap(m.rawKey, 10_000);
  const sentKeys: string[] = [];
  let refundsExecuted = 0;
  const executed = new Map<string, AcquirerRefundResult>();
  let throwNext = true;
  // Behaves like a real acquirer: processes the refund, deduplicates on the
  // idempotency key, and the first response is lost to a timeout.
  const acquirer: AcquirerSimulator = {
    authorize() {
      throw new Error("n/a");
    },
    capture() {
      throw new Error("n/a");
    },
    refund(req) {
      sentKeys.push(req.idempotencyKey);
      let result = executed.get(req.idempotencyKey);
      if (!result) {
        refundsExecuted++;
        result = { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
        executed.set(req.idempotencyKey, result);
      }
      if (throwNext) {
        throwNext = false;
        return Promise.reject(new Error("ETIMEDOUT after the acquirer accepted"));
      }
      return Promise.resolve(result);
    },
  };
  const key = randomUUID();
  const request = { transactionId: id, merchantId: m.merchantId, amountFils: toFils(4_000), idempotencyKey: key, actor: m.actor };

  const first = await processRefund(pool, acquirer, request);
  assert.equal(first.statusCode, 502);
  assert.deepEqual(first.body, { error: "acquirer_unavailable" });

  const txn = await pool.query<{ refunded_fils: string }>(`SELECT refunded_fils FROM transactions WHERE id = $1`, [id]);
  assert.equal(Number(txn.rows[0]!.refunded_fils), 4_000, "the reservation is kept while the outcome is unknown");
  const keyRow = await pool.query<{ status: string }>(`SELECT status FROM idempotency_keys WHERE key = $1`, [key]);
  assert.equal(keyRow.rows[0]!.status, "failed", "the key must be retriable, not stuck in_progress");

  const retry = await processRefund(pool, acquirer, request);
  assert.equal(retry.statusCode, 200, JSON.stringify(retry.body));
  assert.equal(new Set(sentKeys).size, 1, "the retry must resend the first acquirer idempotency key");
  assert.equal(refundsExecuted, 1, "the cardholder is refunded once");
  const txn2 = await pool.query<{ refunded_fils: string }>(`SELECT refunded_fils FROM transactions WHERE id = $1`, [id]);
  assert.equal(Number(txn2.rows[0]!.refunded_fils), 4_000);
  const rows = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM refunds WHERE transaction_id = $1`, [id]);
  assert.equal(rows.rows[0]!.n, 1);

  // A refund that never reached the acquirer still completes on the retry.
  const id2 = await authCap(m.rawKey, 10_000);
  throwNext = true;
  const lostRequest: AcquirerSimulator = {
    ...acquirer,
    refund(req) {
      if (throwNext) {
        throwNext = false;
        sentKeys.push(req.idempotencyKey);
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      return acquirer.refund(req);
    },
  };
  const req2 = { ...request, transactionId: id2, idempotencyKey: randomUUID() };
  assert.equal((await processRefund(pool, lostRequest, req2)).statusCode, 502);
  const retry2 = await processRefund(pool, lostRequest, req2);
  assert.equal(retry2.statusCode, 200, JSON.stringify(retry2.body));
  const txn3 = await pool.query<{ refunded_fils: string }>(`SELECT refunded_fils FROM transactions WHERE id = $1`, [id2]);
  assert.equal(Number(txn3.rows[0]!.refunded_fils), 4_000);
});
