/**
 * Regressions for the March sweep (Finance: "someone ran it twice on staging
 * and the gap doubled … is it safe to run again?"). The bounds test is pure;
 * the idempotency test needs DATABASE_URL and is skipped without it.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { bahrainMonthBounds, runSweep, SWEEP_DESCRIPTION } from "./reconcile_march.js";

test("bahrainMonthBounds covers Asia/Bahrain March, not UTC March", () => {
  const { start, end } = bahrainMonthBounds(2026, 3);
  assert.equal(start.toISOString(), "2026-02-28T21:00:00.000Z");
  assert.equal(end.toISOString(), "2026-03-31T21:00:00.000Z");
});

test("the sweep is idempotent and posts ADR-0002 legs, never touching merchant_payable", { skip: !process.env.DATABASE_URL }, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    const m = await pool.query<{ id: string }>(
      `INSERT INTO merchants (display_name, mdr_bps, status, test_mode) VALUES ($1, 250, 'active', false) RETURNING id`,
      [`sweep-test ${randomUUID()}`],
    );
    const merchantId = m.rows[0]!.id;
    // 4747 fils captured inside Bahrain March -> 7 fils residue.
    await pool.query(
      `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
       VALUES ($1, 'captured', 4747, 4747, $2, '2026-03-10T10:00:00Z')`,
      [merchantId, `acq-${randomUUID()}`],
    );

    for (let run = 1; run <= 3; run++) {
      const client = await pool.connect();
      try {
        const results = await runSweep(client, { year: 2026, month: 3, apply: true });
        const mine = results.find((r) => r.merchantId === merchantId);
        assert.ok(mine, "merchant must be in the sweep");
        assert.equal(mine.posted, run === 1, `run ${run}: posted=${mine.posted}`);
      } finally {
        client.release();
      }
    }

    const legs = await pool.query<{ account_id: string; direction: string; amount_fils: string }>(
      `SELECT account_id, direction, amount_fils FROM ledger_entries
        WHERE merchant_id = $1 AND description = $2 ORDER BY account_id`,
      [merchantId, SWEEP_DESCRIPTION],
    );
    assert.deepEqual(
      legs.rows.map((r) => [r.account_id, r.direction, Number(r.amount_fils)]),
      [
        ["card_scheme_clearing", "credit", 7],
        ["scheme_rounding_residue", "debit", 7],
      ],
      "exactly one balanced ADR-0002 group after three runs",
    );
  } finally {
    await pool.end();
  }
});
