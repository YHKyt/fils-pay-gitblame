import type { Pool } from "pg";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { withTransaction } from "../db/withTransaction.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";

export interface ArchivedDeliveryEntry {
  deliveryId: string;
  outboxEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CreateArchiveResult {
  archiveId: string;
  deliveryCount: number;
}

/**
 * Snapshots every delivery for one endpoint in [from, to) into a single
 * retained row, ahead of a URL rotation or the endpoint being disabled. No
 * row cap: an audit archive that silently dropped deliveries past some
 * threshold would defeat the reason it exists (a receiver's own support
 * team, or a future auditor, needs the *complete* record for the range they
 * were told the archive covers).
 */
export async function createWebhookDeliveryArchive(
  pool: Pool,
  input: { merchantId: string; endpointId: string; adminUserId: string; from: Date; to: Date },
): Promise<CreateArchiveResult> {
  return withTransaction(pool, async (client) => {
    const endpoint = await client.query<{ id: string }>(
      `SELECT id FROM webhook_endpoints WHERE id = $1 AND merchant_id = $2`,
      [input.endpointId, input.merchantId],
    );
    if (!endpoint.rows[0]) {
      throw new NotFoundError("webhook_endpoint_not_found");
    }

    // Built inside Postgres (one row out, not one per delivery), so a large
    // window never sits in the API process. Entries keep capture order and
    // the shape of ArchivedDeliveryEntry; createdAt is ISO 8601 in UTC with
    // milliseconds, as Date.toISOString() wrote it.
    const inserted = await client.query<{ id: string; delivery_count: number }>(
      `INSERT INTO webhook_delivery_archives
          (endpoint_id, merchant_id, created_by_admin_user_id, from_created_at, to_created_at, delivery_count, archive_payload)
       SELECT $1, $2, $3, $4, $5, count(*)::int,
              COALESCE(jsonb_agg(jsonb_build_object(
                'deliveryId', d.id,
                'outboxEventId', d.outbox_event_id::text,
                'eventType', d.event_type,
                'payload', d.payload,
                'createdAt', to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              ) ORDER BY d.created_at ASC), '[]'::jsonb)::text
         FROM webhook_deliveries d
        WHERE d.endpoint_id = $1 AND d.created_at >= $4 AND d.created_at < $5
       RETURNING id, delivery_count`,
      [input.endpointId, input.merchantId, input.adminUserId, input.from, input.to],
    );
    const deliveryCount = inserted.rows[0]!.delivery_count;

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "webhook_delivery_archive_create",
      targetType: "webhook_endpoint",
      targetId: input.endpointId,
      metadata: { merchantId: input.merchantId, deliveryCount },
    });

    return { archiveId: inserted.rows[0]!.id, deliveryCount };
  });
}

/**
 * Bulk-replays every delivery captured in a previously created archive —
 * used to backfill a newly registered replacement endpoint with a
 * merchant's delivery history after a URL rotation, without asking the
 * merchant to re-trigger months of real events. The archive is the
 * complete unit of work by construction (it was written as one row, one
 * JSON document, at creation time), so reading it back the same way mirrors
 * how it was captured.
 */
export async function pruneExpiredArchives(
  pool: Pool,
  retentionDays: number,
): Promise<{ deletedCount: number }> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const result = await pool.query(
    `DELETE FROM webhook_delivery_archives
      WHERE created_at < $1
        AND created_by_admin_user_id IS NOT NULL
    RETURNING id`,
    [cutoff],
  );
  return { deletedCount: result.rowCount ?? 0 };
}

export async function replayWebhookDeliveryArchive(
  pool: Pool,
  input: { merchantId: string; archiveId: string; targetEndpointId: string; adminUserId: string },
): Promise<{ replayedCount: number }> {
  return withTransaction(pool, async (client) => {
    const archiveResult = await client.query<{ id: string }>(
      `SELECT id FROM webhook_delivery_archives WHERE id = $1 AND merchant_id = $2`,
      [input.archiveId, input.merchantId],
    );
    const archiveRow = archiveResult.rows[0];
    if (!archiveRow) {
      throw new NotFoundError("webhook_delivery_archive_not_found");
    }

    const targetEndpoint = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM webhook_endpoints WHERE id = $1 AND merchant_id = $2`,
      [input.targetEndpointId, input.merchantId],
    );
    const targetRow = targetEndpoint.rows[0];
    if (!targetRow) {
      throw new NotFoundError("webhook_endpoint_not_found");
    }
    if (targetRow.status !== "active") {
      throw new ConflictError("endpoint_disabled");
    }

    // Expanded and inserted inside Postgres, in archive (capture) order: the
    // archive is one JSON document with no row cap, and parsing it in the
    // API process, then inserting one row per round trip, held the whole
    // archive in memory for the length of the transaction. Each row is what
    // insertReplayDeliveryRow writes for one entry: the archived envelope's
    // `id` is the original delivery_event_id, kept as is.
    const inserted = await client.query(
      `INSERT INTO webhook_deliveries
          (endpoint_id, outbox_event_id, event_type, delivery_event_id, payload, status, next_attempt_at, replay_of_delivery_id)
       SELECT $2::uuid,
              (e->>'outboxEventId')::bigint,
              e->>'eventType',
              (e->'payload'->>'id')::uuid,
              (e->'payload') || jsonb_build_object('id', e->'payload'->>'id'),
              'pending',
              now(),
              (e->>'deliveryId')::uuid
         FROM webhook_delivery_archives a,
              jsonb_array_elements(a.archive_payload::jsonb) WITH ORDINALITY AS x(e, n)
        WHERE a.id = $1
        ORDER BY x.n`,
      [input.archiveId, input.targetEndpointId],
    );
    const replayedCount = inserted.rowCount ?? 0;

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "webhook_delivery_archive_replay",
      targetType: "webhook_endpoint",
      targetId: input.targetEndpointId,
      metadata: { merchantId: input.merchantId, archiveId: input.archiveId, replayedCount },
    });

    return { replayedCount };
  });
}
