/**
 * recent-ledger-activity uses the same [from, to) Bahrain-date window as every
 * other analytics endpoint: activity on the `to` date is outside it.
 * Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { getRecentLedgerActivity, getVolumes } from "./query.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("ledgerActivityWindow.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 3 });

after(async () => {
  await pool.end();
});

async function ledgerPair(merchantId: string, occurredAt: string, description: string): Promise<void> {
  const g = randomUUID();
  await pool.query(
    `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES ($1, $2, 'card_scheme_clearing', 'debit', 1000, $3, $4),
            ($1, $2, 'merchant_payable', 'credit', 1000, $3, $4)`,
    [g, merchantId, occurredAt, description],
  );
}

test("activity on the exclusive `to` Bahrain date is not returned (same window as /volumes)", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Ledger Window Test ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  await ledgerPair(merchantId, "2026-01-30T12:00:00+03:00", "inside");
  await ledgerPair(merchantId, "2026-01-31T00:30:00+03:00", "on-to-date");
  await pool.query(
    `INSERT INTO merchant_daily_volume (merchant_id, volume_date, captured_count, captured_gross_fils, voided_count)
     VALUES ($1, '2026-01-30', 1, 1000, 0), ($1, '2026-01-31', 1, 1000, 0)`,
    [merchantId],
  );

  const window = { merchantId, from: "2026-01-01", to: "2026-01-31" };
  const activity = await getRecentLedgerActivity(pool, window);
  const volumes = await getVolumes(pool, window);

  assert.deepEqual([...new Set(activity.points.map((p) => p.description))], ["inside"]);
  assert.deepEqual(volumes.points.map((p) => p.date), ["2026-01-30"], "volumes already treats `to` as exclusive");
});
