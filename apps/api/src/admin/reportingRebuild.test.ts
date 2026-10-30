/**
 * Regression tests for the admin "Rebuild analytics" action against the
 * reporting consumer. The rebuild recomputes the rollups from source tables;
 * it used to leave the consumer's cursor where it was, so the next pass
 * applied every event the consumer had not reached yet on top of the
 * rebuilt totals, counting them twice.
 *
 * Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool, type PoolClient } from "pg";
import { enqueueEvent } from "@filspay/events";
import { drainPast } from "../../../reporting/src/consumer/testSupport.js";
import { refreshAnalyticsRollups } from "./reportingRebuild.js";

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : "DATABASE_URL not set";

const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 6 }) : null;
const config = { consumerBatchLimit: 500 };

test.after(async () => {
  await pool?.end();
});

async function createMerchant(label: string): Promise<string> {
  const result = await pool!.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`analytics rebuild ${label} ${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

/** A capture as capture.ts records it: the transaction, its event, and the
 *  outbox row, all in the caller's transaction. Returns the outbox id. */
async function recordCapture(client: PoolClient | Pool, merchantId: string, amountFils: number): Promise<bigint> {
  const tx = await client.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'captured', $2, $2, $3) RETURNING id`,
    [merchantId, amountFils, `ref-${randomUUID()}`],
  );
  const transactionId = tx.rows[0]!.id;
  await client.query(
    `INSERT INTO transaction_events (transaction_id, event_type, actor_type, amount_fils)
     VALUES ($1, 'captured', 'system', $2)`,
    [transactionId, amountFils],
  );
  const event = await enqueueEvent(client, {
    eventType: "transaction.captured",
    aggregateType: "transaction",
    aggregateId: transactionId,
    payload: { merchantId, amountCapturedFils: amountFils, feeFils: 0, newStatus: "captured", capturedTotalFils: amountFils },
  });
  return event.id;
}

async function rebuild(): Promise<void> {
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    await refreshAnalyticsRollups(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function captured(merchantId: string): Promise<{ count: number; grossFils: number }> {
  const result = await pool!.query<{ count: string; gross: string }>(
    `SELECT coalesce(sum(captured_count), 0)::text AS count, coalesce(sum(captured_gross_fils), 0)::text AS gross
       FROM merchant_daily_volume WHERE merchant_id = $1`,
    [merchantId],
  );
  return { count: Number(result.rows[0]!.count), grossFils: Number(result.rows[0]!.gross) };
}

test("an event the consumer had not reached is not counted again after a rebuild", { skip }, async () => {
  const merchantId = await createMerchant("pending");
  const warmup = await recordCapture(pool!, await createMerchant("warmup"), 100);
  await drainPast(pool!, config, [warmup]);

  // Committed, but the worker has not consumed it yet when the admin rebuilds.
  const pending = await recordCapture(pool!, merchantId, 4_250);
  await rebuild();
  assert.deepEqual(await captured(merchantId), { count: 1, grossFils: 4_250 }, "sanity: the rebuild counted it from source");

  await drainPast(pool!, config, [pending]);
  assert.deepEqual(await captured(merchantId), { count: 1, grossFils: 4_250 }, "the consumer must not apply it a second time");
});

test("a capture still uncommitted while the rebuild runs is applied by the consumer, exactly once", { skip }, async () => {
  const merchantId = await createMerchant("in-flight");
  const open = await pool!.connect();
  let inFlight: bigint;
  try {
    await open.query("BEGIN");
    inFlight = await recordCapture(open, merchantId, 7_000);
    await rebuild();
    assert.deepEqual(await captured(merchantId), { count: 0, grossFils: 0 }, "sanity: the rebuild could not see it");
    await open.query("COMMIT");
  } catch (err) {
    await open.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    open.release();
  }

  await drainPast(pool!, config, [inFlight]);
  assert.deepEqual(await captured(merchantId), { count: 1, grossFils: 7_000 });
});
