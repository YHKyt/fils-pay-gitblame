/**
 * Webhook delivery archive past 1000 rows. docs/ADMIN.md said archives
 * were written in 1000-row pages and the route comment said 500; the code
 * has no paging. It captures the whole range in one query and restores the
 * whole archive in one transaction. This pins the behaviour a pager must keep:
 * no stop after the first page and no row skipped at a page boundary.
 * Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import {
  createWebhookDeliveryArchive,
  replayWebhookDeliveryArchive,
  type ArchivedDeliveryEntry,
} from "./archiveReplay.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("archiveReplay.pageBoundary.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 3 });

after(async () => {
  await pool.end();
});

async function createEndpoint(merchantId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO webhook_endpoints
        (merchant_id, url, secret_ciphertext, secret_prefix, status, created_by_type, created_by_id)
     VALUES ($1, $2, 'unused-in-these-tests', 'whsec_testpre', 'active', 'merchant_session', $3)
     RETURNING id`,
    [merchantId, `https://receiver.test/${randomUUID()}`, randomUUID()],
  );
  return result.rows[0]!.id;
}

test("an archive of 2,101 deliveries captures and restores every one, in capture order", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Archive Page Boundary ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, 'not-a-real-hash', 'Archive Page Boundary', 'finance') RETURNING id`,
    [`archive-page-${randomUUID()}@admin.test`],
  );
  const adminUserId = admin.rows[0]!.id;
  const sourceEndpointId = await createEndpoint(merchantId);
  const targetEndpointId = await createEndpoint(merchantId);
  try {
    await archiveAndRestore(merchantId, adminUserId, sourceEndpointId, targetEndpointId);
  } finally {
    // The restore queues 2,101 'pending' rows on an endpoint whose secret
    // cannot be decrypted. Disabled endpoints' rows are never claimed, so
    // they cannot eat the dispatcher tests' send budget on a shared DB.
    await pool.query(`UPDATE webhook_endpoints SET status = 'disabled' WHERE id = ANY($1::uuid[])`, [
      [sourceEndpointId, targetEndpointId],
    ]);
  }
});

async function archiveAndRestore(
  merchantId: string,
  adminUserId: string,
  sourceEndpointId: string,
  targetEndpointId: string,
): Promise<void> {
  // More than two pages of 1000 (and four of 500), one second apart. Inert
  // outbox event_type, as in archiveReplay.test.ts, so no consumer reads them.
  // Already 'succeeded', so the dispatcher never claims them either.
  const total = 2_101;
  const inserted = await pool.query<{ id: string; n: number }>(
    `WITH oe AS (
       INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload, processed_at)
       SELECT 'test.archive_fixture', 'transaction', gen_random_uuid(), '{}'::jsonb, now()
         FROM generate_series(1, $2::int)
       RETURNING id
     ), numbered AS (
       SELECT id, row_number() OVER (ORDER BY id)::int AS n, gen_random_uuid() AS delivery_event_id FROM oe
     )
     INSERT INTO webhook_deliveries (endpoint_id, outbox_event_id, event_type, delivery_event_id, payload, status, created_at)
     SELECT $1, id, 'transaction.captured', delivery_event_id,
            jsonb_build_object('id', delivery_event_id, 'type', 'transaction.captured', 'data', jsonb_build_object('n', n)),
            'succeeded', timestamptz '2026-05-02T00:00:00Z' + n * interval '1 second'
       FROM numbered
     RETURNING id, (payload->'data'->>'n')::int AS n`,
    [sourceEndpointId, total],
  );
  const expectedIds = inserted.rows.sort((a, b) => a.n - b.n).map((r) => r.id);
  assert.equal(expectedIds.length, total);

  const created = await createWebhookDeliveryArchive(pool, {
    merchantId,
    endpointId: sourceEndpointId,
    adminUserId,
    from: new Date("2026-05-01T00:00:00Z"),
    to: new Date("2026-05-10T00:00:00Z"),
  });
  assert.equal(created.deliveryCount, total);

  const stored = await pool.query<{ archive_payload: string; delivery_count: number }>(
    `SELECT archive_payload, delivery_count FROM webhook_delivery_archives WHERE id = $1`,
    [created.archiveId],
  );
  assert.equal(stored.rows[0]!.delivery_count, total);
  const entries = JSON.parse(stored.rows[0]!.archive_payload) as ArchivedDeliveryEntry[];
  assert.deepEqual(
    entries.map((e) => e.deliveryId),
    expectedIds,
    "every delivery, once each, in created_at order across the 500/1000-row boundaries",
  );

  const replayed = await replayWebhookDeliveryArchive(pool, {
    merchantId,
    archiveId: created.archiveId,
    targetEndpointId,
    adminUserId,
  });
  assert.equal(replayed.replayedCount, total);

  const restored = await pool.query<{ replay_of_delivery_id: string }>(
    `SELECT replay_of_delivery_id FROM webhook_deliveries WHERE endpoint_id = $1`,
    [targetEndpointId],
  );
  assert.deepEqual(
    restored.rows.map((r) => r.replay_of_delivery_id).sort(),
    [...expectedIds].sort(),
    "the restore recreated every archived delivery exactly once",
  );
}
