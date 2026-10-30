#!/usr/bin/env -S npx tsx
/**
 * CLI entry point: generate() the deterministic seed, then run every
 * self-verify assertion against it. Exits non-zero iff any REAL assertion
 * fails.
 *
 * Refuses (exit 0, "seed: skipped") when the database already has
 * merchants, ledger entries or admin users, unless SEED_RESET=1.
 *
 * Usage: DATABASE_URL=postgres://... [SEED_RESET=1] npx tsx db/seed/index.ts
 */
import { Pool } from "pg";
import { generate } from "./generate.js";
import { checkSeedTarget } from "./guard.js";
import { buildAssertions, runAssertions } from "./selfVerify.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("seed: DATABASE_URL environment variable is not set");
  }

  // SEED_SIZE accepts small | full, but only 'small' is really implemented
  // so far — 'full' currently generates the same data.
  const seedSize = process.env.SEED_SIZE ?? "small";
  if (seedSize !== "small" && seedSize !== "full") {
    throw new Error(`seed: SEED_SIZE must be 'small' or 'full', got '${seedSize}'`);
  }

  // A Pool (not a bare Client): generate() needs its own checked-out client
  // for the main truncate+insert transaction, and needs the pool again
  // afterward for recordKycReview()/issueApiKey(), which open their own
  // transactions once that first one has committed and released.
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });

  try {
    // The seed wipes merchants, the ledger and admin users. Never do that to
    // a database that already has data unless SEED_RESET=1 asks for it: a
    // redeploy of the hosted stack runs this job again (ops/docker-compose.yml).
    const guard = await checkSeedTarget(pool);
    if (!guard.allowed) {
      console.log(
        "seed: skipped: the database already has merchants, ledger entries or admin users. " +
          "Set SEED_RESET=1 to wipe them and reseed.",
      );
      return;
    }
    if (guard.populated) {
      console.log("seed: SEED_RESET=1: wiping existing data and reseeding");
    }

    const summary = await generate(pool);
    console.log(
      `seed: generated ${summary.merchantCount} merchants, ${summary.merchantUserCount} merchant_users, ` +
        `${summary.transactionCount} transactions, ${summary.ledgerEntryCount} ledger_entries ` +
        `(${summary.ledgerGroupCount} groups), ${summary.holdCount} holds, ` +
        `${summary.settlementBatchCount} settlement_batches, ${summary.schemeExportLineCount} scheme_export_lines, ` +
        `${summary.outboxEventCount} outbox_events, ${summary.transactionEventCount} transaction_events, ` +
        `${summary.splitChildCount} merchant_split_children, ${summary.feeScheduleCount} fee_schedules, ` +
        `${summary.businessProfileCount} business_profiles, ` +
        `${summary.kycReviewCount} kyc_reviews, ${summary.apiKeyCount} api_keys, ` +
        `${summary.adminUserCount} admin_users`,
    );
    console.log(`seed: ledger_entries checksum = ${summary.ledgerChecksum}`);
    console.log("");

    const assertions = buildAssertions(pool, { initialLedgerChecksum: summary.ledgerChecksum });
    const allRealPassed = await runAssertions(assertions);

    if (!allRealPassed) {
      console.error("\nseed: one or more REAL assertions failed");
      process.exitCode = 1;
    } else {
      console.log("\nseed: all REAL assertions passed");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
