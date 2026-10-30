/**
 * merchants.mdr_bps had no CHECK (0002), unlike fee_schedules.mdr_bps >= 0
 * (0048). A negative default rate turned the MDR reversal on a manual credit
 * negative, so a "credit with fee reversal" took money from the merchant.
 * Requires DATABASE_URL (migrated Postgres).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("merchantMdrBpsCheck.test.ts requires DATABASE_URL to point at a migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 2 });

test.after(async () => {
  await pool.end();
});

test("merchants.mdr_bps rejects a negative rate", async () => {
  await assert.rejects(
    pool.query(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, -250)`, [`Negative MDR ${randomUUID()}`]),
    (err: { code?: string }) => err.code === "23514",
  );
});

test("merchants.mdr_bps rejects an UPDATE to a negative rate", async () => {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`MDR update ${randomUUID()}`],
  );
  await assert.rejects(
    pool.query(`UPDATE merchants SET mdr_bps = -1 WHERE id = $1`, [result.rows[0]!.id]),
    (err: { code?: string }) => err.code === "23514",
  );
});

test("merchants.mdr_bps still accepts zero and the default", async () => {
  const zero = await pool.query<{ mdr_bps: number }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 0) RETURNING mdr_bps`,
    [`Zero MDR ${randomUUID()}`],
  );
  assert.equal(zero.rows[0]!.mdr_bps, 0);
  const dflt = await pool.query<{ mdr_bps: number }>(
    `INSERT INTO merchants (display_name) VALUES ($1) RETURNING mdr_bps`,
    [`Default MDR ${randomUUID()}`],
  );
  assert.equal(dflt.rows[0]!.mdr_bps, 250);
});
