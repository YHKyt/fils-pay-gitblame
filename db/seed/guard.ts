import type { Pool } from "pg";

/**
 * Decides whether the seed may run against this database.
 *
 * The seed TRUNCATEs merchants, ledger_entries, admin_users and every table
 * that references them (CASCADE), so running it against a database that
 * already holds data wipes that data. It is allowed only when the database
 * holds none of those rows yet (first boot), or when the operator asks for
 * the wipe explicitly with SEED_RESET=1.
 */
export interface SeedGuardDecision {
  allowed: boolean;
  /** True when the database already had merchants, ledger entries or admin users. */
  populated: boolean;
}

export async function checkSeedTarget(pool: Pick<Pool, "query">, env: NodeJS.ProcessEnv = process.env): Promise<SeedGuardDecision> {
  const result = await pool.query<{ populated: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM merchants)
         OR EXISTS (SELECT 1 FROM ledger_entries)
         OR EXISTS (SELECT 1 FROM admin_users) AS populated`,
  );
  const populated = result.rows[0]?.populated === true;
  return { allowed: !populated || env.SEED_RESET === "1", populated };
}
