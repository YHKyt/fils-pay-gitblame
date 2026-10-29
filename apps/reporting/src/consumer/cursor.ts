import type { QueryableClient } from "@filspay/events";

/**
 * reporting_outbox_cursor read/advance — this consumer's own watermark,
 * never a reuse of outbox_events.processed_at.
 *
 * The position is (xact_id, id): every outbox row at or before it has been
 * applied. See db/migrations/0096 for why id alone is not a safe position.
 */
export interface ConsumerCursor {
  lastProcessedXactId: bigint;
  lastProcessedId: bigint;
}

/**
 * xid8 and BIGINT both come back from pg as strings, hence the union.
 */
interface CursorRow {
  last_processed_xact_id: string | number;
  last_processed_id: string | number;
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
 */
export async function lockCursor(client: QueryableClient, consumerName: string): Promise<ConsumerCursor> {
  await client.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id)
     VALUES ($1, 0)
     ON CONFLICT (consumer_name) DO NOTHING`,
    [consumerName],
  );

  const result = (await client.query(
    `SELECT last_processed_xact_id, last_processed_id
       FROM reporting_outbox_cursor
      WHERE consumer_name = $1
      FOR UPDATE`,
    [consumerName],
  )) as { rows: CursorRow[] };

  const row = result.rows[0];
  return {
    lastProcessedXactId: row ? BigInt(row.last_processed_xact_id) : 0n,
    lastProcessedId: row ? BigInt(row.last_processed_id) : 0n,
  };
}

/**
 * Moves the position forward, never backwards: the WHERE clause is the
 * two-column form of GREATEST(current, new).
 */
export async function advanceCursor(
  client: QueryableClient,
  consumerName: string,
  position: ConsumerCursor,
): Promise<void> {
  await client.query(
    `UPDATE reporting_outbox_cursor
        SET last_processed_xact_id = $2::xid8, last_processed_id = $3, updated_at = now()
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
       SET last_processed_xact_id = '0', last_processed_id = 0, updated_at = now()`,
    [consumerName],
  );
}
