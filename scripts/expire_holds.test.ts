import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { expireHolds } from "./expire_holds.js";
import { buildDelete } from "./lib/sqlFilter.js";

// Regression: the janitor used to SELECT expired hold ids and DELETE them via
// buildDelete. With no expired holds the empty id list was skipped, so the
// statement became `DELETE FROM holds` with no WHERE and wiped every hold.

test("an empty id list matches nothing instead of dropping the filter", () => {
  const { text, values } = buildDelete("holds", { id: [] });
  assert.equal(text, "DELETE FROM holds WHERE FALSE");
  assert.deepEqual(values, []);
});

test("a non-empty id list is still scoped to exactly those ids", () => {
  const ids = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];
  const { text, values } = buildDelete("holds", { id: ids });
  assert.equal(text, "DELETE FROM holds WHERE id = ANY($1::uuid[])");
  assert.deepEqual(values, [ids]);
});

const databaseUrl = process.env.DATABASE_URL;

test("expireHolds flips only active, past-expiry holds to 'expired' and never deletes", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
      `holds ${randomUUID()}`,
    ]);
    const merchantId = m.rows[0]!.id;
    const hold = async (status: string, expiresAt: string) => {
      const t = await pool.query<{ id: string }>(
        `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
         VALUES ($1, 'authorized', 1000, 0, $2, now()) RETURNING id`,
        [merchantId, `acq-${randomUUID()}`],
      );
      const h = await pool.query<{ id: string }>(
        `INSERT INTO holds (merchant_id, transaction_id, amount_fils, status, expires_at) VALUES ($1, $2, 1000, $3, $4) RETURNING id`,
        [merchantId, t.rows[0]!.id, status, expiresAt],
      );
      return h.rows[0]!.id;
    };
    const statuses = async () =>
      (
        await pool.query<{ status: string }>(`SELECT status FROM holds WHERE merchant_id = $1 ORDER BY status`, [merchantId])
      ).rows.map((r) => r.status);

    const before = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM holds`);
    await hold("active", "2099-01-01T00:00:00Z"); // still valid
    await hold("released", "2000-01-01T00:00:00Z"); // released long ago
    await expireHolds(pool); // clears any expired holds left by other tests
    const quiet = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM holds`);
    assert.equal(quiet.rows[0]!.c, before.rows[0]!.c + 2, "a night with nothing expired must not delete any hold");
    assert.equal(await expireHolds(pool), 0);

    await hold("active", "2000-01-01T00:00:00Z"); // abandoned
    assert.equal(await expireHolds(pool), 1);
    assert.deepEqual(await statuses(), ["active", "expired", "released"]);
  } finally {
    await pool.end();
  }
});
