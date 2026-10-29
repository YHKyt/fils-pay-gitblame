/**
 * Regression: the batch_closed rollup-parity check read
 * rows[0].captured_count without checking a row exists. A batch_closed for a
 * day that has real captures but no merchant_daily_volume row yet (captures
 * consumed later, or bucketed on the other side of midnight) threw a
 * TypeError, rolling back the whole consumer pass so the watermark could
 * never move past that event. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { withTransaction } from "../db/withTransaction.js";
import { applyEvent } from "./applyEvent.js";

const databaseUrl = process.env.DATABASE_URL;

test("batch_closed with captures but no rollup row warns instead of throwing", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const m = await pool.query<{ id: string }>(
      `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
      [`rollup-gap ${randomUUID()}`],
    );
    const merchantId = m.rows[0]!.id;
    const batchDate = "2026-02-10";
    const b = await pool.query<{ id: string }>(
      `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
       VALUES ($1, $2, 'closed', 5000, 125, 4875, now()) RETURNING id`,
      [merchantId, batchDate],
    );
    // A real capture inside that Asia/Bahrain business day (13:00 local)...
    const t = await pool.query<{ id: string }>(
      `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
       VALUES ($1, 'captured', 5000, 5000, $2, '2026-02-10T10:00:00Z') RETURNING id`,
      [merchantId, `acq-${randomUUID()}`],
    );
    await pool.query(
      `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at)
       VALUES ($1, 'captured', 5000, 'system', '2026-02-10T10:00:00Z')`,
      [t.rows[0]!.id],
    );
    // ...but no merchant_daily_volume row for it.

    await withTransaction(pool, async (client) => {
      await applyEvent(client, {
        id: 1,
        event_type: "settlement.batch_closed",
        aggregate_id: b.rows[0]!.id,
        created_at: new Date("2026-02-10T21:15:00Z"),
        payload: {
          merchantId,
          batchId: b.rows[0]!.id,
          batchDate,
          grossFils: 5000,
          feeFils: 125,
          netPayoutFils: 4875,
        },
      });
    });

    const trend = await pool.query(`SELECT 1 FROM merchant_payout_trends WHERE settlement_batch_id = $1`, [b.rows[0]!.id]);
    assert.equal(trend.rowCount, 1, "the batch_closed event must still be applied");
  } finally {
    await pool.end();
  }
});
