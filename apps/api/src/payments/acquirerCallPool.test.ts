/**
 * authorize and capture used to keep their DB transaction (and so one of the
 * pool's 5 connections) open for the whole acquirer call: 100-400 ms on the
 * simulator, longer on a real acquirer. Under payment load every other
 * request waited for a connection (perfload). They now claim and validate in
 * one short transaction, call the acquirer with no connection checked out,
 * and record the result in a second one.
 *
 * The decisive check uses a pool of ONE connection and an acquirer that
 * needs a connection from that same pool while it runs: the old code held
 * the only connection, so the acquirer's query timed out. The rest pins what
 * the held row lock used to guarantee. Real Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { toFils } from "@filspay/money";
import { recordKycReview } from "../onboarding/review.js";
import type { AcquirerCaptureRequest, AcquirerSimulator } from "../acquirer/types.js";
import { authorizeTransaction } from "./authorize.js";
import { captureTransaction } from "./capture.js";
import { voidTransaction } from "./void.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("acquirerCallPool.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
// One connection, and a short wait for it: a request that holds it across
// the acquirer call starves anything else that needs it.
const onePool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 1_500 });

test.after(async () => {
  await pool.end();
  await onePool.end();
});

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const FP_KEY = Buffer.alloc(32);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function approvedMerchant(): Promise<string> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Acquirer Pool Test ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  return merchantId;
}

/** Approves everything; `during` runs inside every call, before it answers. */
function acquirerWith(during: (kind: "authorize" | "capture", req: unknown) => Promise<void>) {
  const captures: AcquirerCaptureRequest[] = [];
  const acquirer: AcquirerSimulator = {
    async authorize(req) {
      await during("authorize", req);
      return { outcome: "approved", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 };
    },
    async capture(req) {
      await during("capture", req);
      captures.push(req);
      return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
    },
    async refund() {
      throw new Error("not used");
    },
  };
  return { acquirer, captures };
}

async function authorize(merchantId: string, amount: number, acquirer: AcquirerSimulator, p: Pool = pool): Promise<string> {
  const auth = await authorizeTransaction(p, acquirer, {
    merchantId,
    amountFils: toFils(amount),
    card: VALID_CARD,
    idempotencyKey: randomUUID(),
    cardFingerprintKey: FP_KEY,
  });
  assert.equal(auth.statusCode, 201, JSON.stringify(auth.body));
  return (auth.body as { id: string }).id;
}

test("authorize does not hold a pool connection while the acquirer runs", async () => {
  const merchantId = await approvedMerchant();
  const { acquirer } = acquirerWith(async () => {
    await onePool.query("SELECT 1");
  });
  const result = await authorizeTransaction(onePool, acquirer, {
    merchantId,
    amountFils: toFils(5_000),
    card: VALID_CARD,
    idempotencyKey: randomUUID(),
    cardFingerprintKey: FP_KEY,
  });
  assert.equal(result.statusCode, 201, JSON.stringify(result.body));
});

test("capture does not hold a pool connection while the acquirer runs", async () => {
  const merchantId = await approvedMerchant();
  const transactionId = await authorize(merchantId, 5_000, acquirerWith(async () => {}).acquirer);
  const { acquirer } = acquirerWith(async () => {
    await onePool.query("SELECT 1");
  });
  const result = await captureTransaction(onePool, acquirer, {
    transactionId,
    merchantId,
    idempotencyKey: randomUUID(),
    actor: { type: "system", id: randomUUID() },
  });
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  assert.equal((result.body as { status: string }).status, "captured");
});

test("two concurrent captures can never capture more than was authorized", async () => {
  const merchantId = await approvedMerchant();
  const { acquirer, captures } = acquirerWith(async () => {
    await sleep(150);
  });
  const transactionId = await authorize(merchantId, 20_000, acquirer);
  captures.length = 0;
  const capture = () =>
    captureTransaction(pool, acquirer, {
      transactionId,
      merchantId,
      amountFils: toFils(15_000),
      idempotencyKey: randomUUID(),
      actor: { type: "system", id: randomUUID() },
    });
  const results = await Promise.all([capture(), capture()]);
  const codes = results.map((r) => r.statusCode).sort();
  assert.deepEqual(codes, [200, 422], JSON.stringify(results));
  assert.equal(captures.length, 1, "the acquirer was asked to capture 30,000 of a 20,000 authorization");
  const row = await pool.query<{ captured_fils: string }>(`SELECT captured_fils FROM transactions WHERE id = $1`, [transactionId]);
  assert.equal(Number(row.rows[0]!.captured_fils), 15_000);
});

