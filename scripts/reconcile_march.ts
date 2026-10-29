#!/usr/bin/env -S npx tsx
/**
 * One-off March 2026 reconciliation sweep. Finance wants the scheme
 * rounding residue (the gap between what gets journaled at capture and
 * what the scheme export can actually carry at 2 decimal places) written
 * off for March before the books close on it.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx scripts/reconcile_march.ts --check   # report only, writes nothing
 *   DATABASE_URL=postgres://... npx tsx scripts/reconcile_march.ts           # apply (safe to re-run)
 *
 * Fixed (see docs/audit/money-and-settlement.md, "March sweep"):
 *  - Re-running doubled the residue. Every run posted a fresh randomUUID()
 *    group, so nothing deduplicated anything (the old comment "entry_group_id
 *    dedupes it" was wrong). The sweep now takes an advisory lock and skips any
 *    merchant whose sweep group already exists, identified by its exact
 *    description - the same text earlier runs used, so a prior production run
 *    is detected too. --check reports how many times each merchant was swept,
 *    which answers "did it run more than once in production?" from the ledger.
 *  - It used the UTC month. The settlement business day is Asia/Bahrain
 *    (UTC+3), so Bahrain March starts 2026-02-28T21:00Z.
 *  - It debited merchant_payable, charging merchants for the platform's scheme
 *    rounding. ADR-0002's legs are card_scheme_clearing credit /
 *    scheme_rounding_residue debit; the merchant's balance is not touched.
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client, type ClientBase } from "pg";
import { formatBhd, toFils } from "@filspay/money";

/** UTC calendar-month bounds. Kept for callers that want UTC months; the sweep
 *  itself uses {@link bahrainMonthBounds}. */
export function monthBounds(year: number, month: number): { start: Date; end: Date } {
  return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) };
}

const BAHRAIN_OFFSET_MS = 3 * 60 * 60 * 1000; // Asia/Bahrain is UTC+3, no DST

/** Asia/Bahrain calendar-month bounds as UTC instants: local 00:00 on the 1st
 *  of `month` up to local 00:00 on the 1st of the next month. */
export function bahrainMonthBounds(year: number, month: number): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(year, month - 1, 1) - BAHRAIN_OFFSET_MS),
    end: new Date(Date.UTC(year, month, 1) - BAHRAIN_OFFSET_MS),
  };
}

export const SWEEP_DESCRIPTION = "March 2026 scheme rounding residue sweep — manual recon per finance";

export interface ResidueRow {
  merchantId: string;
  capturedFils: number;
}

/** The fils truncated away when a captured amount is quantized down to the
 *  scheme export's 2-decimal-place granularity. */
export function computeResidueFils(capturedFils: number): number {
  return capturedFils % 10;
}

interface MerchantResidue {
  merchantId: string;
  lineCount: number;
  residueFils: number;
}

async function fetchResidueRows(client: ClientBase, year: number, month: number): Promise<ResidueRow[]> {
  const { start, end } = bahrainMonthBounds(year, month);
  const result = await client.query<{ merchant_id: string; captured_fils: string }>(
    `SELECT merchant_id, captured_fils
       FROM transactions
      WHERE captured_fils > 0
        AND captured_fils % 10 <> 0
        AND occurred_at >= $1 AND occurred_at < $2
      ORDER BY merchant_id, occurred_at`,
    [start.toISOString(), end.toISOString()],
  );
  return result.rows.map((r) => ({ merchantId: r.merchant_id, capturedFils: Number(r.captured_fils) }));
}

/** One correction group per merchant. lineCount is the number of transactions
 *  with a non-zero residue, not the number of scheme lines. */
function groupByMerchant(rows: ResidueRow[]): MerchantResidue[] {
  const byMerchant = new Map<string, MerchantResidue>();
  for (const row of rows) {
    const residue = computeResidueFils(row.capturedFils);
    const existing = byMerchant.get(row.merchantId);
    if (existing) {
      existing.lineCount += 1;
      existing.residueFils += residue;
    } else {
      byMerchant.set(row.merchantId, { merchantId: row.merchantId, lineCount: 1, residueFils: residue });
    }
  }
  return [...byMerchant.values()];
}

