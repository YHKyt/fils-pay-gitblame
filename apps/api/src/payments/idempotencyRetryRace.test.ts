/**
 * concfuzz "Reported, not fixed": after an attempt fails with an acquirer
 * 'error' (the key is left 'failed'), two concurrent retries with the same
 * Idempotency-Key both re-opened the key, because the UPDATE in
 * claimIdempotencyKey's failed branch matched on id only. The second waited
 * for the first's row lock and then re-opened the key again, so one 2,000
 * capture request captured 4,000. Real Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool, type PoolClient } from "pg";
import { toFils } from "@filspay/money";
import { recordKycReview } from "../onboarding/review.js";
import type { AcquirerSimulator } from "../acquirer/types.js";
import { authorizeTransaction } from "./authorize.js";
import { captureTransaction } from "./capture.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("idempotencyRetryRace.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 6 });

test.after(async () => {
  await pool.end();
});

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

test("two concurrent retries of a failed capture key capture once", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Retry Race Test ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });

  let captureCalls = 0;
  const acquirer: AcquirerSimulator = {
    async authorize() {
      return { outcome: "approved", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 };
    },
    async capture(req) {
      captureCalls += 1;
      if (captureCalls === 1) return { outcome: "error", acquirerReference: req.acquirerReference, latencyMs: 0 };
      // Hold the first retry inside its transaction long enough for the
      // second retry to reach the claim and wait on the row lock.
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 0 };
    },
    async refund() {
      throw new Error("not used");
    },
  };

  const auth = await authorizeTransaction(pool, acquirer, {
    merchantId,
    amountFils: toFils(5_000),
    card: VALID_CARD,
    idempotencyKey: randomUUID(),
  });
  assert.equal(auth.statusCode, 201);
  const transactionId = (auth.body as { id: string }).id;

  const input = {
    transactionId,
    merchantId,
    amountFils: toFils(2_000),
    idempotencyKey: randomUUID(),
    actor: { type: "system" as const, id: randomUUID() },
  };
  assert.equal((await captureTransaction(pool, acquirer, input)).statusCode, 502);

  // Force the interleaving the race needs: both retries have read the key
  // as 'failed' before either re-opens it. Each retry's re-open UPDATE waits
  // until both have reached it (or 500 ms, if a fix makes one of them stop
  // short of it).
  let arrived = 0;
  let releaseBoth!: () => void;
  const bothArrived = new Promise<void>((resolve) => (releaseBoth = resolve));
  const racingPool = {
    async connect(): Promise<PoolClient> {
      const client = await pool.connect();
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
        const sql = typeof args[0] === "string" ? args[0] : "";
        if (sql.includes("UPDATE idempotency_keys SET status = 'in_progress'")) {
          arrived += 1;
          if (arrived === 2) releaseBoth();
          await Promise.race([bothArrived, new Promise((resolve) => setTimeout(resolve, 500))]);
        }
        return query(...args);
      };
      return client;
    },
  } as unknown as Pool;

  const results = await Promise.allSettled([
    captureTransaction(racingPool, acquirer, input),
    captureTransaction(racingPool, acquirer, input),
  ]);

  const txn = await pool.query<{ captured_fils: number }>(`SELECT captured_fils FROM transactions WHERE id = $1`, [
    transactionId,
  ]);
  assert.equal(Number(txn.rows[0]!.captured_fils), 2_000, `one 2,000 capture request captured more: ${JSON.stringify(results)}`);
  const groups = await pool.query<{ n: number }>(
    `SELECT COUNT(DISTINCT entry_group_id)::int AS n FROM ledger_entries
      WHERE transaction_id = $1 AND description = 'capture: gross'`,
    [transactionId],
  );
  assert.equal(groups.rows[0]!.n, 1, "the capture was journaled twice");
  // The loser is a replay of the winner's answer, never a second capture.
  const ok = results.filter((r) => r.status === "fulfilled" && r.value.statusCode === 200);
  assert.ok(ok.length >= 1, JSON.stringify(results));
});
