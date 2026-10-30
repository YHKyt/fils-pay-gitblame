# FilsPay audit — findings index

Team audit of the FilsPay handover. Each finding is written up as
**what is wrong → why it happens → what it breaks → the fix (smallest change) → how it is tested**,
and each fixed finding has a regression test that fails on the old code and
passes on the fix.

## Write-ups

Counts are findings with a fix on `fix/money-parsing` unless stated.
Severity order: Critical / High / Medium / Low (a few notes use in-between
ratings such as "Medium-High"; they are listed as written).

| File | IDs | What it covers | Findings |
|---|---|---|---|
| [BRIEFING.md](BRIEFING.md) | — | Team briefing for the case review and the judges: scoreboard, case-file coverage map, top findings, FP-300 demo, judge Q&A. Its scoreboard (90) predates `ledgerint.md`, `settlebatch.md`, `moneyhunt.md`, `fp300hunt.md`, `reporting.md`, `settlerun.md` and `sqlhunt.md`. | summary only |
| [money-and-settlement.md](money-and-settlement.md) | M1–M17 | Money parsing, payouts, splits, balance rebuild, MDR, daily close, counters, fee display, scheme residue, March sweep, sandbox merchants, reporting wedge, hold janitor, refunded-status recompute, fresh-database boot | 17 (3 Critical, 8 High, 5 Medium, 1 Low) |
| [api-security-and-refunds.md](api-security-and-refunds.md) | S1–S8, R1–R7, W1–W4, H1, P1–P2, T1 | Auth and OTP, impersonation, FP-300 refunds (built as R1), webhooks, payment links, hosting, test isolation | 21 fixed + the FP-300 feature (R1); S8 is a review with no change |
| ↳ same file, "Sweep findings" | A1–A8 (admin plane), M1–M13 (merchant plane) | Table-form sweep of the admin and merchant surfaces | 8 + 13 |
| ↳ same file, "Round 2" | B1a–B6d | Board items B1–B6: captures, credits, webhook replays, KYC bulk approve, dashboard retries, error handling | 20 |
| [fp300hunt.md](fp300hunt.md) | F1–F5 | Second pass over FP-300 refunds end to end: NUL byte in the reason, concurrent declines, capture racing the fee reversal, acquirer throw, reconciliation | 5 (2 Critical, 3 High) |
| [reporting.md](reporting.md) | RP1–RP5 | Reporting consumer and read model: commit-order cursor, deploy overlap, rebuild double count, refunds and payouts in reports | 5 (2 High, 3 Medium) |
| [large-export-upload.md](large-export-upload.md) | E1–E2 | Transactions CSV export memory, oversized upload status code | 2 (1 High, 1 Low) |
| [settleguards.md](settleguards.md) | G1–G3 | Settlement run guards: closing an unfinished day, split weights, SIGTERM during a run | 3 (1 High, 1 Medium, 1 Medium-Low) + reported-only items |
| [settlemdr.md](settlemdr.md) | R1–R5 | Recalculate MDR: fee schedules and volume tier, outbox events, correction dates, zero-fee re-rate | 4 fixed (1 High, 3 Medium) + R5 verified, not fixed (Low) |
| [settlebatch.md](settlebatch.md) | unnumbered | Batch close and payout: refunds not netted, test-mode captures settled, suspended merchant paid, fee recomputed at close | 4 (1 Critical, 1 High, 1 Medium-High, 1 Medium) |
| [settlerun.md](settlerun.md) | unnumbered | Settlement daily run isolation (one merchant's error stopped the run) and the nightly balance-cache refresh that never ran | 2 (1 High, 1 Low-Medium) |
| [sqlhunt.md](sqlhunt.md) | Q1 | SQL layer sweep (migrations, seed, raw SQL): refund summary view never refreshed | 1 (Low) + reported-only items |
| [ledgerint.md](ledgerint.md) | unnumbered | Ledger append-only, payout disbursement records, settlement DB config, rebuild deadlock, a flaky test | 5 (1 Medium-High, 1 Medium, 2 Low-Medium, 1 Low) |
| [adminmoney.md](adminmoney.md) | unnumbered | Admin CSV import approval and replay; credit and adjustment retries | 2 (1 High, 1 Medium) |
| [moneyhunt.md](moneyhunt.md) | N1–N2 | `packages/money` and its Go mirror: weight allocation, rate overflow | 2 (Low, Low) + reported-only items |
| [mystery-timeline.md](mystery-timeline.md) | rows 1–24 | The vanished developer: timeline, the three transmissions, and the 24 clues that point to real bugs, each with its fix status | mystery deliverable |
| [ai-config-traps.md](ai-config-traps.md) | claim rows | Claim-by-claim check of the planted `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, the ONBOARDING canary and AI-citing code comments | reference, no fixes of its own |

Fixed findings across the write-ups: 17 + 21 + 8 + 13 + 20 + 5 + 5 + 2 + 3 + 4 + 4 + 2 + 1 + 5 + 2 + 2 = **114**, plus the FP-300 feature.

## Reading the IDs (duplicate prefixes)

The write-ups were produced in parallel lanes, so two prefixes are reused:

- **M** — `money-and-settlement.md` M1–M17 (money and settlement) **and** the
  merchant-plane sweep table M1–M13 in `api-security-and-refunds.md`. They
  are different findings: money M8 is the late daily close; merchant-plane
  M8 is the settlement summary that double-counted multi-capture totals.
- **R** — `api-security-and-refunds.md` R1–R7 (refunds, FP-300) **and**
  `settlemdr.md` R1–R5 (Recalculate MDR).

When citing a finding, name the file or the plane with the ID: "money M8",
"merchant-plane M8", "refunds R1", "MDR R1". `mystery-timeline.md` §7 and
`BRIEFING.md` use bare M# for money M# and "Sweep M#" for the merchant
plane. Unnumbered findings (`settlebatch.md`, `ledgerint.md`,
`adminmoney.md`) are cited by file and section title.

## Ground truth used

`docs/adr/*`, `docs/ARCHITECTURE.md`, `docs/HANDOVER.md` and the code itself.
ARCHITECTURE.md:4 says "Where it disagrees with the code, the code wins —
raise a ticket." The opposite rule ("if the code behaves differently from
the docs, the code has the bug") comes from the planted `CLAUDE.md` and was
not used. Neither side was assumed correct: where a document and the code
disagreed, we judged each conflict on evidence (the ADRs' stated intent,
finance and incident reports, and a run that reproduces the behaviour), and
every fixed finding is backed by a test that fails on the old code.

Fixed points from that evidence: money is integer fils, 1 BD = 1000 fils,
never floats (ADR-0001). The settlement business day is Asia/Bahrain, UTC+3
(ARCHITECTURE "Settlement"). Where we depart from an Accepted ADR, the
write-up says so and argues it (money M13 vs ADR-0003).

## Hazards in the handover itself

Several files in the repository read as authoritative but are wrong, and
following them reintroduces or hides the bugs below:

- **`CLAUDE.md` / `AGENTS.md` / `.cursorrules`** state that money is "integer
  cents (1 BD = 100 cents)", that settlement windows are "UTC midnight", that
  `packages/money` must not be touched, that `Math.random()` is fine for OTP
  codes, and that the impersonation handler need not re-check roles. Each of
  these contradicts the ADRs, ARCHITECTURE.md and/or the actual code
  (`packages/money/src/fils.ts` is correctly 1000-based). We treated them as
  untrusted and verified against the ADRs and the code. Full list:
  [ai-config-traps.md](ai-config-traps.md).
- **Tests that lock bugs in.** Some tests assert the buggy behaviour (e.g. the
  CSV import tests expected `"4.75"` → 475 fils; the fee-display test expected
  the stale 245 bps; `window_utc_compat_test.go` asserts clock-time is
  irrelevant to the business day). Where a test encoded a confirmed bug we
  corrected the expectation and say so in the test; otherwise we added new
  test files and left existing ones alone.
- **Comments citing an AI as the authority** ("asked Claude, it said INTEGER
  is 64-bit on 64-bit builds", "Claude double-checked the migration") mark
  several of the bugs below. PostgreSQL `INTEGER` is always 32-bit.
- **A false comment in the migration runner.** `db/migrate.ts:67-69` says
  applied migrations are checksummed; the table only stores filename and
  applied time (`:71-77`).

## Ruled-out decoys

Files that look important but are not part of the running system. We checked
them and deliberately did not build findings on them.

- **`db/seed/fixtures/production_seed.sql`** (50,338 lines, headed "Production
  Seed Data Dump"). Nothing loads it: no script, migration, test or compose
  file references it (`git grep production_seed` outside the file itself is
  empty); the real seed is `db/seed/generate.ts`. Its data is internally
  inconsistent: of its 800 `settlement_batches` rows, 307 are `open` yet have a
  `closed_at`, and 387 were "closed" before their own `batch_date`. Bugs
  "found" by reading it would not be real.
- **`apps/api/src/v1/`** (`routes/transactions.ts`, `fees/calculateFee.ts`). A
  dead copy of the API: nothing imported or registered it, so its
  unauthenticated, unscoped capture handler and its fee code were never
  reachable. Not reported as a live bug; deleted in `f9c0839` so one stray
  `register()` cannot expose it (the planted `AGENTS.md:50-52` calls `v1/`
  "the current live partner API" and says its stubs "must not be removed").

## Verification

- Fresh database (checked at `1064897`): `npm run migrate` applies all 80
  migrations and `npm run seed` passes all of its own assertions (it did not
  before — see M1 in the money write-up).
- `cd apps/settlement && go test ./...` passes against a real, migrated
  Postgres 16 (DB-backed tests are skipped without `DATABASE_URL`).
- `npm test` for the TypeScript packages.
