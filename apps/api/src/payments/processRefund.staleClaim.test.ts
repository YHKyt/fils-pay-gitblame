/**
 * processRefund commits its idempotency claim (and the amount reservation)
 * BEFORE the acquirer call, so a process that dies between that commit and
 * recording the outcome leaves the key 'in_progress'. That answered 409
 * request_in_progress forever: the comment in idempotency.ts pointed at a
 * stale-claim sweeper (scripts/sweep_idempotency.ts) that never existed.
 *
 * A same-key retry of a stale attempt now takes it over and resends the SAME
 * acquirer idempotency key for the SAME reserved amount (the acquirer
 * deduplicates), and the original attempt, if it was only slow, can no
 * longer record the outcome a second time. Requires DATABASE_URL.
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
import type { AcquirerRefundResult, AcquirerSimulator } from "../acquirer/types.js";
import { processRefund } from "./processRefund.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("processRefund.staleClaim.test.ts requires DATABASE_URL (run `npm run migrate` first)");
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

async function capturedTransaction(amountFils: number) {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
    `Stale Refund Claim ${randomUUID()}`,
  ]);
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `o-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "stale-claim" });
  const k = await pool.query<{ id: string }>(`SELECT id FROM api_keys WHERE merchant_id = $1`, [merchantId]);
  const headers = { authorization: `Bearer ${issued.rawKey}` };
  const a = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { ...headers, "idempotency-key": randomUUID() },
    payload: { amountFils, card: VALID_CARD, reference: "stale-claim" },
  });
  assert.equal(a.statusCode, 201, a.body);
  const transactionId = a.json().id as string;
  const c = await app.inject({
    method: "POST",
    url: `/v1/transactions/${transactionId}/capture`,
    headers: { ...headers, "idempotency-key": randomUUID() },
    payload: {},
  });
  assert.equal(c.statusCode, 200, c.body);
  return { merchantId, transactionId, actor: { type: "merchant_api_key" as const, id: k.rows[0]!.id } };
}

/**
 * Behaves like a real acquirer: refunds once per idempotency key and replays
 * that answer for the key afterwards. The first call is held open until the
 * test lets it go: to the database, that attempt is a process that died
 * after committing its claim.
 */
function acquirerWithHungFirstCall() {
  const sentKeys: string[] = [];
  const executed = new Map<string, AcquirerRefundResult>();
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => (releaseFirst = resolve));
  let signalFirstArrived!: () => void;
  const firstArrived = new Promise<void>((resolve) => (signalFirstArrived = resolve));
  const acquirer: AcquirerSimulator = {
    authorize() {
      throw new Error("n/a");
    },
    capture() {
      throw new Error("n/a");
    },
    async refund(req) {
      sentKeys.push(req.idempotencyKey);
      let result = executed.get(req.idempotencyKey);
      if (!result) {
        result = { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
        executed.set(req.idempotencyKey, result);
      }
      if (sentKeys.length === 1) {
        signalFirstArrived();
        await firstReleased;
      }
      return result;
    },
  };
  return { acquirer, sentKeys, executed, firstArrived, releaseFirst: () => releaseFirst() };
}

async function refundState(transactionId: string) {
  const t = await pool.query<{ refunded_fils: string }>(`SELECT refunded_fils FROM transactions WHERE id = $1`, [
    transactionId,
  ]);
  const r = await pool.query<{ n: number; total: string }>(
    `SELECT count(*)::int AS n, COALESCE(SUM(amount_fils), 0)::text AS total FROM refunds WHERE transaction_id = $1`,
    [transactionId],
  );
  const reversals = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ledger_entries WHERE transaction_id = $1 AND description = 'refund: gross'`,
    [transactionId],
  );
  return {
    refundedFils: Number(t.rows[0]!.refunded_fils),
    refundRows: r.rows[0]!.n,
    refundRowsTotal: Number(r.rows[0]!.total),
    grossReversalLegs: reversals.rows[0]!.n,
  };
}

test("a stale in_progress refund claim is taken over by a same-key retry, which resends the same acquirer key", async () => {
  const { merchantId, transactionId, actor } = await capturedTransaction(10_000);
  const fake = acquirerWithHungFirstCall();
  const key = randomUUID();
  // amountFils omitted: a full refund, whose reserved amount is not in the request.
  const request = { transactionId, merchantId, idempotencyKey: key, actor };

  // Attempt 1 commits its claim and reservation, then never comes back.
  const first = processRefund(pool, fake.acquirer, request);
  const firstSettled = first.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await fake.firstArrived;

  const claim = await pool.query<{ status: string }>(
    `SELECT status FROM idempotency_keys WHERE merchant_id = $1 AND endpoint = 'refunds.create' AND key = $2`,
    [merchantId, key],
  );
  assert.equal(claim.rows[0]!.status, "in_progress");
  assert.equal((await refundState(transactionId)).refundedFils, 10_000, "step 1 reserved the full amount");

  // A retry while the attempt is still fresh must not touch it.
  await assert.rejects(processRefund(pool, fake.acquirer, request), (err: { statusCode?: number; code?: string }) => {
    assert.equal(err.statusCode, 409);
    assert.equal(err.code, "request_in_progress");
    return true;
  });
  assert.equal(fake.sentKeys.length, 1, "a fresh in-flight attempt was taken over");

  // Ten minutes later the attempt is still in_progress: its process is gone.
  await pool.query(
    `UPDATE idempotency_keys
        SET response_body = jsonb_set(response_body, '{claimedAt}', to_jsonb(now() - interval '10 minutes'))
      WHERE merchant_id = $1 AND endpoint = 'refunds.create' AND key = $2`,
    [merchantId, key],
  );

  let retry;
  try {
    retry = await processRefund(pool, fake.acquirer, request);
  } catch (err) {
    assert.fail(`the same-key retry of a stale claim must complete the refund, got ${String(err)}`);
  }
  assert.equal(retry.statusCode, 200, JSON.stringify(retry.body));
  assert.equal((retry.body as { amountFils: number }).amountFils, 10_000);
  assert.equal(fake.sentKeys.length, 2);
  assert.equal(new Set(fake.sentKeys).size, 1, "the retry must resend the stale attempt's acquirer key");
  assert.equal(fake.executed.size, 1, "the cardholder is refunded once at the acquirer");
  assert.deepEqual(await refundState(transactionId), {
    refundedFils: 10_000,
    refundRows: 1,
    refundRowsTotal: 10_000,
    grossReversalLegs: 2,
  });

  // The original attempt was only slow, not dead: its answer arrives now.
  // It must not journal the refund a second time.
  fake.releaseFirst();
  const late = await firstSettled;
  if (late.ok) {
    assert.notEqual(late.value.statusCode, 200, "the taken-over attempt recorded the refund again");
  } else {
    assert.equal((late.error as { statusCode?: number }).statusCode, 409, String(late.error));
  }
  assert.deepEqual(await refundState(transactionId), {
    refundedFils: 10_000,
    refundRows: 1,
    refundRowsTotal: 10_000,
    grossReversalLegs: 2,
  });

  // The key now replays the completed refund.
  const replay = await processRefund(pool, fake.acquirer, request);
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.body, retry.body);
  assert.equal(fake.sentKeys.length, 2, "a replay never calls the acquirer");
});
