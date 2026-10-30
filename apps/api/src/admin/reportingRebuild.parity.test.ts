/**
 * The admin "Rebuild analytics" action must produce the reporting
 * consumer's read model. apps/reporting builds merchant_daily_volume and
 * merchant_payout_trends only from the outbox (applyEvent.ts); the rebuild
 * used to aggregate transaction_events, refunds and every settlement_batches
 * row instead, so on the same history it disagreed with the consumer (an
 * open batch, which has no settlement.batch_closed event, showed up in the
 * payout trends after a rebuild).
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

async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function createMerchant(label: string): Promise<string> {
  const result = await pool!.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`rebuild parity ${label} ${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

/** A capture as capture.ts records it: transaction, event and outbox row in
 *  one transaction. A partial capture's event is 'partially_captured', its
 *  outbox event is still transaction.captured. */
async function recordCapture(
  merchantId: string,
  amountFils: number,
  capturedFils = amountFils,
): Promise<{ transactionId: string; eventId: bigint }> {
  return inTransaction(async (client) => {
    const full = capturedFils === amountFils;
    const tx = await client.query<{ id: string }>(
      `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [merchantId, full ? "captured" : "partially_captured", amountFils, capturedFils, `ref-${randomUUID()}`],
    );
    const transactionId = tx.rows[0]!.id;
    await client.query(
      `INSERT INTO transaction_events (transaction_id, event_type, actor_type, amount_fils)
       VALUES ($1, $2, 'system', $3)`,
      [transactionId, full ? "captured" : "partially_captured", capturedFils],
    );
    const event = await enqueueEvent(client, {
      eventType: "transaction.captured",
      aggregateType: "transaction",
      aggregateId: transactionId,
      payload: {
        merchantId,
        amountCapturedFils: capturedFils,
        feeFils: Math.round(capturedFils * 0.025),
        newStatus: full ? "captured" : "partially_captured",
        capturedTotalFils: capturedFils,
      },
    });
    return { transactionId, eventId: event.id };
  });
}

/** A void as void.ts records it. */
async function recordVoid(merchantId: string, amountFils: number): Promise<bigint> {
  return inTransaction(async (client) => {
    const tx = await client.query<{ id: string }>(
      `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
       VALUES ($1, 'voided', $2, 0, $3) RETURNING id`,
      [merchantId, amountFils, `ref-${randomUUID()}`],
    );
    await client.query(
      `INSERT INTO transaction_events (transaction_id, event_type, actor_type) VALUES ($1, 'voided', 'system')`,
      [tx.rows[0]!.id],
    );
    const event = await enqueueEvent(client, {
      eventType: "transaction.voided",
      aggregateType: "transaction",
      aggregateId: tx.rows[0]!.id,
      payload: { merchantId },
    });
    return event.id;
  });
}

/** A refund as processRefund.ts records it: the refunds row and its
 *  refund.succeeded event in one transaction. */
async function recordRefund(merchantId: string, transactionId: string, amountFils: number): Promise<bigint> {
  return inTransaction(async (client) => {
    const refund = await client.query<{ id: string }>(
      `INSERT INTO refunds (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status, acquirer_reference, created_by_type, created_by_id)
       VALUES ($1, $2, $3, 0, 'succeeded', $4, 'merchant_api_key', $5) RETURNING id`,
      [transactionId, merchantId, amountFils, `rf-${randomUUID()}`, randomUUID()],
    );
    const event = await enqueueEvent(client, {
      eventType: "refund.succeeded",
      aggregateType: "transaction",
      aggregateId: transactionId,
      payload: {
        merchantId,
        refundId: refund.rows[0]!.id,
        amountFils,
        feeReversedFils: 0,
        refundedTotalFils: amountFils,
        newStatus: "partially_refunded",
      },
    });
    return event.id;
  });
}

interface BatchFigures {
  grossFils: number;
  feeFils: number;
  netPayoutFils: number;
}

/** settlement.batch_closed with CloseBatch's (and RecalculateMDR's) payload. */
async function announceBatch(client: PoolClient, merchantId: string, batchId: string, batchDate: string, f: BatchFigures): Promise<bigint> {
  const event = await enqueueEvent(client, {
    eventType: "settlement.batch_closed",
    aggregateType: "settlement_batch",
    aggregateId: batchId,
    payload: { merchantId, batchId, batchDate, ...f },
  });
  return event.id;
}

/** CloseBatch: the batch row and its settlement.batch_closed event. */
async function closeBatch(merchantId: string, batchDate: string, f: BatchFigures): Promise<{ batchId: string; eventId: bigint }> {
  return inTransaction(async (client) => {
    const batch = await client.query<{ id: string }>(
      `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
       VALUES ($1, $2, 'closed', $3, $4, $5, now()) RETURNING id`,
      [merchantId, batchDate, f.grossFils, f.feeFils, f.netPayoutFils],
    );
    const batchId = batch.rows[0]!.id;
    return { batchId, eventId: await announceBatch(client, merchantId, batchId, batchDate, f) };
  });
}

/** RecalculateMDR: corrected fee/net on the row, re-announced on the outbox. */
async function recalculateBatch(merchantId: string, batchId: string, batchDate: string, f: BatchFigures): Promise<bigint> {
  return inTransaction(async (client) => {
    await client.query(`UPDATE settlement_batches SET fee_fils = $2, net_payout_fils = $3 WHERE id = $1`, [
      batchId,
      f.feeFils,
      f.netPayoutFils,
    ]);
    return announceBatch(client, merchantId, batchId, batchDate, f);
  });
}

/** The payout, then payout_notify's settlement.paid. */
async function payBatch(merchantId: string, batchId: string, netPayoutFils: number): Promise<bigint> {
  await pool!.query(`UPDATE settlement_batches SET status = 'paid', paid_at = now() WHERE id = $1`, [batchId]);
  return inTransaction(async (client) => {
    const event = await enqueueEvent(client, {
      eventType: "settlement.paid",
      aggregateType: "settlement_batch",
      aggregateId: batchId,
      payload: { merchantId, batchId, netPayoutFils },
    });
    return event.id;
  });
}

async function rebuild(): Promise<void> {
  await inTransaction((client) => refreshAnalyticsRollups(client));
}

/** Both rollups for the given merchants, minus last_updated_at. */
async function readModel(merchantIds: string[]): Promise<{ volume: unknown[]; trends: unknown[] }> {
  const volume = await pool!.query(
    `SELECT merchant_id, volume_date::text, captured_count, captured_gross_fils::text, voided_count,
            refund_count, refund_gross_fils::text
       FROM merchant_daily_volume WHERE merchant_id = ANY($1::uuid[]) ORDER BY merchant_id, volume_date`,
    [merchantIds],
  );
  const trends = await pool!.query(
    `SELECT merchant_id, settlement_batch_id, batch_date::text, status, gross_fils::text, fee_fils::text,
            net_payout_fils::text, paid_at
       FROM merchant_payout_trends WHERE merchant_id = ANY($1::uuid[]) ORDER BY merchant_id, settlement_batch_id`,
    [merchantIds],
  );
  return { volume: volume.rows, trends: trends.rows };
}

test("a rebuild after the consumer has drained leaves the read model identical, and later passes apply nothing twice", { skip }, async () => {
  const alpha = await createMerchant("alpha");
  const beta = await createMerchant("beta");
  const events: bigint[] = [];

  // Alpha: a full and a partial capture, a void, a refund, and a closed
  // batch whose fee RecalculateMDR later corrected.
  const first = await recordCapture(alpha, 10_000);
  events.push(first.eventId);
  events.push((await recordCapture(alpha, 8_000, 4_000)).eventId);
  events.push(await recordVoid(alpha, 3_000));
  events.push(await recordRefund(alpha, first.transactionId, 2_500));
  const alphaBatch = await closeBatch(alpha, "2026-03-04", { grossFils: 14_000, feeFils: 350, netPayoutFils: 13_650 });
  events.push(alphaBatch.eventId);
  events.push(
    await recalculateBatch(alpha, alphaBatch.batchId, "2026-03-04", { grossFils: 14_000, feeFils: 315, netPayoutFils: 13_685 }),
  );

  // Beta: a capture, a batch closed and paid, and today's batch still open
  // (CloseBatch's step 2 row; no event is enqueued for it).
  events.push((await recordCapture(beta, 7_500)).eventId);
  const betaBatch = await closeBatch(beta, "2026-03-04", { grossFils: 7_500, feeFils: 188, netPayoutFils: 7_312 });
  events.push(betaBatch.eventId);
  events.push(await payBatch(beta, betaBatch.batchId, 7_312));
  await pool!.query(`INSERT INTO settlement_batches (merchant_id, batch_date, status) VALUES ($1, '2026-03-05', 'open')`, [beta]);

  await drainPast(pool!, config, events);
  const live = await readModel([alpha, beta]);
  assert.equal(live.trends.length, 2, "sanity: the consumer has a trend row per closed batch, none for the open one");

  await rebuild();
  assert.deepEqual(await readModel([alpha, beta]), live, "the rebuild must produce what the consumer produced");

  await drainPast(pool!, config, events);
  assert.deepEqual(await readModel([alpha, beta]), live, "a pass after the rebuild must not apply anything again");

  // A capture committed but not yet consumed when the rebuild runs is
  // counted once: by the rebuild, then skipped by the consumer.
  const pending = await recordCapture(beta, 1_250);
  await rebuild();
  await drainPast(pool!, config, [pending.eventId]);
  const totals = await pool!.query<{ count: string; gross: string }>(
    `SELECT sum(captured_count)::text AS count, sum(captured_gross_fils)::text AS gross
       FROM merchant_daily_volume WHERE merchant_id = $1`,
    [beta],
  );
  assert.deepEqual(totals.rows[0], { count: "2", gross: "8750" });
  assert.deepEqual((await readModel([alpha, beta])).trends, live.trends);
});
