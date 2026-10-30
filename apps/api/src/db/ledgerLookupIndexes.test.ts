/**
 * Hot lookups on ledger_entries must be index conditions, not full scans of
 * the largest table (0117). Requires DATABASE_URL.
 *
 * enable_seqscan = off makes the planner take any usable index even on the
 * small test table; with no usable index the plan stays a Seq Scan and the
 * assertions fail.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("ledgerLookupIndexes.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 2 });

after(async () => {
  await pool.end();
});

async function planOf(sql: string, params: unknown[]): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL enable_seqscan = off");
    const plan = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`, params);
    return plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

test("the commit-time group balance check (ledger_entries_balance) looks the group up by index", async () => {
  // The deferred trigger runs this lookup once per inserted leg at COMMIT.
  const def = await pool.query<{ def: string }>(
    `SELECT pg_get_functiondef('check_ledger_group_balance'::regproc) AS def`,
  );
  assert.match(def.rows[0]!.def, /FROM ledger_entries\s+WHERE entry_group_id = v_group_id/);

  const text = await planOf(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_fils ELSE -amount_fils END), 0)
       FROM ledger_entries WHERE entry_group_id = $1`,
    ["00000000-0000-0000-0000-000000000000"],
  );
  assert.match(text, /Index Cond: \(entry_group_id = /, text);
  assert.doesNotMatch(text, /Seq Scan on ledger_entries/, text);
});

test("a refund reads the transaction's charged fee from the ledger by index", async () => {
  // Same lookup as payments/processRefund.ts, which runs it under the
  // transaction's row lock.
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../payments/processRefund.ts", import.meta.url), "utf8"),
  );
  assert.match(source, /FROM ledger_entries\s+WHERE transaction_id = \$1\s+AND account_id = 'platform_fee_revenue'/);

  const text = await planOf(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)
       FROM ledger_entries
      WHERE transaction_id = $1
        AND account_id = 'platform_fee_revenue'
        AND description NOT LIKE 'refund:%'`,
    ["00000000-0000-0000-0000-000000000000"],
  );
  assert.match(text, /Index Cond: \(transaction_id = /, text);
  assert.doesNotMatch(text, /Seq Scan on ledger_entries/, text);
});
