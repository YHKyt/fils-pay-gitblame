import { createHash } from "node:crypto";
import { ZERO_FILS, addFils, applyRateFils, subtractFils, toFils, type Fils } from "@filspay/money";
import type { Pool, PoolClient } from "pg";
import { MERCHANT_FIXTURES } from "./fixtures/merchants.js";
import { generateMarchReconciliationFixtures } from "./fixtures/marchReconciliation.js";
import {
  generatePeakDay,
  generateMarketplaceOrdersForMerchant,
  generateInstalmentCaptures,
  generateTransactionsForMerchant,
  type GeneratedCaptureEvent,
  type GeneratedTimelineEvent,
  type GeneratedTransaction,
} from "./fixtures/transactions.js";
import { SEED, createRng } from "./rng.js";

// Password auth, business profiles, and KYC approval for the fixture
// merchants/users. These import the *actual*
// application modules (not a seed-only reimplementation), so seed data is
// produced through the exact same code paths a real signup/approval would
// use — see the module doc-comment on SEED_USER_PASSWORD below and the
// `recordKycReview` call in `generate()`.
import { hashPassword } from "../../apps/api/src/auth/passwords.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { recordKycReview } from "../../apps/api/src/onboarding/review.js";
import { issueApiKey } from "../../apps/api/src/apiKeys/issue.js";

/**
 * The fixed dev password for every seeded merchant_users fixture (all 7
 * across the 3 fixture merchants). Hashed with the real `hashPassword()`
 * (argon2id) before being written to `password_hash` — never written as a
 * raw string. Documented here, in the open, because later testing/manual
 * QA needs to log in as these fixture users; this is seed data for local
 * development and CI only, never a real credential.
 */
export const SEED_USER_PASSWORD = "FilsPaySeed!2026";

/**
 * Fixed dev password for every seeded `admin_users` fixture. Hashed with the
 * real `hashPassword()` (argon2id) before being written, exactly like the
 * merchant fixtures above — never a raw string. Local development and CI
 * only, never a real credential.
 *
 * Deliberately distinct from SEED_USER_PASSWORD so a copy-pasted merchant
 * credential never happens to open the admin plane.
 */
export const SEED_ADMIN_PASSWORD = "FilsPayAdminSeed!2026";

/**
 * One fixture admin per role, so the three-way role boundary
 * (`support` < `finance` < `super_admin`) can actually be exercised by hand:
 * logging in as `support@filspay.test` and hitting a finance-gated route is
 * how you confirm `requireAdminRole` is doing real work.
 *
 * No fixture `admin_audit_log` or `admin_impersonation_grants` rows exist —
 * those tables start empty and are populated only by real use.
 */
const ADMIN_USER_FIXTURES = [
  { email: "support@filspay.test", displayName: "Sam Support", role: "support" },
  { email: "finance@filspay.test", displayName: "Fay Finance", role: "finance" },
  { email: "superadmin@filspay.test", displayName: "Sue Superadmin", role: "super_admin" },
] as const;

/** Transactions generated per ordinary fixture merchant. */
const TRANSACTIONS_PER_MERCHANT = 34;

/**
 * The one fixture merchant that gets a long, real settlement history
 * instead of a single illustrative batch: 60 consecutive trading days of
 * large B2B tickets, each day with its own closed settlement batch. The
 * other merchants stay at the small "one closed batch, one open batch"
 * shape.
 *
 * The 60 days are days -61..-2 relative to SEED_BASE_DATE. The merchant's
 * standard captures that fall on one of those days are settled in that
 * day's batch (one settlement_batches row per merchant and date); the
 * shared per-merchant block below batches the remaining days.
 */
const HIGH_VOLUME_MERCHANT_KEY = "delta-wholesale";
const HIGH_VOLUME_DAYS = 60;
const HIGH_VOLUME_TRANSACTIONS_PER_DAY = 20;
const HIGH_VOLUME_MIN_AMOUNT_FILS = 500_000; // 500.000 BD
const HIGH_VOLUME_MAX_AMOUNT_FILS = 1_500_000; // 1,500.000 BD

/** A fixed "now" the whole seed is generated relative to, so re-running
 *  generate() on a different wall-clock day still produces byte-identical
 *  timestamps. Deliberately not `new Date()`. */
const SEED_BASE_DATE = new Date("2026-09-01T12:00:00Z");

/**
 * Every fixture fee_schedules row (see the comments where they are inserted
 * below). Kept in one list so the rows written to the table and the rates the
 * seed charges its own captures and batches can never disagree: a real
 * capture (capture.ts, getEffectiveMdrBps) and CloseBatch (EffectiveMdrBpsAt)
 * both charge the newest row whose effective_from has arrived, falling back
 * to merchants.mdr_bps.
 */
const FEE_SCHEDULE_FIXTURES: ReadonlyArray<{
  merchantKey: string;
  mdrBps: number;
  effectiveFrom: Date;
  /** Omitted: the row gets the column default, now(). */
  createdAt?: Date;
}> = [
  { merchantKey: "beta-digital", mdrBps: 180, effectiveFrom: new Date("2026-01-01T00:00:00Z") },
  // 2026-09-06T12:00:00Z, five days after SEED_BASE_DATE.
  { merchantKey: "beta-digital", mdrBps: 165, effectiveFrom: new Date(SEED_BASE_DATE.getTime() + 5 * 86_400_000) },
  {
    merchantKey: "alpha-retail",
    mdrBps: 225,
    effectiveFrom: new Date("2026-08-01T00:00:00Z"),
    createdAt: new Date("2026-08-01T00:00:00Z"),
  },
  {
    merchantKey: "alpha-retail",
    mdrBps: 245,
    effectiveFrom: new Date("2026-03-01T00:00:00Z"),
    createdAt: new Date("2026-08-15T00:00:00Z"),
  },
];

/** The rate in force for a fixture merchant at `at`: the fixture schedule row
 *  with the latest effective_from not after `at`, else the merchant's own
 *  mdr_bps. No two fixture rows share an effective_from, so the created_at
 *  tie-break the services apply never comes into play here. */
