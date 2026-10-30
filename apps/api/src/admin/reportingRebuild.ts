import type { PoolClient } from "pg";

/** Counts of outbox_events replayed into each rollup table. */
export interface RebuildAnalyticsSummary {
  volumeRows: number;
  trendRows: number;
}

/** Must match apps/reporting's CONSUMER_NAME. */
const REPORTING_CONSUMER = "reporting";

/** Truncates and repopulates the two rollup tables
 *  (merchant_daily_volume, merchant_payout_trends) from source.
 *
 *  The rollups are also fed incrementally by the reporting consumer, so the
 *  rebuild must tell the consumer which events it has already counted, in
 *  the same transaction; otherwise the consumer applies every event it had
 *  not reached yet a second time. The cursor table lock waits for any
 *  running consumer pass and keeps new ones out until this commits. Both
 *  rollups are then filled in one statement, so one snapshot decides what
 *  is counted, and that snapshot is stored on the cursor: the consumer skips
 *  events of transactions visible in it and applies the rest. */
export async function refreshAnalyticsRollups(client: PoolClient): Promise<RebuildAnalyticsSummary> {
  await client.query(`LOCK TABLE reporting_outbox_cursor IN EXCLUSIVE MODE`);
  // YA: ACCESS EXCLUSIVE lock is fine while analytics is internal only (Jan 2026)
  await client.query(`TRUNCATE merchant_daily_volume`);
  await client.query(`TRUNCATE merchant_payout_trends`);

  const rebuilt = await client.query<{
    trend_rows: string;
    volume_rows: string;
    snap: string;
    xact_id: string | null;
    id: string | null;
  }>(
    `WITH trends AS (
       INSERT INTO merchant_payout_trends
           (merchant_id, settlement_batch_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, paid_at, last_updated_at)
        SELECT merchant_id, id, batch_date, status, gross_fils, fee_fils, net_payout_fils, paid_at, now()
          FROM settlement_batches
        RETURNING 1
     ), volume AS (
       INSERT INTO merchant_daily_volume
           (merchant_id, volume_date, captured_count, captured_gross_fils, voided_count, last_updated_at)
        SELECT t.merchant_id,
               (te.occurred_at AT TIME ZONE 'Asia/Bahrain')::date,
               COUNT(*) FILTER (WHERE te.event_type IN ('captured', 'partially_captured')),
               COALESCE(SUM(te.amount_fils) FILTER (WHERE te.event_type IN ('captured', 'partially_captured')), 0),
               COUNT(*) FILTER (WHERE te.event_type = 'voided'),
               now()
          FROM transaction_events te
          JOIN transactions t ON t.id = te.transaction_id
         WHERE te.event_type IN ('captured', 'partially_captured', 'voided')
         GROUP BY t.merchant_id, (te.occurred_at AT TIME ZONE 'Asia/Bahrain')::date
        RETURNING 1
     ), horizon AS (
       SELECT pg_current_snapshot() AS snap
     ), last_finished AS (
       -- The last outbox row of a transaction that finished before the
       -- snapshot: everything up to it is counted, so the cursor can move here.
       SELECT o.xact_id, o.id
         FROM outbox_events o, horizon h
        WHERE o.xact_id < pg_snapshot_xmin(h.snap)
        ORDER BY o.xact_id DESC, o.id DESC
        LIMIT 1
     )
     SELECT (SELECT count(*) FROM trends)::text AS trend_rows,
            (SELECT count(*) FROM volume)::text AS volume_rows,
            h.snap::text AS snap,
            lf.xact_id::text AS xact_id,
            lf.id::text AS id
       FROM horizon h LEFT JOIN last_finished lf ON true`,
  );
  const row = rebuilt.rows[0]!;

  // Same forward-only move as the consumer's advanceCursor; the first move
  // off a legacy '0' position keeps the id-only watermark as id_floor.
  await client.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id, updated_at)
     VALUES ($1, 0, now())
     ON CONFLICT (consumer_name) DO NOTHING`,
    [REPORTING_CONSUMER],
  );
  await client.query(
    `UPDATE reporting_outbox_cursor
        SET id_floor = CASE
              WHEN last_processed_xact_id = '0' AND (last_processed_xact_id, last_processed_id) < ($3::xid8, $4::bigint)
              THEN last_processed_id ELSE id_floor END,
            (last_processed_xact_id, last_processed_id) = (
              SELECT p.x, p.i FROM (VALUES (last_processed_xact_id, last_processed_id), ($3::xid8, $4::bigint)) AS p(x, i)
               ORDER BY p.x DESC, p.i DESC LIMIT 1),
            rebuilt_snapshot = $2::pg_snapshot,
            updated_at = now()
      WHERE consumer_name = $1`,
    [REPORTING_CONSUMER, row.snap, row.xact_id ?? "0", row.id ?? "0"],
  );

  return { volumeRows: Number(row.volume_rows), trendRows: Number(row.trend_rows) };
}
