/**
 * getSettlementBatch counts a batch's transaction_events by
 * settlement_batch_id; 0082 must let that be an index lookup rather than a
 * scan of every event. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("batchDetailPlan.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 2 });

after(async () => {
  await pool.end();
});

test("batch event count is served by idx_transaction_events_settlement_batch", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL enable_seqscan = off");
    const plan = await client.query<{ "QUERY PLAN": string }>(
      `EXPLAIN SELECT count(*) FROM transaction_events WHERE settlement_batch_id = $1`,
      [randomUUID()],
    );
    const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
    assert.match(text, /idx_transaction_events_settlement_batch\b/, text);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