function fixtureMdrBpsAt(merchantKey: string, fallbackMdrBps: number, at: Date): number {
  let best: { mdrBps: number; effectiveFrom: Date } | undefined;
  for (const row of FEE_SCHEDULE_FIXTURES) {
    if (row.merchantKey !== merchantKey || row.effectiveFrom.getTime() > at.getTime()) continue;
    if (!best || row.effectiveFrom.getTime() > best.effectiveFrom.getTime()) best = row;
  }
  return best ? best.mdrBps : fallbackMdrBps;
}

// Explicitly truncated tables. Every other table (merchant_business_profiles, kyc_documents, merchant_kyc_reviews,
// sessions, otp_challenges, api_keys, payment_links, webhook_endpoints,
// webhook_deliveries, transaction_events, idempotency_keys,
// merchant_balances, merchant_daily_volume, merchant_payout_trends,
// legacy_transactions)
// references merchants, merchant_users, transactions, settlement_batches,
// or outbox_events via a foreign key, so `TRUNCATE ... CASCADE` below
// sweeps them automatically without needing to list them here.
//
// `reporting_outbox_cursor` is the one exception: it carries no foreign
// key to anything (it's a per-consumer watermark, not seed fixture data),
// so CASCADE never reaches it. Without listing it explicitly, a re-seed
// against an already-seeded, already-consumed database would truncate
// outbox_events (RESTART IDENTITY resets its id sequence back to 1) while
// leaving the reporting worker's last_processed_id sitting above every
// freshly-inserted event's id — silently and permanently halting all
// future rollup processing, with no error or crash to surface it. Listed
// here so a re-seed always leaves every outbox consumer's watermark
// consistent with the outbox it now describes.
const TABLES_TO_RESET = [
  "ledger_entries",
  "scheme_export_lines",
  "outbox_events",
  "holds",
  "settlement_batches",
  "transactions",
  "merchant_users",
  "merchants",
  "reporting_outbox_cursor",
  // CSV adjustment imports. Listed explicitly rather than relied on
  // via CASCADE: adjustment_import_rows would be swept by the merchants
  // truncate below, but adjustment_imports itself only references
  // admin_users, so leaving it implicit would make the reset order-
  // dependent on a table listed for an unrelated reason.
  "adjustment_imports",
  "adjustment_import_rows",
  // platform_stats carries no foreign key to merchants — a platform-wide
  // singleton, not per-merchant fixture data — so CASCADE never reaches it
  // either. Listed here (and re-seeded to its zero row below, in the same
  // transaction) so a re-seed always starts the lifetime-volume counter
  // back at zero, exactly like a fresh install.
  "platform_stats",
  // Admin staff identities. Listed explicitly because admin_users has
  // no foreign key to merchants — CASCADE never reaches it — and its `email`
  // is globally unique, so a re-seed that didn't reset it would fail on the
  // fixture insert. CASCADE from here sweeps admin_sessions,
  // admin_otp_challenges, admin_audit_log and admin_impersonation_grants.
  "admin_users",
] as const;

export interface SeedSummary {
  merchantCount: number;
  merchantUserCount: number;
  transactionCount: number;
  ledgerEntryCount: number;
  ledgerGroupCount: number;
  holdCount: number;
  settlementBatchCount: number;
  schemeExportLineCount: number;
  outboxEventCount: number;
  transactionEventCount: number;
  splitChildCount: number;
  feeScheduleCount: number;
  businessProfileCount: number;
  kycReviewCount: number;
  apiKeyCount: number;
  adminUserCount: number;
  ledgerChecksum: string;
}

/** One transaction's captures on one business day: a scheme file line. */
interface SettledCapture {
  transactionId: string;
  amountFils: Fils;
  feeFils: Fils;
}

interface InsertedMerchant {
  merchantId: string;
  ownerUserId: string;
  displayName: string;
}

/**
 * Truncates every seed table (FK-safe: one multi-table TRUNCATE ... CASCADE,
 * so table order doesn't matter, and RESTART IDENTITY resets the BIGSERIAL
 * sequences backing ledger_entries.id / outbox_events.id) and inserts
 * fresh, deterministic rows keyed off SEED. Running this twice in a row
 * against the same fresh schema produces byte-identical data — see the
 * `seed-deterministic` assertion in selfVerify.ts.
 *
 * Takes a `Pool` (not a bare `Client`) because the KYC approval step below
 * calls `recordKycReview()` — the same function the real internal
 * KYC-review endpoint uses — which opens its own transaction via
 * `withTransaction(pool, ...)`. That call happens *after* the main
 * TRUNCATE+insert transaction commits and its client is released, so it
 * never runs nested inside another open transaction on the same
 * connection.
 */
