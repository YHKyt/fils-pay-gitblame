import type { Pool } from "pg";
import type { ReportingConfig } from "../config.js";
import { runConsumerPass } from "./runConsumerPass.js";

/**
 * Test-only helpers.
 *
 * A consumer pass applies only events whose transaction is below its
 * snapshot's xmin, so a pass right after an insert can legitimately find
 * nothing: it waits for every older write transaction on the cluster, and
 * other databases on a shared test server count. The horizon only moves
 * forward, so once the given events are below it every later pass sees them.
 */
export async function waitForHorizon(pool: Pool, eventIds: readonly bigint[], timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const ids = eventIds.map((id) => id.toString());
  for (;;) {
    const result = await pool.query<{ settled: boolean }>(
      `SELECT coalesce(bool_and(xact_id < pg_snapshot_xmin(pg_current_snapshot())), true) AS settled
         FROM outbox_events WHERE id = ANY($1::bigint[])`,
      [ids],
    );
    if (result.rows[0]?.settled === true) return;
    if (Date.now() > deadline) {
      throw new Error(`waitForHorizon: outbox events ${ids.join(", ")} still behind an open transaction after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Waits for the horizon, then runs passes until one finds nothing to apply. */
export async function drainPast(
  pool: Pool,
  config: Pick<ReportingConfig, "consumerBatchLimit">,
  eventIds: readonly bigint[],
): Promise<void> {
  await waitForHorizon(pool, eventIds);
  for (;;) {
    const { processedCount } = await runConsumerPass(pool, config);
    if (processedCount === 0) return;
  }
}
