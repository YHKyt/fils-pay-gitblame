/**
 * Tests for the `reporting rebuild` CLI subcommand: prints a before/after row-count diff, and — the central
 * replay-consistency claim — ends up with rollup data identical to what
 * incremental processing had already produced. This is the ONLY test file
 * that imports runRebuild; grep-confirm elsewhere in the codebase that
 * runRebuild is referenced only from this file and from
 * src/index.ts's `rebuild` subcommand dispatch, never from worker/
 * catch-up/the listener/any daemon startup path. Requires DATABASE_URL to
 * point at a real, migrated Postgres (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { loadConfig } from "../config.js";
import { runConsumerPass, CONSUMER_NAME } from "../consumer/runConsumerPass.js";
import { waitForHorizon } from "../consumer/testSupport.js";
import { runRebuild } from "./rebuild.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("rebuild.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)");
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const config = loadConfig({ DATABASE_URL: databaseUrl });

test.after(async () => {
  await pool.end();
});

async function createMerchant(label: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`rebuild Test Merchant ${label} ${randomUUID()}`, 250],
  );
  return result.rows[0]!.id;
}

async function drainToSteadyState(): Promise<void> {
  for (;;) {
    const { processedCount } = await runConsumerPass(pool, config);
    if (processedCount === 0) break;
  }
}

async function volumeSnapshot(merchantId: string) {
  const result = await pool.query(
    `SELECT volume_date, captured_count, captured_gross_fils, voided_count
       FROM merchant_daily_volume WHERE merchant_id = $1 ORDER BY volume_date`,
    [merchantId],
  );
  return result.rows.map((r) => ({
    volumeDate: r.volume_date.toISOString().slice(0, 10),
    capturedCount: r.captured_count,
    capturedGrossFils: Number(r.captured_gross_fils),
    voidedCount: r.voided_count,
  }));
}

async function payoutSnapshot(merchantId: string) {
  const result = await pool.query(
    `SELECT settlement_batch_id, status, gross_fils, fee_fils, net_payout_fils
       FROM merchant_payout_trends WHERE merchant_id = $1 ORDER BY settlement_batch_id`,
    [merchantId],
  );
  return result.rows.map((r) => ({
    settlementBatchId: r.settlement_batch_id,
    status: r.status,
    grossFils: Number(r.gross_fils),
    feeFils: Number(r.fee_fils),
    netPayoutFils: Number(r.net_payout_fils),
  }));
}

// am: runs with no worker live so it can't catch the double-apply thing. todo?
test("runRebuild: replays to an identical rollup state as incremental processing had already produced, and prints a before/after diff", async () => {
  const merchantId = await createMerchant("rebuild-consistency");

  const capturedEvent = await enqueueEvent(pool, {
    eventType: "transaction.captured",
    aggregateType: "transaction",
    aggregateId: randomUUID(),
    payload: { merchantId, amountCapturedFils: 9_900, feeFils: 148, newStatus: "captured", capturedTotalFils: 9_900 },
  });
  const voidedEvent = await enqueueEvent(pool, {
    eventType: "transaction.voided",
    aggregateType: "transaction",
    aggregateId: randomUUID(),
    payload: { merchantId },
  });
  const batchResult = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at, paid_at)
     VALUES ($1, '2026-03-01', 'paid', 9_900, 148, 9_752, now(), now())
     RETURNING id`,
    [merchantId],
  );
  const batchId = batchResult.rows[0]!.id;
  const closedEvent = await enqueueEvent(pool, {
    eventType: "settlement.batch_closed",
    aggregateType: "settlement_batch",
    aggregateId: batchId,
    payload: { merchantId, batchId, batchDate: "2026-03-01", grossFils: 9_900, feeFils: 148, netPayoutFils: 9_752 },
  });

  // Build up the "incremental processing already produced this" baseline.
  await waitForHorizon(pool, [capturedEvent.id, voidedEvent.id, closedEvent.id]);
  await drainToSteadyState();
  const volumeBeforeRebuild = await volumeSnapshot(merchantId);
  const payoutBeforeRebuild = await payoutSnapshot(merchantId);
  assert.ok(volumeBeforeRebuild.length > 0, "sanity: incremental processing actually produced a volume row");
  assert.ok(payoutBeforeRebuild.length > 0, "sanity: incremental processing actually produced a payout-trend row");

  // Capture console.log output to confirm the before/after diff is printed
  // (one before/after row count per rollup table).
  const originalLog = console.log;
  const logLines: string[] = [];
  console.log = (...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  };
  try {
    await runRebuild(pool, config);
  } finally {
    console.log = originalLog;
  }

  const beforeLine = logLines.find((l) => l.includes("before:"));
  const afterLine = logLines.find((l) => l.includes("after:"));
  assert.ok(beforeLine, "rebuild must print a 'before' row-count line");
  assert.ok(afterLine, "rebuild must print an 'after' row-count line");
  assert.match(beforeLine!, /merchant_daily_volume=\d+ rows/);
  assert.match(afterLine!, /merchant_daily_volume=\d+ rows/);

  const volumeAfterRebuild = await volumeSnapshot(merchantId);
  const payoutAfterRebuild = await payoutSnapshot(merchantId);
  assert.deepEqual(volumeAfterRebuild, volumeBeforeRebuild, "rebuild must reproduce identical merchant_daily_volume data");
  assert.deepEqual(payoutAfterRebuild, payoutBeforeRebuild, "rebuild must reproduce identical merchant_payout_trends data");

  // The watermark must end up caught up again (rebuild's own replay loop
  // runs until a pass processes 0 events), never left at 0.
  const cursorRow = await pool.query<{ last_processed_id: string }>(
    `SELECT last_processed_id FROM reporting_outbox_cursor WHERE consumer_name = $1`,
    [CONSUMER_NAME],
  );
  assert.ok(BigInt(cursorRow.rows[0]!.last_processed_id) > 0n, "watermark must be caught back up after rebuild, not left at 0");
});
