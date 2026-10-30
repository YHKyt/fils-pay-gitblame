/**
 * The reporting read model is built only from outbox_events (the consumer
 * and its `rebuild` replay), so the seed's outbox must describe the same
 * captures and closed batches as the seeded source tables. Otherwise every
 * merchant dashboard on a freshly seeded deployment shows a few events
 * instead of the seeded history.
 *
 * DESTRUCTIVE: generate() truncates every seed table. Runs only with
 * SEED_RESET=1 (the same opt-in the seed CLI requires) against a throwaway
 * database: `SEED_RESET=1 DATABASE_URL=<scratch db> npx tsx --test db/seed/outboxParity.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { generate } from "./generate.js";
import { runConsumerPass } from "../../apps/reporting/src/consumer/runConsumerPass.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = Boolean(databaseUrl) && process.env.SEED_RESET === "1";

test(
  "seeded outbox feeds reporting every seeded capture and closed batch",
  { skip: enabled ? false : "needs DATABASE_URL and SEED_RESET=1 (wipes the database)", timeout: 300_000 },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 5 });
    try {
      await generate(pool);
      for (;;) {
        const { processedCount } = await runConsumerPass(pool, { consumerBatchLimit: 500 });
        if (processedCount === 0) break;
      }

      const readModel = await pool.query<{ captures: string; gross: string }>(
        `SELECT COALESCE(SUM(captured_count), 0)::text AS captures,
                COALESCE(SUM(captured_gross_fils), 0)::text AS gross
           FROM merchant_daily_volume`,
      );
      const source = await pool.query<{ captures: string; gross: string }>(
        `SELECT COUNT(*)::text AS captures, COALESCE(SUM(amount_fils), 0)::text AS gross
           FROM transaction_events
          WHERE event_type IN ('captured', 'partially_captured')`,
      );
      assert.deepEqual(readModel.rows[0], source.rows[0], "daily volume must match the seeded capture timeline");

      // Same Asia/Bahrain day bucketing as the admin rebuild (source tables).
      const perDayMismatch = await pool.query(
        `SELECT t.merchant_id, (te.occurred_at AT TIME ZONE 'Asia/Bahrain')::date AS d,
                COUNT(*) AS n, SUM(te.amount_fils) AS g
           FROM transaction_events te JOIN transactions t ON t.id = te.transaction_id
          WHERE te.event_type IN ('captured', 'partially_captured')
          GROUP BY 1, 2
         EXCEPT
         SELECT merchant_id, volume_date, captured_count, captured_gross_fils
           FROM merchant_daily_volume WHERE captured_count > 0`,
      );
      assert.equal(perDayMismatch.rows.length, 0, "every merchant/day bucket must match");

      const trends = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM merchant_payout_trends`);
      const batches = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM settlement_batches WHERE status IN ('closed', 'paid')`,
      );
      assert.equal(trends.rows[0]!.n, batches.rows[0]!.n, "one payout trend per closed batch");

      const trendMismatch = await pool.query(
        `SELECT id, batch_date, gross_fils, fee_fils, net_payout_fils FROM settlement_batches WHERE status IN ('closed', 'paid')
         EXCEPT
         SELECT settlement_batch_id, batch_date, gross_fils, fee_fils, net_payout_fils FROM merchant_payout_trends`,
      );
      assert.equal(trendMismatch.rows.length, 0, "trend figures must match the batches");
    } finally {
      await pool.end();
    }
  },
);
