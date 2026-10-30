/**
 * The long-running consumer drains a backlog back to back instead of one
 * batch per poll interval. Requires DATABASE_URL (a real, migrated Postgres).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { loadConfig } from "../config.js";
import { startReportingConsumer } from "./listener.js";
import { CONSUMER_NAME } from "./runConsumerPass.js";
import { drainPast, waitForHorizon } from "./testSupport.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("listener.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

after(async () => {
  await pool.end();
});

async function cursorId(): Promise<bigint> {
  const r = await pool.query<{ last_processed_id: string }>(
    `SELECT last_processed_id FROM reporting_outbox_cursor WHERE consumer_name = $1`,
    [CONSUMER_NAME],
  );
  return r.rows[0] ? BigInt(r.rows[0].last_processed_id) : 0n;
}

test("a backlog larger than one batch is drained without waiting for the poll interval", async () => {
  // Start from a drained outbox so only this test's events are pending.
  await drainPast(pool, { consumerBatchLimit: 500 }, []);

  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`listener backlog ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const ids: bigint[] = [];
  for (let i = 0; i < 4; i++) {
    const e = await enqueueEvent(pool, {
      eventType: "transaction.captured",
      aggregateType: "transaction",
      aggregateId: randomUUID(),
      payload: { merchantId, amountCapturedFils: 1_000, feeFils: 25, newStatus: "captured", capturedTotalFils: 1_000 },
    });
    ids.push(BigInt(e.id));
  }
  await waitForHorizon(pool, ids);

  // One event per pass and a poll interval far beyond the test: only the
  // initial pass at start-up and the consumer's own follow-up passes run.
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    REPORTING_CONSUMER_BATCH_LIMIT: "1",
    REPORTING_POLL_INTERVAL_MS: "600000",
  });
  const handle = startReportingConsumer(pool, config);
  try {
    const last = ids[ids.length - 1]!;
    const deadline = Date.now() + 5_000;
    while ((await cursorId()) < last && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(await cursorId(), last, "all four events applied within 5 s, not one per poll interval");
  } finally {
    await handle.stop();
  }
});
