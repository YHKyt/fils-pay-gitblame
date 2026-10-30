import type { Pool } from "pg";
import type { EventType } from "@filspay/events";
import { withTransaction } from "../db/withTransaction.js";
import type { ReportingConfig } from "../config.js";
import { lockCursor, advanceCursor } from "./cursor.js";
import { applyEvent, type OutboxEventRow } from "./applyEvent.js";

export const REPORTING_EVENT_TYPES: readonly EventType[] = [
  "transaction.captured",
  "transaction.voided",
  "settlement.batch_closed",
  "refund.succeeded",
  "settlement.paid",
];

/**
 * Keys this worker's row in reporting_outbox_cursor. Two processes using the
 * same name serialize on that row, so a catch-up run beside a live worker
 * cannot apply an event twice.
 */
export const CONSUMER_NAME = "reporting";

/**
 * The one function both the NOTIFY handler and the poll timer call.
 * Everything — the read of due outbox_events, every rollup
 * upsert `applyEvent` performs, and the watermark advance — happens inside
 * one `withTransaction` call: either the whole batch of up-to-
 * `consumerBatchLimit` events is applied *and* the watermark moves past all
 * of them, atomically, or (on any error) nothing in this pass is applied
 * and the watermark is untouched — the next pass simply re-selects the
 * identical event range and retries. This is the exact property that makes
 * the watermark alone sufficient for exactly-once application, with no
 * separate per-event dedup table the way webhook_deliveries needs one.
 *
 * That only holds if the position is read under a lock and only ever
 * passes events that can no longer appear behind it:
 *
 * - `lockCursor` reads the position FOR UPDATE, so a concurrent pass
 *   (catch-up beside the worker, a second replica) waits, then starts from
 *   where this one stopped instead of re-applying the same events.
 * - Ids are drawn at INSERT, not at COMMIT, so `id > cursor ORDER BY id`
 *   skipped any event whose transaction committed after a higher id was
 *   consumed. Events are instead read in (xact_id, id) order, and only from
 *   transactions below this statement's snapshot xmin: all of those have
 *   finished, so every one of their events is visible here and no new one
 *   can ever sort before the cursor. An event of a still-open transaction
 *   simply waits for a later pass. The cost is lag, never loss: a long
 *   write transaction anywhere on the cluster holds the horizon back.
 *
 * outbox_events itself is only read, never locked or written — the same
 * posture as webhooks/dispatcher.ts's Step A.
 */
export async function runConsumerPass(
  pool: Pool,
  config: Pick<ReportingConfig, "consumerBatchLimit">,
): Promise<{ processedCount: number }> {
  return withTransaction(pool, async (client) => {
    const cursor = await lockCursor(client, CONSUMER_NAME);

    // idFloor: every id up to the id-only consumer's last watermark (before
    // 0096, or an old worker still running during the deploy) was already
    // applied, whatever its xact_id.
    const eventsResult = await client.query<OutboxEventRow & { xact_id: string }>(
      `SELECT id, event_type, aggregate_id, payload, created_at, xact_id
         FROM outbox_events
        WHERE (xact_id, id) > ($1::xid8, $2::bigint)
          AND id > $3::bigint
          AND xact_id < pg_snapshot_xmin(pg_current_snapshot())
          AND event_type = ANY($4::text[])
          AND ($6::pg_snapshot IS NULL OR NOT pg_visible_in_snapshot(xact_id, $6::pg_snapshot))
        ORDER BY xact_id ASC, id ASC
        LIMIT $5`,
      [
        cursor.lastProcessedXactId.toString(),
        cursor.lastProcessedId.toString(),
        cursor.idFloor.toString(),
        REPORTING_EVENT_TYPES,
        config.consumerBatchLimit,
        cursor.rebuiltSnapshot,
      ],
    );

    for (const row of eventsResult.rows) {
      await applyEvent(client, row);
    }

    const last = eventsResult.rows.at(-1);
    if (last) {
      await advanceCursor(client, CONSUMER_NAME, {
        lastProcessedXactId: BigInt(last.xact_id),
        lastProcessedId: BigInt(last.id),
      });
    }

    return { processedCount: eventsResult.rows.length };
  });
}
