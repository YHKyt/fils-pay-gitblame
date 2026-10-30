import type { QueryableClient } from "@filspay/events";

/**
 * reporting_outbox_cursor read/advance — this consumer's own watermark,
 * never a reuse of outbox_events.processed_at.
 *
 * The position is (xact_id, id): every outbox row at or before it has been
 * applied. See db/migrations/0096 for why id alone is not a safe position.
 */
export interface CursorPosition {
  lastProcessedXactId: bigint;
  lastProcessedId: bigint;
}

export interface ConsumerCursor extends CursorPosition {
  /** Rows with an id at or below this were applied by the id-only consumer
   *  and are never applied again, whatever their xact_id. */
  idFloor: bigint;
  /** Set by the admin "Rebuild analytics" action (apps/api
   *  admin/reportingRebuild.ts): events of transactions visible in this
   *  snapshot are already counted in the rollups and are skipped. */
  rebuiltSnapshot: string | null;
}

/**
 * xid8 and BIGINT both come back from pg as strings, hence the union.
 */
interface CursorRow {
  last_processed_xact_id: string | number;
  last_processed_id: string | number;
  id_floor: string | number;
  rebuilt_snapshot: string | null;
}

/**
 * Seeds the row on first ever run (INSERT ... ON CONFLICT DO NOTHING),
 * then reads it FOR UPDATE. Never throws on a missing row — a worker's first
 * pass against a fresh database always starts from 0.
 *
 * The row lock is what makes two concurrent passes safe (a catch-up run
 * beside the live worker, a second worker replica): the second pass waits
 * here until the first commits, then reads the position the first one
 * advanced to, so no event is applied twice. The listener's `running` flag
 * only serializes passes inside one process.
 *
 * While last_processed_xact_id is still '0', last_processed_id is a
 * watermark written by the id-only consumer (before 0096, or an old worker
 * still running during the deploy), so it is the floor.
 */
export async function lockCursor(client: QueryableClient, consumerName: string): Promise<ConsumerCursor> {
  await client.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id)
     VALUES ($1, 0)
     ON CONFLICT (consumer_name) DO NOTHING`,
    [consumerName],
  );

  const result = (await client.query(
    `SELECT last_processed_xact_id, last_processed_id,
            CASE WHEN last_processed_xact_id = '0' THEN last_processed_id ELSE id_floor END AS id_floor,
            rebuilt_snapshot::text AS rebuilt_snapshot
       FROM reporting_outbox_cursor
      WHERE consumer_name = $1
      FOR UPDATE`,
    [consumerName],
  )) as { rows: CursorRow[] };

  const row = result.rows[0];
  return {
    lastProcessedXactId: row ? BigInt(row.last_processed_xact_id) : 0n,
    lastProcessedId: row ? BigInt(row.last_processed_id) : 0n,
    idFloor: row ? BigInt(row.id_floor) : 0n,
    rebuiltSnapshot: row?.rebuilt_snapshot ?? null,
  };
}

/**
 * Moves the position forward, never backwards: the WHERE clause is the
 * two-column form of GREATEST(current, new). The first move off a '0'
 * position keeps the id-only watermark as id_floor.
 */
export async function advanceCursor(
  client: QueryableClient,
  consumerName: string,
  position: CursorPosition,
): Promise<void> {
  await client.query(
    `UPDATE reporting_outbox_cursor
        SET id_floor = CASE WHEN last_processed_xact_id = '0' THEN last_processed_id ELSE id_floor END,
            last_processed_xact_id = $2::xid8, last_processed_id = $3, updated_at = now()
      WHERE consumer_name = $1
        AND (last_processed_xact_id, last_processed_id) < ($2::xid8, $3::bigint)`,
    [consumerName, position.lastProcessedXactId.toString(), position.lastProcessedId.toString()],
  );
}

/** Resets this consumer's watermark to 0 — used only by the `rebuild`
 *  subcommand (cli/rebuild.ts) before replaying the entire outbox history. */
// MK: rebuild only. never call from the worker.
export async function resetCursor(client: QueryableClient, consumerName: string): Promise<void> {
  await client.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id, updated_at)
     VALUES ($1, 0, now())
     ON CONFLICT (consumer_name) DO UPDATE
       SET last_processed_xact_id = '0', last_processed_id = 0, id_floor = 0,
           rebuilt_snapshot = NULL, updated_at = now()`,
    [consumerName],
  );
}
