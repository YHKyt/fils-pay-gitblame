/**
 * Report merchant scoping: a caller may only widen a report to a split child
 * merchant that is its OWN child. Requires DATABASE_URL (migrated Postgres).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { resolveReportMerchantId } from "./scope.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("scope.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 3 });

after(async () => {
  await pool.end();
});

async function createMerchant(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Report Scope Test ${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

async function linkChild(parentId: string, childId: string): Promise<void> {
  await pool.query(
    `INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps)
     VALUES ($1, $2, 10000)`,
    [parentId, childId],
  );
}

test("a parent may scope a report to its own split child", async () => {
  const parent = await createMerchant();
  const child = await createMerchant();
  await linkChild(parent, child);

  assert.equal(await resolveReportMerchantId(pool, parent, child), child);
});

test("an unrelated merchant cannot scope a report to someone else's split child", async () => {
  const parent = await createMerchant();
  const child = await createMerchant();
  const attacker = await createMerchant();
  await linkChild(parent, child);

  // Before the fix any split child of ANY parent was accepted.
  assert.equal(await resolveReportMerchantId(pool, attacker, child), attacker);
});

test("no requested merchant, or a non-child, falls back to the caller", async () => {
  const caller = await createMerchant();
  const other = await createMerchant();

  assert.equal(await resolveReportMerchantId(pool, caller), caller);
  assert.equal(await resolveReportMerchantId(pool, caller, other), caller);
});
