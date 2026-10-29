/**
 * An acquirer call that times out is ambiguous: the acquirer may already have
 * authorized/captured. authorize and capture run in a single DB transaction,
 * so the throw rolls back the idempotency claim too; the client's retry with
 * the same Idempotency-Key must reach the acquirer with the SAME acquirer
 * idempotency key, so the acquirer replays its first answer instead of
 * charging the card a second time. Real Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { toFils } from "@filspay/money";
import { recordKycReview } from "../onboarding/review.js";
import type {
  AcquirerAuthorizeResult,
  AcquirerCaptureResult,
  AcquirerSimulator,
} from "../acquirer/types.js";
import { authorizeTransaction } from "./authorize.js";
import { captureTransaction } from "./capture.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("acquirerTimeoutRetry.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

test.after(async () => {
  await pool.end();
});

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

/**
 * Behaves like a real acquirer: idempotent per key, and every key it has not
 * seen before is a new authorization/capture. `timeouts` makes the next N
 * calls do the work and then throw, as a client-side timeout would after
 * the acquirer already acted.
 */
function idempotentAcquirer() {
  const authorizations = new Map<string, AcquirerAuthorizeResult>();
  const captures = new Map<string, AcquirerCaptureResult>();
  const state = { authorizeTimeouts: 0, captureTimeouts: 0 };
  const acquirer: AcquirerSimulator = {
    async authorize(req) {
      let result = authorizations.get(req.idempotencyKey);
      if (!result) {
        result = { outcome: "approved", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 };
        authorizations.set(req.idempotencyKey, result);
      }
      if (state.authorizeTimeouts > 0) {
        state.authorizeTimeouts -= 1;
        throw new Error("acquirer timeout");
      }
      return result;
    },
    async capture(req) {
      let result = captures.get(req.idempotencyKey);
      if (!result) {
        result = { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
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
  return { acquirer, authorizations, captures, state };
}

async function approvedMerchant(): Promise<string> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Acquirer Timeout Test ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  return merchantId;
}

test("authorize retried after an acquirer timeout authorizes the card once, not twice", async () => {
  const merchantId = await approvedMerchant();
  const fake = idempotentAcquirer();
  const key = randomUUID();
  const input = { merchantId, amountFils: toFils(5_000), card: VALID_CARD, idempotencyKey: key };

  fake.state.authorizeTimeouts = 1;
  await assert.rejects(authorizeTransaction(pool, fake.acquirer, input), /acquirer timeout/);

  const retry = await authorizeTransaction(pool, fake.acquirer, input);
  assert.equal(retry.statusCode, 201, JSON.stringify(retry.body));

  // One authorization at the acquirer, and the transaction we recorded is it.
  assert.equal(fake.authorizations.size, 1, "the retry opened a second authorization on the card");
  const [only] = [...fake.authorizations.values()];
  assert.equal((retry.body as { acquirerReference: string }).acquirerReference, only!.acquirerReference);
});

test("capture retried after an acquirer timeout captures once at the acquirer, not twice", async () => {
  const merchantId = await approvedMerchant();
  const fake = idempotentAcquirer();
  const auth = await authorizeTransaction(pool, fake.acquirer, {
    merchantId,
    amountFils: toFils(5_000),
    card: VALID_CARD,
    idempotencyKey: randomUUID(),
  });
  assert.equal(auth.statusCode, 201);
  const transactionId = (auth.body as { id: string }).id;

  const key = randomUUID();
  const input = { transactionId, merchantId, idempotencyKey: key, actor: { type: "system" as const, id: randomUUID() } };

  fake.state.captureTimeouts = 1;
  await assert.rejects(captureTransaction(pool, fake.acquirer, input), /acquirer timeout/);

  const retry = await captureTransaction(pool, fake.acquirer, input);
  assert.equal(retry.statusCode, 200, JSON.stringify(retry.body));
  assert.equal(fake.captures.size, 1, "the retry captured the card a second time at the acquirer");
});

test("a retry after a definitive acquirer error still uses a fresh acquirer key", async () => {
  const merchantId = await approvedMerchant();
  const seen: string[] = [];
  let calls = 0;
  const acquirer: AcquirerSimulator = {
    async authorize(req) {
      seen.push(req.idempotencyKey);
      calls += 1;
      return calls === 1
        ? { outcome: "error", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 }
        : { outcome: "approved", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 };
    },
    async capture() {
      throw new Error("not used");
    },
    async refund() {
      throw new Error("not used");
    },
  };
  const input = { merchantId, amountFils: toFils(1_000), card: VALID_CARD, idempotencyKey: randomUUID() };
  assert.equal((await authorizeTransaction(pool, acquirer, input)).statusCode, 502);
  assert.equal((await authorizeTransaction(pool, acquirer, input)).statusCode, 201);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1], "an acquirer that cached its error would replay it forever");
});