export async function generate(pool: Pool): Promise<SeedSummary> {
  const rng = createRng(SEED);
  const config = loadConfig(process.env);
  const passwordHash = await hashPassword(SEED_USER_PASSWORD, config);
  const adminPasswordHash = await hashPassword(SEED_ADMIN_PASSWORD, config);

  const client = await pool.connect();
  const insertedMerchants: InsertedMerchant[] = [];

  let merchantUserCount = 0;
  let transactionCount = 0;
  let ledgerEntryCount = 0;
  let ledgerGroupCount = 0;
  let holdCount = 0;
  let settlementBatchCount = 0;
  let schemeExportLineCount = 0;
  let outboxEventCount = 0;
  let transactionEventCount = 0;
  let splitChildCount = 0;
  let feeScheduleCount = 0;
  let businessProfileCount = 0;
  let adminUserCount = 0;
  const merchantIdsByKey = new Map<string, string>();

  try {
    await client.query("BEGIN");
    try {
      // Not limited to fixture rows: TRUNCATE ... CASCADE empties these
      // tables and every table that references them (sessions, api_keys,
      // refunds, webhook endpoints, ...), whoever wrote the rows. The CLI
      // (index.ts) refuses to get here on a populated database unless
      // SEED_RESET=1.
      await client.query(`TRUNCATE TABLE ${TABLES_TO_RESET.join(", ")} RESTART IDENTITY CASCADE`);

      // Admin staff fixtures. Ids come from the database's own
      // gen_random_uuid() rather than the seeded rng, deliberately: they are
      // not referenced by any deterministic fixture data, so drawing from
      // the rng here would shift every subsequent fixture uuid and change
      // the ledger checksum for no reason.
      for (const admin of ADMIN_USER_FIXTURES) {
        await client.query(
          `INSERT INTO admin_users (email, password_hash, display_name, role)
           VALUES ($1, $2, $3, $4)`,
          [admin.email, adminPasswordHash, admin.displayName, admin.role],
        );
        adminUserCount += 1;
      }

      for (const fixture of MERCHANT_FIXTURES) {
        const merchantId = rng.uuid();
        await client.query(
          `INSERT INTO merchants (id, display_name, mdr_bps, negotiated_discount_bps, status, test_mode)
           VALUES ($1, $2, $3, $4, 'active', $5)`,
          [
            merchantId,
            fixture.displayName,
            fixture.mdrBps,
            fixture.negotiatedDiscountBps ?? 0,
            fixture.testMode ?? false,
          ],
        );
        merchantIdsByKey.set(fixture.key, merchantId);
        const rateAt = (at: Date): number => fixtureMdrBpsAt(fixture.key, fixture.mdrBps, at);

        const bp = fixture.businessProfile;
        await client.query(
          `INSERT INTO merchant_business_profiles
             (merchant_id, legal_name, registration_number, business_type, country,
              contact_email, contact_phone, address_line1, address_line2, city, postal_code)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            merchantId,
            bp.legalName,
            bp.registrationNumber,
            bp.businessType,
            bp.country,
            bp.contactEmail,
            bp.contactPhone,
            bp.addressLine1,
            bp.addressLine2 ?? null,
            bp.city,
            bp.postalCode ?? null,
          ],
        );
        businessProfileCount += 1;

        let ownerUserId: string | null = null;
        for (const user of fixture.users) {
          const userId = rng.uuid();
          await client.query(
            `INSERT INTO merchant_users (id, merchant_id, email, role, password_hash)
             VALUES ($1, $2, $3, $4, $5)`,
            [userId, merchantId, user.email, user.role, passwordHash],
          );
          merchantUserCount += 1;
          if (user.role === "owner") {
            ownerUserId = userId;
          }
        }
        if (!ownerUserId) {
          throw new Error(`seed: fixture "${fixture.key}" has no owner user`);
        }
        insertedMerchants.push({ merchantId, ownerUserId, displayName: fixture.displayName });

        // A marketplace fixture gets a day-by-day order flow plus the
        // transaction_events capture timeline apps/settlement reads; a
        // sub-merchant of one has no card activity of its own (it is paid
        // out of its parent's settlement, not from its own captures);
        // everyone else gets the standard month of mixed-status activity.
        let transactions: GeneratedTransaction[];
        let ledgerGroups;
        let captureEvents: GeneratedCaptureEvent[] = [];
        if (fixture.marketplaceBusinessDays !== undefined) {
          const generated = generateMarketplaceOrdersForMerchant({
            merchantId,
            merchantKey: fixture.key,
            mdrBps: fixture.mdrBps,
            discountBps: fixture.negotiatedDiscountBps ?? 0,
            businessDayCount: fixture.marketplaceBusinessDays,
            rng,
            baseDate: SEED_BASE_DATE,
          });
          transactions = generated.transactions;
          ledgerGroups = generated.ledgerGroups;
          captureEvents = generated.captureEvents;
        } else {
          const generated = generateTransactionsForMerchant({
            merchantId,
            merchantKey: fixture.key,
            mdrBps: fixture.mdrBps,
            mdrBpsAt: rateAt,
            count: fixture.splitParentKey === undefined ? TRANSACTIONS_PER_MERCHANT : 0,
            rng,
            baseDate: SEED_BASE_DATE,
          });
          transactions = generated.transactions;
          ledgerGroups = generated.ledgerGroups;
        }

        for (const txn of transactions) {
          await client.query(
            `INSERT INTO transactions (id, merchant_id, status, amount_fils, captured_fils, currency, reference, acquirer_reference, occurred_at)
             VALUES ($1, $2, $3, $4, $5, 'BHD', $6, $7, $8)`,
            [
              txn.id,
              txn.merchantId,
              txn.status,
              txn.amountFils,
              txn.capturedFils,
              txn.reference,
              txn.acquirerReference,
              txn.occurredAt,
            ],
          );
          transactionCount += 1;
        }

        for (const group of ledgerGroups) {
          for (const leg of group.legs) {
            await client.query(
              `INSERT INTO ledger_entries
                 (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                group.entryGroupId,
                group.merchantId,
                group.transactionId,
                leg.accountId,
                leg.direction,
                leg.amountFils,
                group.occurredAt,
                group.description,
              ],
            );
            ledgerEntryCount += 1;
          }
          ledgerGroupCount += 1;
        }

        // The capture timeline. actor_type 'system' (and therefore a NULL
        // actor_id) because a seeded capture has no session or API key
        // behind it; metadata carries the same feeFils key
        // recordTransactionEvent writes for a real capture.
        for (const event of captureEvents) {
          await client.query(
            `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, metadata, occurred_at)
             VALUES ($1, 'captured', $2, 'system', $3, $4)`,
            [event.transactionId, event.amountFils, JSON.stringify({ feeFils: event.feeFils }), event.occurredAt],
          );
          transactionEventCount += 1;
        }

        // A handful of holds: one per merchant, against the first
        // authorized-but-not-yet-captured transaction (if any), non-expired
        // relative to the seed's fixed "now".
        const authorizedTxn = transactions.find((t) => t.status === "authorized");
        if (authorizedTxn) {
          await client.query(
            `INSERT INTO holds (id, merchant_id, transaction_id, amount_fils, status, expires_at)
             VALUES ($1, $2, $3, $4, 'active', $5)`,
            [
              rng.uuid(),
              merchantId,
              authorizedTxn.id,
              authorizedTxn.amountFils,
              new Date(SEED_BASE_DATE.getTime() + 3 * 86_400_000),
            ],
          );
          holdCount += 1;
        }

        // Multi-instalment captures: a handful of transactions that were
        // each drawn down over two or three separate capture calls, with
        // the full event timeline and one balanced ledger group per call.
        // Only this merchant gets them — one worked example of the shape is
        // enough. Their events are written with the standard timeline below,
        // once the batch that settles their day exists.
        let instalmentEvents: GeneratedTimelineEvent[] = [];
        if (fixture.key === "alpha-retail") {
          const multiCapture = generateInstalmentCaptures({
            merchantId,
            merchantKey: fixture.key,
            mdrBps: fixture.mdrBps,
            mdrBpsAt: rateAt,
          });

          for (const txn of multiCapture.transactions) {
            await client.query(
              `INSERT INTO transactions (id, merchant_id, status, amount_fils, captured_fils, currency, reference, acquirer_reference, occurred_at)
               VALUES ($1, $2, $3, $4, $5, 'BHD', $6, $7, $8)`,
              [
                txn.id,
                txn.merchantId,
                txn.status,
                txn.amountFils,
                txn.capturedFils,
                txn.reference,
                txn.acquirerReference,
                txn.occurredAt,
              ],
            );
            transactionCount += 1;
          }

          for (const group of multiCapture.ledgerGroups) {
            for (const leg of group.legs) {
              await client.query(
                `INSERT INTO ledger_entries
                   (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                  group.entryGroupId,
                  group.merchantId,
                  group.transactionId,
                  leg.accountId,
                  leg.direction,
                  leg.amountFils,
                  group.occurredAt,
                  group.description,
                ],
              );
              ledgerEntryCount += 1;
            }
            ledgerGroupCount += 1;
          }

          instalmentEvents = multiCapture.events;
        }

        // A standard merchant's captures, by the Asia/Bahrain settlement
        // business day each falls on (the window CloseBatch uses). The daily
        // run has closed every day before SEED_BASE_DATE's own: one closed
        // batch per day. Captures on SEED_BASE_DATE's day are still waiting
        // for that day's (open) batch.
        const openBatchDate = toDateOnlyString(SEED_BASE_DATE);
        const closedDayCaptures = new Map<string, SettledCapture[]>();
        const addClosedDayCapture = (at: Date, capture: SettledCapture): void => {
          const day = bahrainBusinessDate(at);
          if (day >= openBatchDate) return;
          const dayCaptures = closedDayCaptures.get(day) ?? [];
          // CloseBatch writes one line per transaction: a transaction's
          // captures on one day add up into a single line.
          const line = dayCaptures.find((c) => c.transactionId === capture.transactionId);
          if (line) {
            line.amountFils = addFils(line.amountFils, capture.amountFils);
            line.feeFils = addFils(line.feeFils, capture.feeFils);
          } else {
            dayCaptures.push({ ...capture });
          }
          closedDayCaptures.set(day, dayCaptures);
        };
        if (fixture.marketplaceBusinessDays === undefined) {
          for (const txn of transactions) {
            if (txn.capturedFils <= 0) continue;
            addClosedDayCapture(txn.occurredAt, {
              transactionId: txn.id,
              amountFils: txn.capturedFils,
              feeFils: applyRateFils(txn.capturedFils, rateAt(txn.occurredAt)),
            });
          }
          for (const event of instalmentEvents) {
            if (event.amountFils === null) continue;
            addClosedDayCapture(event.occurredAt, {
              transactionId: event.transactionId,
              amountFils: event.amountFils,
              feeFils: event.feeFils ?? ZERO_FILS,
            });
          }
        }
        const batchIdByTransaction = new Map<string, string>();
        const closedBatchNets: Array<{ batchDate: string; netFils: Fils }> = [];

        // The high-volume merchant's long settlement history: one real
        // closed batch per trading day, each with its own transactions,
        // transaction_events (already marked as belonging to that batch,
        // exactly as CloseBatch would leave them), ledger entries and
        // scheme export lines. A day's batch also settles the merchant's
        // standard captures from that day, as CloseBatch would. Every other
        // merchant skips this entirely.
        if (fixture.key === HIGH_VOLUME_MERCHANT_KEY) {
          for (let dayIndex = 0; dayIndex < HIGH_VOLUME_DAYS; dayIndex++) {
            const dayOffset = -(HIGH_VOLUME_DAYS + 1 - dayIndex); // -61 .. -2
            const dayDate = shiftDate(SEED_BASE_DATE, dayOffset);
            const dayDateStr = toDateOnlyString(dayDate);
            const dayBatchId = rng.uuid();

            const { transactions: dayTxns, ledgerGroups: dayLedgerGroups } = generatePeakDay({
              merchantId,
              merchantKey: fixture.key,
              mdrBps: fixture.mdrBps,
              count: HIGH_VOLUME_TRANSACTIONS_PER_DAY,
              minAmountFils: HIGH_VOLUME_MIN_AMOUNT_FILS,
              maxAmountFils: HIGH_VOLUME_MAX_AMOUNT_FILS,
              dateStr: dayDateStr,
              daySequence: dayIndex + 1,
              rng,
            });

            const standardToday = closedDayCaptures.get(dayDateStr) ?? [];
            closedDayCaptures.delete(dayDateStr);

            let dayGross: Fils = ZERO_FILS;
            let dayFee: Fils = ZERO_FILS;
            let dayNet: Fils = ZERO_FILS;
            for (const txn of dayTxns) {
              const fee = applyRateFils(txn.capturedFils, rateAt(txn.occurredAt));
              dayGross = addFils(dayGross, txn.capturedFils);
              dayFee = addFils(dayFee, fee);
              dayNet = addFils(dayNet, subtractFils(txn.capturedFils, fee));
            }
            for (const capture of standardToday) {
              dayGross = addFils(dayGross, capture.amountFils);
              dayFee = addFils(dayFee, capture.feeFils);
              dayNet = addFils(dayNet, subtractFils(capture.amountFils, capture.feeFils));
            }
            closedBatchNets.push({ batchDate: dayDateStr, netFils: dayNet });

            await client.query(
              `INSERT INTO settlement_batches
                 (id, merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
               VALUES ($1, $2, $3, 'closed', $4, $5, $6, $7)`,
              [dayBatchId, merchantId, dayDateStr, dayGross, dayFee, dayNet, dayDate],
            );
            settlementBatchCount += 1;

            let dayLineSequence = 1;
            for (const txn of dayTxns) {
              await client.query(
                `INSERT INTO transactions (id, merchant_id, status, amount_fils, captured_fils, currency, reference, acquirer_reference, occurred_at)
                 VALUES ($1, $2, $3, $4, $5, 'BHD', $6, $7, $8)`,
                [
                  txn.id,
                  txn.merchantId,
                  txn.status,
                  txn.amountFils,
                  txn.capturedFils,
                  txn.reference,
                  txn.acquirerReference,
                  txn.occurredAt,
                ],
              );
              transactionCount += 1;

              // settlement_batch_id is set here, not left NULL: these
              // events are already settled by this fixture's own closed
              // batch, so a real batching pass must never pick them up a
              // second time.
              await client.query(
                `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at, settlement_batch_id)
                 VALUES ($1, 'captured', $2, 'system', $3, $4)`,
                [txn.id, txn.capturedFils, txn.occurredAt, dayBatchId],
              );
              transactionEventCount += 1;

              await client.query(
                `INSERT INTO scheme_export_lines (settlement_batch_id, transaction_id, amount_fils, amount, line_sequence)
                 VALUES ($1, $2, $3, $4, $5)`,
                [
                  dayBatchId,
                  txn.id,
                  toFils(Math.floor(txn.capturedFils / 10) * 10),
                  (Math.floor(txn.capturedFils / 10) * 10) / 1000,
                  dayLineSequence++,
                ],
              );
              schemeExportLineCount += 1;
            }
            for (const capture of standardToday) {
              batchIdByTransaction.set(capture.transactionId, dayBatchId);
              await insertSchemeExportLine(client, dayBatchId, capture.transactionId, capture.amountFils, dayLineSequence++);
              schemeExportLineCount += 1;
            }

            for (const group of dayLedgerGroups) {
              for (const leg of group.legs) {
                await client.query(
                  `INSERT INTO ledger_entries
                     (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                  [
                    group.entryGroupId,
                    group.merchantId,
                    group.transactionId,
                    leg.accountId,
                    leg.direction,
                    leg.amountFils,
                    group.occurredAt,
                    group.description,
                  ],
                );
                ledgerEntryCount += 1;
              }
              ledgerGroupCount += 1;
            }
          }
        }

        // The marketplace fixture's settlement batches are produced by
        // actually running apps/settlement over its seeded capture
        // timeline, day by day — so it gets none of the pre-baked batch
        // below. A sub-merchant with no card activity of its own has
        // nothing to settle either.
        if (fixture.marketplaceBusinessDays !== undefined || transactions.length === 0) {
          continue;
        }

        // Settlement: one closed batch per business day that had captures
        // (each closed the next morning, 00:30 Asia/Bahrain), every line
        // charged the rate in force at its capture, plus the open
        // (still-accumulating) batch for SEED_BASE_DATE's own day.
        const closedDays = [...closedDayCaptures.keys()].sort();
        for (const batchDate of closedDays) {
          const dayCaptures = closedDayCaptures.get(batchDate) ?? [];
          const batchId = rng.uuid();
          let grossFils: Fils = ZERO_FILS;
          let feeFils: Fils = ZERO_FILS;
          let netFils: Fils = ZERO_FILS;
          for (const capture of dayCaptures) {
            grossFils = addFils(grossFils, capture.amountFils);
            feeFils = addFils(feeFils, capture.feeFils);
            netFils = addFils(netFils, subtractFils(capture.amountFils, capture.feeFils));
          }

          await client.query(
            `INSERT INTO settlement_batches
               (id, merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
             VALUES ($1, $2, $3, 'closed', $4, $5, $6, $7)`,
            [batchId, merchantId, batchDate, grossFils, feeFils, netFils, new Date(`${batchDate}T21:30:00Z`)],
          );
          settlementBatchCount += 1;
          closedBatchNets.push({ batchDate, netFils });

          let lineSequence = 1;
          for (const capture of dayCaptures) {
            batchIdByTransaction.set(capture.transactionId, batchId);
            await insertSchemeExportLine(client, batchId, capture.transactionId, capture.amountFils, lineSequence++);
            schemeExportLineCount += 1;
          }
        }

        await client.query(
          `INSERT INTO settlement_batches (id, merchant_id, batch_date, status)
           VALUES ($1, $2, $3, 'open')`,
          [rng.uuid(), merchantId, openBatchDate],
        );
        settlementBatchCount += 1;

        // The timeline a real authorize and capture leave on each standard
        // transaction (authorize.ts, capture.ts). The capture event carries
        // the fee its ledger group journaled, with discountBps, exactly as
        // capture.ts records it, and the id of the batch that settled it, so
        // CloseBatch never settles it again and RecalculateMDR can re-rate
        // the batch from its events. Captures on SEED_BASE_DATE's day stay
        // unbatched for that day's close.
        for (const txn of transactions) {
          await client.query(
            `INSERT INTO transaction_events (transaction_id, event_type, actor_type, occurred_at)
             VALUES ($1, 'authorized', 'system', $2)`,
            [txn.id, txn.occurredAt],
          );
          transactionEventCount += 1;
          if (txn.capturedFils > 0) {
            const fee = applyRateFils(txn.capturedFils, rateAt(txn.occurredAt));
            await client.query(
              `INSERT INTO transaction_events
                 (transaction_id, event_type, amount_fils, actor_type, metadata, occurred_at, settlement_batch_id)
               VALUES ($1, $2, $3, 'system', $4, $5, $6)`,
              [
                txn.id,
                txn.status,
                txn.capturedFils,
                JSON.stringify({ feeFils: fee, discountBps: fixture.negotiatedDiscountBps ?? 0 }),
                txn.occurredAt,
                batchIdByTransaction.get(txn.id) ?? null,
              ],
            );
            transactionEventCount += 1;
          }
          if (txn.status === "voided") {
            // void.ts records the void on the timeline; ten minutes after
            // the authorization, never after the seed's own "now".
            const voidedAt = new Date(Math.min(txn.occurredAt.getTime() + 10 * 60_000, SEED_BASE_DATE.getTime()));
            await client.query(
              `INSERT INTO transaction_events (transaction_id, event_type, actor_type, occurred_at)
               VALUES ($1, 'voided', 'system', $2)`,
              [txn.id, voidedAt],
            );
            transactionEventCount += 1;
          }
        }
        for (const event of instalmentEvents) {
          const settled = event.amountFils !== null && bahrainBusinessDate(event.occurredAt) < openBatchDate;
          await client.query(
            `INSERT INTO transaction_events
               (transaction_id, event_type, amount_fils, actor_type, metadata, occurred_at, settlement_batch_id)
             VALUES ($1, $2, $3, 'system', $4, $5, $6)`,
            [
              event.transactionId,
              event.eventType,
              event.amountFils,
              JSON.stringify(event.feeFils === null ? {} : { feeFils: event.feeFils }),
              event.occurredAt,
              settled ? (batchIdByTransaction.get(event.transactionId) ?? null) : null,
            ],
          );
          transactionEventCount += 1;
        }

        // merchants.lifetime_net_payout_monitoring_estimate (0040) as
        // apps/settlement would have left it: PayoutBatch adds each batch's
        // net payout to the running total as that batch is paid, so the
        // seed replays the same additions in the same chronological order.
        // Math.fround matches the column's `real` precision, so the seeded
        // figure is what a live run of apps/settlement would have left.
        let lifetimeEstimate = Math.fround(0);
        closedBatchNets.sort((a, b) => (a.batchDate < b.batchDate ? -1 : a.batchDate > b.batchDate ? 1 : 0));
        for (const { netFils } of closedBatchNets) {
          lifetimeEstimate = Math.fround(lifetimeEstimate + Math.fround(Number(netFils)));
        }
        await client.query(`UPDATE merchants SET lifetime_net_payout_monitoring_estimate = $2 WHERE id = $1`, [
          merchantId,
          lifetimeEstimate,
        ]);
      }

      // March 2026 capture activity for Alpha Retail Co. Kept in its own
      // fixture module (and its own rng seed) rather than folded into the
      // per-merchant loop above, because its amounts are constructed to a
      // fixed arithmetic target and must not drift when anything else in
      // this loop changes.
      const alphaInserted = insertedMerchants.find((m) => m.displayName === "Alpha Retail Co");
      const alphaFixture = MERCHANT_FIXTURES.find((f) => f.key === "alpha-retail");
      if (!alphaInserted || !alphaFixture) {
        throw new Error("seed: expected Alpha Retail Co to exist for the March reconciliation fixture");
      }

      const marchFixtures = generateMarchReconciliationFixtures({
        merchantId: alphaInserted.merchantId,
        merchantKey: "alpha-retail",
        mdrBps: alphaFixture.mdrBps,
        mdrBpsAt: (at) => fixtureMdrBpsAt("alpha-retail", alphaFixture.mdrBps, at),
      });

      for (const txn of marchFixtures.transactions) {
        await client.query(
          `INSERT INTO transactions (id, merchant_id, status, amount_fils, captured_fils, currency, reference, acquirer_reference, occurred_at)
           VALUES ($1, $2, $3, $4, $5, 'BHD', $6, $7, $8)`,
          [
            txn.id,
            txn.merchantId,
            txn.status,
            txn.amountFils,
            txn.capturedFils,
            txn.reference,
            txn.acquirerReference,
            txn.occurredAt,
          ],
        );
        transactionCount += 1;
      }

      for (const group of marchFixtures.ledgerGroups) {
        for (const leg of group.legs) {
          await client.query(
            `INSERT INTO ledger_entries
               (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              group.entryGroupId,
              group.merchantId,
              group.transactionId,
              leg.accountId,
              leg.direction,
              leg.amountFils,
              group.occurredAt,
              group.description,
            ],
          );
          ledgerEntryCount += 1;
        }
        ledgerGroupCount += 1;
      }

      // Sub-merchant split configuration, inserted after every merchant
      // exists so a parent and its children can be declared in any fixture
      // order. Weights are checked here rather than by the database:
      // db/migrations/0045 can constrain one row's weight, but "a parent's
      // children sum to 10000" spans rows, and whatever writes these rows
      // owns that invariant.
      const splitWeightTotals = new Map<string, number>();
      for (const fixture of MERCHANT_FIXTURES) {
        if (fixture.splitParentKey === undefined) continue;
        const parentId = merchantIdsByKey.get(fixture.splitParentKey);
        const childId = merchantIdsByKey.get(fixture.key);
        const weightBps = fixture.splitWeightBps;
        if (!parentId || !childId || weightBps === undefined) {
          throw new Error(`seed: fixture "${fixture.key}" has an incomplete sub-merchant split configuration`);
        }
        await client.query(
          `INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps)
           VALUES ($1, $2, $3)`,
          [parentId, childId, weightBps],
        );
        splitChildCount += 1;
        splitWeightTotals.set(
          fixture.splitParentKey,
          (splitWeightTotals.get(fixture.splitParentKey) ?? 0) + weightBps,
        );
      }
      for (const [parentKey, total] of splitWeightTotals) {
        if (total !== 10_000) {
          throw new Error(`seed: sub-merchant split weights for "${parentKey}" sum to ${total}, expected 10000`);
        }
      }

      // One merchant carries a second, future-dated fee schedule so the
      // platform's effective-dated fee resolution
      // (apps/api/src/fees/feeSchedule.ts,
      // apps/settlement/internal/settlement/fee_schedule.go) has a real row
      // to resolve against instead of always falling through to
      // merchants.mdr_bps. Every other merchant has zero fee_schedules rows
      // and is entirely unaffected by this table's existence — the fallback
      // path is what all 7 of them exercise. 180 matches this merchant's own
      // MERCHANT_FIXTURES mdr_bps exactly, so nothing any pre-cutover
      // transaction resolves to changes; 165 is the renegotiated rate that
      // takes over at the cutover instant.
      // A second merchant carries fee_schedules rows whose insertion order
      // (created_at) doesn't match their effective order (effective_from) —
      // the ordinary result of a real-world data-entry sequence, not a
      // contrived state. alpha-retail's rate dropped to 225bps effective
      // 2026-08-01, entered the same day. Two weeks later, during an
      // unrelated data-quality cleanup, an admin discovered the *original*
      // onboarding-era rate had been recorded wrong in a legacy import and
      // backfilled a correction for the period it actually covered
      // (2026-03-01 onward) — entered 2026-08-15, after the August
      // renegotiation row already existed.
      // The rows themselves are FEE_SCHEDULE_FIXTURES, the same list the
      // seeded captures and closed batches above are charged from.
      for (const row of FEE_SCHEDULE_FIXTURES) {
        const scheduleMerchantId = merchantIdsByKey.get(row.merchantKey);
        if (!scheduleMerchantId) {
          throw new Error(`seed: ${row.merchantKey} fixture is required for the fee_schedules fixture`);
        }
        await client.query(
          `INSERT INTO fee_schedules (merchant_id, mdr_bps, effective_from, created_at)
           VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()))`,
          [scheduleMerchantId, row.mdrBps, row.effectiveFrom.toISOString(), row.createdAt?.toISOString() ?? null],
        );
        feeScheduleCount += 1;
      }

      // Re-establish the single zero row TRUNCATE just removed.
      await client.query(`INSERT INTO platform_stats (id, total_processed_fils) VALUES (1, 0)`);

      // The five transactions the pre-launch invoicing-tool import is keyed
      // to. Picked live, now that every other table that can reference
      // transactions.id (ledger_entries, holds, scheme_export_lines,
      // transaction_events, payment_links, refunds,
      // acquirer_callback_notes) is fully populated for this run — a
      // transaction already referenced by any of those is already
      // FK-protected regardless of this table, which would leave this FK's
      // own block permanently masked behind one of those far more obvious
      // ones. Alpha Retail's authorized-and-never-captured/voided
      // transactions are the only ones guaranteed to carry none of the
      // above.
      const alphaRetailIdForLegacy = merchantIdsByKey.get("alpha-retail");
      if (!alphaRetailIdForLegacy) {
        throw new Error("seed: alpha-retail fixture is required for the legacy_transactions fixture");
      }
      const legacyCandidates = await client.query<{ id: string }>(
        `SELECT t.id
           FROM transactions t
          WHERE t.merchant_id = $1
            AND t.status IN ('authorized', 'voided')
            AND NOT EXISTS (SELECT 1 FROM ledger_entries le WHERE le.transaction_id = t.id)
            AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.transaction_id = t.id)
            AND NOT EXISTS (SELECT 1 FROM scheme_export_lines sel WHERE sel.transaction_id = t.id)
            AND NOT EXISTS (SELECT 1 FROM transaction_events te WHERE te.transaction_id = t.id)
            AND NOT EXISTS (SELECT 1 FROM payment_links pl WHERE pl.transaction_id = t.id)
            AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.transaction_id = t.id)
            AND NOT EXISTS (SELECT 1 FROM acquirer_callback_notes acn WHERE acn.transaction_id = t.id)
          ORDER BY t.id
          LIMIT 5`,
        [alphaRetailIdForLegacy],
      );
      if (legacyCandidates.rows.length < 5) {
        throw new Error(
          `seed: expected at least 5 alpha-retail transactions free of every other transactions.id-referencing table, found ${legacyCandidates.rows.length}`,
        );
      }
      for (const [index, row] of legacyCandidates.rows.entries()) {
        await client.query(
          `INSERT INTO legacy_transactions (original_transaction_id, legacy_reference)
           VALUES ($1, $2)`,
          [row.id, `INV-2025-${String(index + 1).padStart(4, "0")}`],
        );
      }

      // Outbox events for the seeded history, derived from the rows above in
      // this same transaction. apps/reporting builds the merchant analytics
      // only from the outbox (live and in its `rebuild` replay), so one
      // hand-picked event per merchant left the dashboards showing a handful
      // of the seeded captures and closed batches. Payloads are
      // the exact shapes capture.ts and CloseBatch enqueue. created_at is
      // when the capture or close happened, so reporting buckets each one on
      // its own Asia/Bahrain day, and the webhook dispatcher (which only
      // delivers events newer than an endpoint) never replays seed history.
      const capturedOutbox = await client.query(
        `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload, created_at)
         SELECT 'transaction.captured', 'transaction', te.transaction_id,
                jsonb_build_object(
                  'merchantId', t.merchant_id,
                  'amountCapturedFils', te.amount_fils,
                  'feeFils', COALESCE((te.metadata->>'feeFils')::bigint, 0),
                  'newStatus', te.event_type,
                  'capturedTotalFils', SUM(te.amount_fils) OVER (PARTITION BY te.transaction_id ORDER BY te.occurred_at, te.id)),
                te.occurred_at
           FROM transaction_events te
           JOIN transactions t ON t.id = te.transaction_id
          WHERE te.event_type IN ('captured', 'partially_captured')
          ORDER BY te.occurred_at, te.id`,
      );
      outboxEventCount += capturedOutbox.rowCount ?? 0;

      const batchClosedOutbox = await client.query(
        `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload, created_at)
         SELECT 'settlement.batch_closed', 'settlement_batch', sb.id,
                jsonb_build_object(
                  'merchantId', sb.merchant_id,
                  'batchId', sb.id,
                  'batchDate', to_char(sb.batch_date, 'YYYY-MM-DD'),
                  'grossFils', sb.gross_fils,
                  'feeFils', sb.fee_fils,
                  'netPayoutFils', sb.net_payout_fils),
                COALESCE(sb.closed_at, sb.created_at)
           FROM settlement_batches sb
          WHERE sb.status IN ('closed', 'paid')
          ORDER BY COALESCE(sb.closed_at, sb.created_at), sb.id`,
      );
      outboxEventCount += batchClosedOutbox.rowCount ?? 0;

      // One transaction.voided per seeded void, with void.ts's payload, dated
      // when the void happened (enqueueEvent would stamp the wall clock at
      // seed time, so reporting counted every seeded void on the day the
      // seed ran).
      const voidedOutbox = await client.query(
        `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload, created_at)
         SELECT 'transaction.voided', 'transaction', te.transaction_id,
                jsonb_build_object('merchantId', t.merchant_id),
                te.occurred_at
           FROM transaction_events te
           JOIN transactions t ON t.id = te.transaction_id
          WHERE te.event_type = 'voided'
          ORDER BY te.occurred_at, te.id`,
      );
      outboxEventCount += voidedOutbox.rowCount ?? 0;

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
  }

  const ledgerChecksum = await computeLedgerChecksum(pool);

  // KYC approval: routed through the real recordKycReview() — the single
  // write path allowed to set merchants.kyc_passed / onboarding_status to
  // 'approved' — never a direct UPDATE, so seed data is not an exception to
  // that invariant. Runs after the main transaction above has committed
  // (recordKycReview opens its own transaction via the pool).
  let kycReviewCount = 0;
  let apiKeyCount = 0;
  for (const merchant of insertedMerchants) {
    await recordKycReview(pool, {
      merchantId: merchant.merchantId,
      outcome: "approved",
      reviewerIdentifier: "seed",
      notes: "Seeded as pre-approved so downstream fixtures can exercise post-onboarding flows.",
    });
    kycReviewCount += 1;

    const issued = await issueApiKey(pool, config, {
      merchantId: merchant.merchantId,
      createdBy: merchant.ownerUserId,
      label: "seed default key",
    });
    apiKeyCount += 1;
    // Never the raw key: on the hosted stack this output is the seed job's
    // container log, and a raw key there is a live credential for anyone
    // who can read the logs (and NODE_ENV=production issues fp_live_ keys).
    // The prefix is the display-safe part api_keys stores. An owner issues
    // a usable key with POST /v1/merchants/:merchantId/api-keys. The
    // merchant id is printed because the merchant login asks for it.
    console.log(
      `seed: ${merchant.displayName}: merchant id ${merchant.merchantId}, API key ${issued.prefix}... issued (not printed)`,
    );
  }

  return {
    merchantCount: MERCHANT_FIXTURES.length,
    merchantUserCount,
    transactionCount,
    ledgerEntryCount,
    ledgerGroupCount,
    holdCount,
    settlementBatchCount,
    schemeExportLineCount,
    outboxEventCount,
    transactionEventCount,
    splitChildCount,
    feeScheduleCount,
    businessProfileCount,
    kycReviewCount,
    apiKeyCount,
    adminUserCount,
    ledgerChecksum,
  };
}

/** One scheme file line: the captured amount quantized down to the nearest
 *  10 fils (2 decimal places), same as the real exporter. */
async function insertSchemeExportLine(
  client: PoolClient,
  batchId: string,
  transactionId: string,
  capturedFils: Fils,
  lineSequence: number,
): Promise<void> {
  const quantized = toFils(Math.floor(capturedFils / 10) * 10);
  await client.query(
    `INSERT INTO scheme_export_lines (settlement_batch_id, transaction_id, amount_fils, amount, line_sequence)
     VALUES ($1, $2, $3, $4, $5)`,
    [batchId, transactionId, quantized, quantized / 1000, lineSequence],
  );
}

/** The Asia/Bahrain (UTC+3, no DST) calendar date of an instant: the
 *  settlement business day BusinessDayWindow puts it in. */
function bahrainBusinessDate(at: Date): string {
  return toDateOnlyString(new Date(at.getTime() + 3 * 60 * 60 * 1000));
}

function shiftDate(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 86_400_000);
}

/** Renders a Date as a plain "YYYY-MM-DD" string (UTC calendar date), so a
 *  `date`-typed column is never left to Postgres's session timezone to
 *  interpret a timestamptz-shaped parameter. */
function toDateOnlyString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * A deterministic checksum over every ledger_entries row, ordered by id.
 * Every field folded in (including the id and every uuid) is itself
 * generated deterministically from the seeded rng, so two fresh runs of
 * `generate()` with the same SEED produce an identical checksum.
 */
export async function computeLedgerChecksum(pool: Pool | PoolClient): Promise<string> {
  const result = await pool.query<{
    id: string;
    entry_group_id: string;
    merchant_id: string;
    transaction_id: string | null;
    settlement_batch_id: string | null;
    account_id: string;
    direction: string;
    amount_fils: string;
    occurred_at: Date;
  }>(
    `SELECT id, entry_group_id, merchant_id, transaction_id, settlement_batch_id,
            account_id, direction, amount_fils, occurred_at
       FROM ledger_entries
      ORDER BY id`,
  );

  const hash = createHash("sha256");
  for (const row of result.rows) {
    hash.update(
      [
        row.id,
        row.entry_group_id,
        row.merchant_id,
        row.transaction_id ?? "",
        row.settlement_batch_id ?? "",
        row.account_id,
        row.direction,
        row.amount_fils,
        row.occurred_at.toISOString(),
      ].join("|"),
    );
    hash.update("\n");
  }
  return hash.digest("hex");
}

export type { GeneratedTransaction };
