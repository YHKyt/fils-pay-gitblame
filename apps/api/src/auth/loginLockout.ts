import type { Pool } from "pg";

/** The two account tables with failed_login_count / locked_until (0084). */
type AccountTable = "merchant_users" | "admin_users";

/**
 * Reserves one password check for an account, atomically and BEFORE the
 * password is verified (a check-then-increment would let parallel requests
 * all slip under the limit while argon2 runs). The reservation that reaches
 * `maxAttempts` sets `locked_until`; while that is in the future nothing is
 * reserved. An expired lock starts a fresh count.
 *
 * Returns false when the account is locked: the caller must then reject the
 * login without trusting the password.
 */
export async function reserveLoginAttempt(
  pool: Pool,
  table: AccountTable,
  accountId: string,
  limits: { maxAttempts: number; lockoutMinutes: number },
): Promise<boolean> {
  // One UPDATE reading the row's own columns, so concurrent reservations
  // serialize on the row lock and each sees the previous one's count.
  const next = `CASE WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1
                     ELSE failed_login_count + 1 END`;
  const result = await pool.query(
    `UPDATE ${table}
        SET failed_login_count = ${next},
            locked_until = CASE WHEN ${next} >= $2::int
                                THEN now() + make_interval(mins => $3::int)
                                ELSE NULL END
      WHERE id = $1
        AND (locked_until IS NULL OR locked_until <= now())
     RETURNING id`,
    [accountId, limits.maxAttempts, limits.lockoutMinutes],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Called after a correct password: clears the count and any lock. */
export async function resetLoginAttempts(pool: Pool, table: AccountTable, accountId: string): Promise<void> {
  await pool.query(`UPDATE ${table} SET failed_login_count = 0, locked_until = NULL WHERE id = $1`, [accountId]);
}
