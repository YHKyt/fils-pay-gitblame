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
import { getVolumes } from "../analytics/query.js";
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

test("refunds land in the volume rollup once, through a rebuild, and show in the analytics volumes query", { skip }, async () => {
  const merchantId = await createMerchant("refunds");
  const captureId = await recordCapture(pool!, merchantId, 10_000);
  await drainPast(pool!, config, [captureId]);

  // A refund, as processRefund.ts records it: the refunds row and the
  // refund.succeeded outbox event in one transaction.
  const client = await pool!.connect();
  let refundEventId: bigint;
  try {
    await client.query("BEGIN");
    const tx = await client.query<{ id: string }>(
      `SELECT id FROM transactions WHERE merchant_id = $1`,
      [merchantId],
    );
    const refund = await client.query<{ id: string }>(
      `INSERT INTO refunds (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status, acquirer_reference, created_by_type, created_by_id)
       VALUES ($1, $2, 3_000, 75, 'succeeded', $3, 'merchant_api_key', $4) RETURNING id`,
      [tx.rows[0]!.id, merchantId, `rf-${randomUUID()}`, randomUUID()],
    );
    refundEventId = (
      await enqueueEvent(client, {
        eventType: "refund.succeeded",
        aggregateType: "transaction",
        aggregateId: tx.rows[0]!.id,
        payload: { merchantId, refundId: refund.rows[0]!.id, amountFils: 3_000, feeReversedFils: 75, refundedTotalFils: 3_000, newStatus: "partially_refunded" },
      })
    ).id;
    await client.query("COMMIT");
  } finally {
    client.release();
  }

  // The rebuild counts it from the refunds table before the worker reads it.
  await rebuild();
  await drainPast(pool!, config, [refundEventId]);

  const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 27 * 3_600_000).toISOString().slice(0, 10);
  const volumes = await getVolumes(pool!, { merchantId, from: today, to: tomorrow });
  assert.equal(volumes.points.length, 1);
  assert.equal(volumes.points[0]!.capturedGrossFils, 10_000);
  assert.equal(volumes.points[0]!.refundCount, 1);
  assert.equal(volumes.points[0]!.refundGrossFils, 3_000);
});
