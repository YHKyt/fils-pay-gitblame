/**
 * Batch replay is capped at 500 deliveries per call. The operator was not
 * told that more matched, and running it again picked the same first 500
 * (still 'exhausted', oldest first) and queued them a second time, so the
 * rest of the range could never be reached. Real Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { replayWebhookDeliveriesBatch } from "./replayBatch.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("replayBatchCap.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 2 });

after(async () => {
  await pool.end();
});

async function fixture(count: number) {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Replay Cap Test ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, 'not-a-real-hash', 'Replay Cap Test', 'finance') RETURNING id`,
    [`replay-cap-${randomUUID()}@admin.test`],
  );
  const endpoint = await pool.query<{ id: string }>(
    `INSERT INTO webhook_endpoints
        (merchant_id, url, secret_ciphertext, secret_prefix, created_by_type, created_by_id)
     VALUES ($1, $2, 'unused-in-these-tests', 'whsec_testpre', 'merchant_session', $3)
     RETURNING id`,
    [merchantId, `https://receiver.test/${randomUUID()}`, randomUUID()],
  );
  const endpointId = endpoint.rows[0]!.id;
  // `count` exhausted deliveries, one second apart, inside the window.
  await pool.query(
    `WITH ev AS (
       INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload, processed_at)
       SELECT 'test.replay_cap_fixture', 'transaction', gen_random_uuid(), '{}'::jsonb, now()
         FROM generate_series(1, $2) RETURNING id
     ), numbered AS (SELECT id, row_number() OVER (ORDER BY id) AS n FROM ev)
     INSERT INTO webhook_deliveries
         (endpoint_id, outbox_event_id, event_type, delivery_event_id, payload, status, attempt_count, created_at)
     SELECT $1, numbered.id, 'transaction.captured', d.id, jsonb_build_object('id', d.id, 'type', 'transaction.captured', 'data', '{}'::jsonb),
            'exhausted', 8, timestamptz '2026-05-02T00:00:00Z' + numbered.n * interval '1 second'
       FROM numbered CROSS JOIN LATERAL (SELECT gen_random_uuid() AS id) d`,
    [endpointId, count],
  );
  return { merchantId, endpointId, adminUserId: admin.rows[0]!.id };
}

test("a batch larger than the cap says so, and the next call replays the rest instead of the same 500 again", async () => {
  const f = await fixture(501);
  const input = {
    ...f,
    from: new Date("2026-05-01T00:00:00Z"),
    to: new Date("2026-05-05T00:00:00Z"),
    statuses: ["exhausted"],
  };

  const first = await replayWebhookDeliveriesBatch(pool, input);
  assert.equal(first.replayedDeliveryIds.length, 500);
  assert.equal((first as { hasMore?: boolean }).hasMore, true, "the operator is not told that more deliveries matched");

  const second = await replayWebhookDeliveriesBatch(pool, input);
  assert.equal(second.replayedDeliveryIds.length, 1, "the second call queued the first 500 again");
  assert.equal((second as { hasMore?: boolean }).hasMore, false);

  // Every original was replayed exactly once.
  const per = await pool.query<{ n: number; c: number }>(
    `SELECT count(*)::int AS n, count(DISTINCT replay_of_delivery_id)::int AS c
       FROM webhook_deliveries WHERE endpoint_id = $1 AND replay_of_delivery_id IS NOT NULL`,
    [f.endpointId],
  );
  assert.deepEqual(per.rows[0], { n: 501, c: 501 });
});
