/**
 * Regression tests for the consumer's position:
 *
 * - Ids are drawn at INSERT, not COMMIT. With `WHERE id > cursor ORDER BY id`
 *   an event whose transaction committed after a higher id had been consumed
 *   was skipped forever.
 * - The cursor was read without a lock, so two concurrent passes (the
 *   RUNBOOK's "safe" catch-up beside the live worker) both applied the same
 *   events.
 * - Across the deploy, the id watermark an old worker leaves behind must
 *   keep protecting what it applied.
 *
 * Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent, type NewOutboxEvent } from "@filspay/events";
import { toBahrainDateString } from "../bahrainDate.js";
import { applyEvent } from "./applyEvent.js";
import { runConsumerPass } from "./runConsumerPass.js";
import { drainPast } from "./testSupport.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("runConsumerPass.ordering.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const config = { consumerBatchLimit: 500 };

test.after(async () => {
  await pool.end();
});

async function createMerchant(label: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`ordering ${label} ${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

function captured(merchantId: string, amountFils: number): NewOutboxEvent {
  return {
    eventType: "transaction.captured",
    aggregateType: "transaction",
    aggregateId: randomUUID(),
    payload: { merchantId, amountCapturedFils: amountFils, feeFils: 0, newStatus: "captured", capturedTotalFils: amountFils },
  };
}

async function capturedCount(merchantId: string): Promise<number> {
  const result = await pool.query<{ total: string }>(
    `SELECT coalesce(sum(captured_count), 0)::text AS total FROM merchant_daily_volume WHERE merchant_id = $1`,
    [merchantId],
  );
  return Number(result.rows[0]!.total);
}

test("an event whose transaction commits after a higher id was consumed is still applied, exactly once", async () => {
  const earlyMerchant = await createMerchant("early");
  const lateMerchant = await createMerchant("late");

  const slow = await pool.connect();
  let earlyId: bigint;
  let lateId: bigint;
  try {
    await slow.query("BEGIN");
    // Draws the lower id but stays uncommitted...
    earlyId = (await enqueueEvent(slow, captured(earlyMerchant, 1_000))).id;
    // ...while a later insert draws a higher id and commits first.
    lateId = (await enqueueEvent(pool, captured(lateMerchant, 2_000))).id;
    assert.ok(lateId > earlyId, "sanity: the uncommitted event holds the lower id");

    // A pass runs while the lower id is still invisible.
    await runConsumerPass(pool, config);

    await slow.query("COMMIT");
  } catch (err) {
    await slow.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    slow.release();
  }

  await drainPast(pool, config, [earlyId, lateId]);

  assert.equal(await capturedCount(lateMerchant), 1, "the event that committed first is applied once");
  assert.equal(await capturedCount(earlyMerchant), 1, "the event that committed late must not be skipped");
});

test("two concurrent passes apply each event exactly once", async () => {
  const merchantId = await createMerchant("concurrent");
  const event = await enqueueEvent(pool, captured(merchantId, 3_000));

  // Pre-create the rollup row the event lands on and hold a lock on it, so
  // both passes are inside their transactions at the same moment.
  const volumeDate = toBahrainDateString(event.createdAt);
  await pool.query(`INSERT INTO merchant_daily_volume (merchant_id, volume_date) VALUES ($1, $2)`, [merchantId, volumeDate]);

  const holder = await pool.connect();
  let passes: Promise<PromiseSettledResult<{ processedCount: number }>[]>;
  try {
    await holder.query("BEGIN");
    await holder.query(`SELECT 1 FROM merchant_daily_volume WHERE merchant_id = $1 AND volume_date = $2 FOR UPDATE`, [
      merchantId,
      volumeDate,
    ]);

    passes = Promise.allSettled([runConsumerPass(pool, config), runConsumerPass(pool, config)]);

    // Wait until both passes are blocked (on the rollup row, or one of them
    // on the other's cursor lock). If the commit-safe horizon is held back by
    // some other transaction, the passes find nothing and never block; the
    // wait then times out and the test still checks the outcome.
    const deadline = Date.now() + 5_000;
    for (;;) {
      const waiting = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (Number(waiting.rows[0]!.n) >= 2 || Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    await holder.query("COMMIT");
  } finally {
    holder.release();
  }

  const results = await passes;
  for (const r of results) {
    assert.equal(r.status, "fulfilled", `a pass failed: ${r.status === "rejected" ? String(r.reason) : ""}`);
  }

  await drainPast(pool, config, [event.id]);

  assert.equal(await capturedCount(merchantId), 1, "the event must be applied once, not once per pass");
});

test("a watermark written by the id-only consumer carries over: ids at or below it are not re-applied", async () => {
  const appliedMerchant = await createMerchant("already-applied");
  const pendingMerchant = await createMerchant("pending");
  const applied = await enqueueEvent(pool, captured(appliedMerchant, 4_000));
  await drainPast(pool, config, [applied.id]);
  const appliedBefore = await capturedCount(appliedMerchant);

  // What an old worker still running during the deploy leaves behind: an id,
  // with last_processed_xact_id never written.
  await pool.query(
    `UPDATE reporting_outbox_cursor SET last_processed_xact_id = '0', last_processed_id = $1 WHERE consumer_name = 'reporting'`,
    [applied.id.toString()],
  );
  const pending = await enqueueEvent(pool, captured(pendingMerchant, 5_000));
  await drainPast(pool, config, [pending.id]);

  assert.equal(await capturedCount(appliedMerchant), appliedBefore, "an event at or below the old watermark is not applied again");
  assert.equal(await capturedCount(pendingMerchant), 1, "an event after it is applied");
});

test("an event the id-only consumer applied is not applied again once the cursor moves to commit order", async () => {
  const seenMerchant = await createMerchant("seen-by-old-worker");
  const unseenMerchant = await createMerchant("unseen-by-old-worker");
  const warmup = await enqueueEvent(pool, captured(await createMerchant("warmup"), 1));
  await drainPast(pool, config, [warmup.id]);

  // An older transaction takes its xact id first but inserts its event last,
  // so its event has the higher id and the lower xact_id.
  const older = await pool.connect();
  let seen: Awaited<ReturnType<typeof enqueueEvent>>;
  let unseen: Awaited<ReturnType<typeof enqueueEvent>>;
  try {
    await older.query("BEGIN");
    await older.query("SELECT pg_current_xact_id()");
    seen = await enqueueEvent(pool, captured(seenMerchant, 6_000));
    unseen = await enqueueEvent(older, captured(unseenMerchant, 7_000));
    await older.query("COMMIT");
  } catch (err) {
    await older.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    older.release();
  }
  const xacts = await pool.query<{ id: string; xact_id: string }>(
    `SELECT id::text, xact_id::text FROM outbox_events WHERE id = ANY($1::bigint[])`,
    [[seen.id.toString(), unseen.id.toString()]],
  );
  const xactOf = new Map(xacts.rows.map((r) => [r.id, BigInt(r.xact_id)]));
  assert.ok(unseen.id > seen.id, "sanity: the older transaction's event has the higher id");
  assert.ok(xactOf.get(unseen.id.toString())! < xactOf.get(seen.id.toString())!, "sanity: ...and the lower xact_id");

  // An old worker, still running between the migration and its restart,
  // consumes by id: it applies `seen` and writes only an id watermark.
  const oldWorker = await pool.connect();
  try {
    await oldWorker.query("BEGIN");
    await applyEvent(oldWorker, {
      id: seen.id,
      event_type: seen.eventType,
      aggregate_id: seen.aggregateId,
      payload: seen.payload,
      created_at: seen.createdAt,
    });
    await oldWorker.query(
      `UPDATE reporting_outbox_cursor SET last_processed_xact_id = '0', last_processed_id = $1 WHERE consumer_name = 'reporting'`,
      [seen.id.toString()],
    );
    await oldWorker.query("COMMIT");
  } finally {
    oldWorker.release();
  }

  await drainPast(pool, config, [seen.id, unseen.id]);

  assert.equal(await capturedCount(unseenMerchant), 1, "the event above the old watermark is applied");
  assert.equal(await capturedCount(seenMerchant), 1, "the event the old worker applied is not applied a second time");
});
