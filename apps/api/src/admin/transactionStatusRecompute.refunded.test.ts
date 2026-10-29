/**
 * Regression: the status recompute rebuilt every status from the amounts, so a
 * 'refunded' row from before migration 0043 (refunded_fils = 0) became
 * 'captured' again and could be captured or refunded a second time.
 * Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { withTransaction } from "../db/withTransaction.js";
import { recomputeTransactionStatusesForMerchant } from "./transactionStatusRecompute.js";

const databaseUrl = process.env.DATABASE_URL;

test("recompute never moves a transaction out of 'refunded'", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
      `recompute-refunded ${randomUUID()}`,
    ]);
    const merchantId = m.rows[0]!.id;
    const txn = async (status: string, capturedFils: number, refundedFils: number) => {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference, occurred_at)
         VALUES ($1, $2, 120000, $3, $4, $5, now()) RETURNING id`,
        [merchantId, status, capturedFils, refundedFils, `acq-${randomUUID()}`],
      );
      return r.rows[0]!.id;
    };
    const legacyRefunded = await txn("refunded", 120000, 0); // refunded before refunded_fils existed
    const refunded = await txn("refunded", 120000, 120000);
    const partlyRefunded = await txn("captured", 120000, 20000); // forward move still allowed

    await withTransaction(pool, (client) => recomputeTransactionStatusesForMerchant(client, merchantId));

    const status = async (id: string) =>
      (await pool.query<{ status: string }>(`SELECT status FROM transactions WHERE id = $1`, [id])).rows[0]!.status;
    assert.equal(await status(legacyRefunded), "refunded");
    assert.equal(await status(refunded), "refunded");
    assert.equal(await status(partlyRefunded), "partially_refunded");
  } finally {
    await pool.end();
  }
});
