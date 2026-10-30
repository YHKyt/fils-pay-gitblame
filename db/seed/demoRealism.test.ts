/**
 * The seeded history is what judges and demo users see first, and what the
 * settlement tools (CloseBatch, RecalculateMDR) and reporting read back. These
 * checks hold the seed to the same rules the real write paths follow.
 *
 * DESTRUCTIVE: generate() truncates every seed table. Runs only with
 * SEED_RESET=1 (the same opt-in the seed CLI requires) against a throwaway
 * database: `SEED_RESET=1 DATABASE_URL=<scratch db> npx tsx --test db/seed/demoRealism.test.ts`.
 */
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { Pool } from "pg";
import { applyRateFils, toFils } from "@filspay/money";
import { generate } from "./generate.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = Boolean(databaseUrl) && process.env.SEED_RESET === "1";
const skip = enabled ? false : "needs DATABASE_URL and SEED_RESET=1 (wipes the database)";

let pool: Pool;
/** Everything generate() wrote to stdout/stderr. */
let seedOutput = "";

before(async () => {
  if (!enabled) return;
  pool = new Pool({ connectionString: databaseUrl, max: 5 });
  const originalLog = console.log;
  const originalError = console.error;
  const capture = (...args: unknown[]): void => {
    seedOutput += `${args.map(String).join(" ")}\n`;
  };
  console.log = capture;
  console.error = capture;
  try {
    await generate(pool);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

after(async () => {
  if (pool) await pool.end();
});

/** The rate CloseBatch and capture.ts charge at a capture's own instant. */
const RATE_IN_FORCE_SQL = `COALESCE(
  (SELECT fs.mdr_bps FROM fee_schedules fs
    WHERE fs.merchant_id = m.id AND fs.effective_from <= le.occurred_at
    ORDER BY fs.effective_from DESC, fs.created_at DESC LIMIT 1),
  m.mdr_bps)`;

test("every seeded capture is charged the fee schedule rate in force when it happened", { skip, timeout: 300_000 }, async () => {
  const groups = await pool.query<{ entry_group_id: string; display_name: string; rate: number; gross: string; fee: string }>(
    `SELECT le.entry_group_id, m.display_name, ${RATE_IN_FORCE_SQL} AS rate,
            SUM(le.amount_fils) FILTER (WHERE le.account_id = 'card_scheme_clearing' AND le.direction = 'debit')::text AS gross,
            COALESCE(SUM(le.amount_fils) FILTER (WHERE le.account_id = 'platform_fee_revenue'), 0)::text AS fee
       FROM ledger_entries le
       JOIN merchants m ON m.id = le.merchant_id
      WHERE le.description LIKE 'capture %'
        AND m.negotiated_discount_bps = 0
      GROUP BY le.entry_group_id, m.id, m.display_name, le.occurred_at`,
  );
  assert.ok(groups.rows.length > 1000, `expected the seeded captures, got ${groups.rows.length}`);
  const wrong = groups.rows.filter((g) => Number(g.fee) !== applyRateFils(toFils(Number(g.gross)), g.rate));
  assert.deepEqual(
    wrong.slice(0, 3).map((g) => `${g.display_name}: gross ${g.gross} fee ${g.fee}, ${g.rate} bps in force`),
    [],
    `${wrong.length} capture(s) charged a rate other than the one in force`,
  );

  // A closed batch charges the fees of the captures it settles.
  const batches = await pool.query<{ display_name: string; batch_date: string; fee_fils: string; capture_fees: string }>(
    `SELECT m.display_name, to_char(sb.batch_date, 'YYYY-MM-DD') AS batch_date, sb.fee_fils::text,
            (SELECT COALESCE(SUM(le.amount_fils), 0) FROM ledger_entries le
              WHERE le.account_id = 'platform_fee_revenue' AND le.description LIKE 'capture %'
                AND le.transaction_id IN (SELECT transaction_id FROM scheme_export_lines WHERE settlement_batch_id = sb.id))::text AS capture_fees
       FROM settlement_batches sb JOIN merchants m ON m.id = sb.merchant_id
      WHERE sb.status = 'closed' AND m.negotiated_discount_bps = 0`,
  );
  const mismatched = batches.rows.filter((b) => b.fee_fils !== b.capture_fees);
  assert.deepEqual(
    mismatched.slice(0, 3).map((b) => `${b.display_name} ${b.batch_date}: fee ${b.fee_fils}, captures ${b.capture_fees}`),
    [],
  );
});