test("a void cannot slip in while a capture is at the acquirer", async () => {
  const merchantId = await approvedMerchant();
  let atAcquirer!: () => void;
  const reached = new Promise<void>((resolve) => (atAcquirer = resolve));
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => (answer = resolve));
  const { acquirer } = acquirerWith(async (kind) => {
    if (kind === "capture") {
      atAcquirer();
      await answered;
    }
  });
  const transactionId = await authorize(merchantId, 5_000, acquirer);
  const capturing = captureTransaction(pool, acquirer, {
    transactionId,
    merchantId,
    idempotencyKey: randomUUID(),
    actor: { type: "system", id: randomUUID() },
  });
  await reached;
  const voiding = voidTransaction(pool, { transactionId, merchantId, actor: { type: "system" } });
  // Give a void that waits on a row lock time to queue behind the capture.
  await sleep(100);
  answer();
  const [captured, voided] = await Promise.all([capturing, voiding]);
  assert.equal(captured.statusCode, 200, JSON.stringify(captured.body));
  assert.equal(voided.statusCode, 409, JSON.stringify(voided.body));
  const row = await pool.query<{ status: string }>(`SELECT status FROM transactions WHERE id = $1`, [transactionId]);
  assert.equal(row.rows[0]!.status, "captured");
});

test("a capture whose process died at the acquirer is taken over by a same-key retry, captured once", async () => {
  const merchantId = await approvedMerchant();
  const seen = new Map<string, number>();
  let hang = true;
  let release!: () => void;
  const hung = new Promise<void>((resolve) => (release = resolve));
  let atAcquirer!: () => void;
  const reached = new Promise<void>((resolve) => (atAcquirer = resolve));
  const { acquirer } = acquirerWith(async (kind, req) => {
    if (kind !== "capture") return;
    const key = (req as AcquirerCaptureRequest).idempotencyKey;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (hang) {
      hang = false;
      atAcquirer();
      await hung;
    }
  });
  const transactionId = await authorize(merchantId, 5_000, acquirer);
  const input = { transactionId, merchantId, idempotencyKey: randomUUID(), actor: { type: "system" as const, id: randomUUID() } };

  const dead = captureTransaction(pool, acquirer, input);
  dead.catch(() => undefined);
  await reached;
  // While it is in flight, a same-key request is told to retry later. (With
  // the transaction held open across the call, it would block instead.)
  const timedOut = Symbol("blocked");
  const second = await Promise.race([
    captureTransaction(pool, acquirer, input).then(
      (r) => r,
      (err: { code?: string }) => err,
    ),
    sleep(2_000).then(() => timedOut),
  ]);
  if (second === timedOut) {
    release();
    assert.fail("a same-key request blocked behind the attempt at the acquirer");
  }
  assert.equal((second as { code?: string }).code, "request_in_progress", JSON.stringify(second));

  // The first attempt's process is now taken to be dead: age its claim.
  await pool.query(
    `UPDATE idempotency_keys
        SET response_body = jsonb_set(response_body, '{claimedAt}', to_jsonb(now() - interval '1 hour'))
      WHERE merchant_id = $1 AND endpoint = 'transactions.capture' AND key = $2`,
    [merchantId, input.idempotencyKey],
  );
  const retry = await captureTransaction(pool, acquirer, input);
  assert.equal(retry.statusCode, 200, JSON.stringify(retry.body));
  assert.equal(seen.size, 1, "the retry used a new acquirer key: a second capture at the acquirer");

  // The slow original wakes up and must not record the capture again.
  release();
  await assert.rejects(dead, (err: { code?: string }) => err.code === "request_in_progress");
  const groups = await pool.query<{ n: number }>(
    `SELECT COUNT(DISTINCT entry_group_id)::int AS n FROM ledger_entries WHERE transaction_id = $1 AND description = 'capture: gross'`,
    [transactionId],
  );
  assert.equal(groups.rows[0]!.n, 1);
});
