/**
 * Replays (single, batch, archive restore) must resend the ORIGINAL
 * delivery_event_id: it is the Webhook-Delivery-Id header and the envelope
 * `id`, and receivers dedupe on it. Requires DATABASE_URL to point at a real,
 * migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { createWebhookDeliveryArchive, replayWebhookDeliveryArchive } from "./archiveReplay.js";
import { replayWebhookDelivery } from "./replay.js";
import { replayWebhookDeliveriesBatch } from "./replayBatch.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("replay.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

after(async () => {
  await pool.end();
});

async function createMerchant(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Replay Id Test ${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

async function createAdminUser(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, 'not-a-real-hash', 'Replay Id Test', 'finance') RETURNING id`,
    [`replay-id-${randomUUID()}@admin.test`],
  );
  return result.rows[0]!.id;
}

async function createEndpoint(merchantId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO webhook_endpoints
        (merchant_id, url, secret_ciphertext, secret_prefix, created_by_type, created_by_id)
     VALUES ($1, $2, 'unused-in-these-tests', 'whsec_testpre', 'merchant_session', $3)
     RETURNING id`,
    [merchantId, `https://receiver.test/${randomUUID()}`, randomUUID()],
  );
  return result.rows[0]!.id;
}

async function insertDelivery(
  endpointId: string,
  createdAt: string,
): Promise<{ id: string; deliveryEventId: string }> {
  const outbox = await pool.query<{ id: string }>(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload, processed_at)
     VALUES ('test.replay_id_fixture', 'transaction', $1, '{}'::jsonb, now()) RETURNING id`,
    [randomUUID()],
  );
  const deliveryEventId = randomUUID();
  const result = await pool.query<{ id: string }>(
    `INSERT INTO webhook_deliveries
        (endpoint_id, outbox_event_id, event_type, delivery_event_id, payload, status, attempt_count, created_at)
     VALUES ($1, $2, 'transaction.captured', $3, $4::jsonb, 'exhausted', 8, $5)
     RETURNING id`,
    [
      endpointId,
      outbox.rows[0]!.id,
      deliveryEventId,
      JSON.stringify({ id: deliveryEventId, type: "transaction.captured", data: {} }),
      createdAt,
    ],
  );
  return { id: result.rows[0]!.id, deliveryEventId };
}

async function deliveryIds(rowId: string): Promise<{ delivery_event_id: string; payload_id: string }> {
  const result = await pool.query<{ delivery_event_id: string; payload_id: string }>(
    `SELECT delivery_event_id, payload->>'id' AS payload_id FROM webhook_deliveries WHERE id = $1`,
    [rowId],
  );
  return result.rows[0]!;
}

test("single-delivery replay keeps the original delivery_event_id (header and envelope id)", async () => {
  const merchantId = await createMerchant();
  const endpointId = await createEndpoint(merchantId);
  const original = await insertDelivery(endpointId, "2026-05-02T00:00:00Z");

  const replay = await replayWebhookDelivery(pool, { merchantId, endpointId, deliveryId: original.id });
  assert.notEqual(replay.deliveryId, original.id, "a replay is still its own row");
  const ids = await deliveryIds(replay.deliveryId);
  assert.equal(ids.delivery_event_id, original.deliveryEventId);
  assert.equal(ids.payload_id, original.deliveryEventId);

  // Replaying the replay still carries the same id.
  const again = await replayWebhookDelivery(pool, { merchantId, endpointId, deliveryId: replay.deliveryId });
  assert.equal((await deliveryIds(again.deliveryId)).delivery_event_id, original.deliveryEventId);
});

test("batch replay keeps each original delivery_event_id", async () => {
  const merchantId = await createMerchant();
  const endpointId = await createEndpoint(merchantId);
  const adminUserId = await createAdminUser();
  const original = await insertDelivery(endpointId, "2026-05-02T00:00:00Z");

  const result = await replayWebhookDeliveriesBatch(pool, {
    merchantId,
    endpointId,
    adminUserId,
    from: new Date("2026-05-01T00:00:00Z"),
    to: new Date("2026-05-05T00:00:00Z"),
    statuses: ["exhausted"],
  });
  assert.equal(result.replayedDeliveryIds.length, 1);
  const ids = await deliveryIds(result.replayedDeliveryIds[0]!);
  assert.equal(ids.delivery_event_id, original.deliveryEventId);
  assert.equal(ids.payload_id, original.deliveryEventId);
});

test("archive restore keeps each original delivery_event_id", async () => {
  const merchantId = await createMerchant();
  const endpointId = await createEndpoint(merchantId);
  const adminUserId = await createAdminUser();
  const original = await insertDelivery(endpointId, "2026-05-02T00:00:00Z");

  const archive = await createWebhookDeliveryArchive(pool, {
    merchantId,
    endpointId,
    adminUserId,
    from: new Date("2026-05-01T00:00:00Z"),
    to: new Date("2026-05-05T00:00:00Z"),
  });
  await replayWebhookDeliveryArchive(pool, {
    merchantId,
    archiveId: archive.archiveId,
    targetEndpointId: endpointId,
    adminUserId,
  });

  const restored = await pool.query<{ delivery_event_id: string; payload_id: string }>(
    `SELECT delivery_event_id, payload->>'id' AS payload_id FROM webhook_deliveries WHERE replay_of_delivery_id = $1`,
    [original.id],
  );
  assert.equal(restored.rowCount, 1);
  assert.equal(restored.rows[0]!.delivery_event_id, original.deliveryEventId);
  assert.equal(restored.rows[0]!.payload_id, original.deliveryEventId);
});
