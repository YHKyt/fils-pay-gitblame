import type { Pool } from "pg";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { withTransaction } from "../db/withTransaction.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { insertReplayDeliveryRow } from "./replay.js";

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

    const rows = await client.query<{
      id: string;
      outbox_event_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT id, outbox_event_id, event_type, payload, created_at
         FROM webhook_deliveries
        WHERE endpoint_id = $1 AND created_at >= $2 AND created_at < $3
        ORDER BY created_at ASC`,
      [input.endpointId, input.from, input.to],
    );

    const entries: ArchivedDeliveryEntry[] = rows.rows.map((r) => ({
      deliveryId: r.id,
      outboxEventId: r.outbox_event_id,
      eventType: r.event_type,
      payload: r.payload,
      createdAt: r.created_at.toISOString(),
    }));

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO webhook_delivery_archives
          (endpoint_id, merchant_id, created_by_admin_user_id, from_created_at, to_created_at, delivery_count, archive_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        input.endpointId,
        input.merchantId,
        input.adminUserId,
        input.from,
        input.to,
        entries.length,
        JSON.stringify(entries),
      ],
    );

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "webhook_delivery_archive_create",
      targetType: "webhook_endpoint",
      targetId: input.endpointId,
      metadata: { merchantId: input.merchantId, deliveryCount: entries.length },
    });

    return { archiveId: inserted.rows[0]!.id, deliveryCount: entries.length };
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
    const archiveResult = await client.query<{ archive_payload: string }>(
      `SELECT archive_payload FROM webhook_delivery_archives WHERE id = $1 AND merchant_id = $2`,
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

    const entries = JSON.parse(archiveRow.archive_payload) as ArchivedDeliveryEntry[];

    let replayedCount = 0;
    for (const entry of entries) {
      await insertReplayDeliveryRow(client, {
        id: entry.deliveryId,
        endpointId: input.targetEndpointId,
        outboxEventId: entry.outboxEventId,
        eventType: entry.eventType,
        // The archived envelope's `id` is the original delivery_event_id.
        deliveryEventId: String(entry.payload.id),
        payload: entry.payload,
      });
      replayedCount++;
    }

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