/** How many sweep groups have already been posted for a merchant. >1 means an
 *  earlier run double-applied and needs reversing. */
async function priorSweepCount(client: ClientBase, merchantId: string): Promise<number> {
  const r = await client.query<{ n: string }>(
    `SELECT count(DISTINCT entry_group_id)::text AS n FROM ledger_entries WHERE merchant_id = $1 AND description = $2`,
    [merchantId, SWEEP_DESCRIPTION],
  );
  return Number(r.rows[0]?.n ?? 0);
}

async function postResidueCorrection(client: ClientBase, merchant: MerchantResidue, now: Date): Promise<void> {
  // ADR-0002 legs: the platform absorbs the truncation; the merchant's
  // payable is not touched.
  await client.query(
    `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES ($1, $2, 'card_scheme_clearing',    'credit', $3, $4, $5),
            ($1, $2, 'scheme_rounding_residue', 'debit',  $3, $4, $5)`,
    [randomUUID(), merchant.merchantId, merchant.residueFils, now.toISOString(), SWEEP_DESCRIPTION],
  );
}

export interface SweepMerchantResult {
  merchantId: string;
  lineCount: number;
  residueFils: number;
  priorRuns: number;
  posted: boolean;
}

/** Runs the sweep for one Bahrain month inside a single transaction.
 *  apply=false reports without writing. Safe to run any number of times. */
export async function runSweep(
  client: ClientBase,
  opts: { year: number; month: number; apply: boolean; now?: Date },
): Promise<SweepMerchantResult[]> {
  const now = opts.now ?? new Date();
  await client.query("BEGIN");
  try {
    // Serialize concurrent runs so the "already posted?" check below is reliable.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('reconcile_march:2026-03'))`);
    const merchants = groupByMerchant(await fetchResidueRows(client, opts.year, opts.month));
    const results: SweepMerchantResult[] = [];
    for (const m of merchants) {
      const priorRuns = await priorSweepCount(client, m.merchantId);
      const shouldPost = opts.apply && priorRuns === 0 && m.residueFils > 0;
      if (shouldPost) await postResidueCorrection(client, m, now);
      results.push({ ...m, priorRuns, posted: shouldPost });
    }
    await client.query(opts.apply ? "COMMIT" : "ROLLBACK");
    return results;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("reconcile_march: DATABASE_URL environment variable is not set");
  }
  const apply = !process.argv.includes("--check");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const now = new Date();
  try {
    const { start, end } = bahrainMonthBounds(2026, 3);
    console.log(`=== March 2026 reconciliation sweep (${apply ? "APPLY" : "CHECK ONLY"}) ===`);
    console.log(`run at: ${now.toISOString()}`);
    console.log(`window (Asia/Bahrain March): ${start.toISOString()} .. ${end.toISOString()}`);
    console.log("");

    const results = await runSweep(client, { year: 2026, month: 3, apply, now });
    let total = 0;
    for (const r of results) {
      const state = r.posted
        ? "posted"
        : r.priorRuns === 0
          ? apply ? "nothing to post" : "would post"
          : r.priorRuns === 1
            ? "already applied once - skipped"
            : `ALREADY APPLIED ${r.priorRuns} TIMES - double-applied, reverse the extra group(s)`;
      console.log(`merchant ${r.merchantId}: ${r.lineCount} line(s), residue ${formatBhd(toFils(r.residueFils))} BD (${r.residueFils} fils) - ${state}`);
      if (r.posted) total += r.residueFils;
    }
    console.log("---");
    console.log(`residue ${apply ? "posted this run" : "that would be posted"}: ${formatBhd(toFils(apply ? total : results.filter((r) => r.priorRuns === 0).reduce((s, r) => s + r.residueFils, 0)))} BD`);
  } finally {
    await client.end();
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
