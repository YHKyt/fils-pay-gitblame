/**
 * A capture whose acquirer call throws (a timeout) has an unknown outcome:
 * the acquirer may already have captured. Only a same-key retry was safe,
 * because it resends the same acquirer key. A capture under another key
 * captured the card a second time at the acquirer, and a void marked the
 * transaction voided while the card had been charged (concfuzz.md, residual
 * Medium). capture.ts now records the thrown attempt (0123); the next capture
 * of the same amount resends its acquirer key, and a void or another amount
 * is refused with 409 capture_outcome_unknown. Real Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { toFils } from "@filspay/money";
import { recordKycReview } from "../onboarding/review.js";
import type { AcquirerCaptureResult, AcquirerSimulator } from "../acquirer/types.js";
import { authorizeTransaction } from "./authorize.js";
import { captureTransaction } from "./capture.js";
import { voidTransaction } from "./void.js";

const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 5 }) : undefined;
const skip = !databaseUrl;

test.after(async () => {
  await pool?.end();
});

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const actor = { type: "system" as const, id: randomUUID() };

/** An acquirer that is idempotent per key. `captureTimeouts` makes the next N
 *  capture calls do the work and then throw, as a client-side timeout would. */
function fakeAcquirer() {
  const captures = new Map<string, AcquirerCaptureResult & { amountFils: number }>();
  const state = { captureTimeouts: 0, captureCalls: 0 };
  const acquirer: AcquirerSimulator = {
    async authorize() {
      return { outcome: "approved", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 };
    },
    async capture(req) {
      state.captureCalls += 1;
      let result = captures.get(req.idempotencyKey);
      if (!result) {
        result = { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0, amountFils: req.amountFils };
        captures.set(req.idempotencyKey, result);
      }
      if (state.captureTimeouts > 0) {
        state.captureTimeouts -= 1;
        throw new Error("acquirer timeout");
      }
      return result;
    },
    async refund() {
      throw new Error("not used");
    },
  };
  const capturedAtAcquirer = () => [...captures.values()].reduce((sum, c) => sum + c.amountFils, 0);
  return { acquirer, state, capturedAtAcquirer };
}

async function authorizedTransaction(fake: ReturnType<typeof fakeAcquirer>, amount: number) {
  const m = await pool!.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
    `capture-unknown ${randomUUID()}`,
  ]);
  const merchantId = m.rows[0]!.id;
  await recordKycReview(pool!, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const auth = await authorizeTransaction(pool!, fake.acquirer, {
    merchantId,
    amountFils: toFils(amount),
    card: CARD,
    idempotencyKey: randomUUID(),
    cardFingerprintKey: Buffer.alloc(32),
  });
  assert.equal(auth.statusCode, 201);
  return { merchantId, transactionId: (auth.body as { id: string }).id };
}

async function capturedFils(transactionId: string): Promise<number> {
  const r = await pool!.query<{ captured_fils: string }>(`SELECT captured_fils FROM transactions WHERE id = $1`, [transactionId]);
  return Number(r.rows[0]!.captured_fils);
}

test("a capture under another key after a thrown capture does not capture the card twice", { skip }, async () => {
  const fake = fakeAcquirer();
  const { merchantId, transactionId } = await authorizedTransaction(fake, 10_000);
  const first = { transactionId, merchantId, amountFils: toFils(4_000), idempotencyKey: randomUUID(), actor };

  fake.state.captureTimeouts = 1;
  await assert.rejects(captureTransaction(pool!, fake.acquirer, first), /acquirer timeout/);

  // The merchant gives up on the first key and captures again with a new one.
  const second = await captureTransaction(pool!, fake.acquirer, { ...first, idempotencyKey: randomUUID() });
  assert.equal(second.statusCode, 200, JSON.stringify(second.body));
  assert.equal(fake.capturedAtAcquirer(), 4_000, "the acquirer captured the card twice for one recorded capture");
  assert.equal(await capturedFils(transactionId), 4_000);

  // A late retry of the first key replays instead of capturing again.
  const late = await captureTransaction(pool!, fake.acquirer, first);
  assert.equal(late.statusCode, 200, JSON.stringify(late.body));
  assert.equal(fake.capturedAtAcquirer(), 4_000);
  assert.equal(await capturedFils(transactionId), 4_000);
});

test("a void after a thrown capture is refused until the capture is resolved", { skip }, async () => {
  const fake = fakeAcquirer();
  const { merchantId, transactionId } = await authorizedTransaction(fake, 5_000);
  const input = { transactionId, merchantId, idempotencyKey: randomUUID(), actor };

  fake.state.captureTimeouts = 1;
  await assert.rejects(captureTransaction(pool!, fake.acquirer, input), /acquirer timeout/);

  const voided = await voidTransaction(pool!, { transactionId, merchantId, actor });
  assert.equal(voided.statusCode, 409, `voided while the acquirer captured ${fake.capturedAtAcquirer()} fils`);
  assert.deepEqual(voided.body, { error: "capture_outcome_unknown" });

  // Another amount is refused too, without an acquirer call.
  const calls = fake.state.captureCalls;
  const other = await captureTransaction(pool!, fake.acquirer, { ...input, amountFils: toFils(1_000), idempotencyKey: randomUUID() });
  assert.equal(other.statusCode, 409, JSON.stringify(other.body));
  assert.equal((other.body as { error: string }).error, "capture_outcome_unknown");
  assert.equal(fake.state.captureCalls, calls);

  // The same-key retry resolves it: one capture, and nothing left pending.
  const retry = await captureTransaction(pool!, fake.acquirer, input);
  assert.equal(retry.statusCode, 200, JSON.stringify(retry.body));
  assert.equal(fake.capturedAtAcquirer(), 5_000);
  assert.equal(await capturedFils(transactionId), 5_000);
  const pending = await pool!.query(`SELECT 1 FROM capture_attempts_unresolved WHERE transaction_id = $1`, [transactionId]);
  assert.equal(pending.rows.length, 0);
});
