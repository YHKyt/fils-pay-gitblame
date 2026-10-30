# Money, settlement, balances and boot — findings

Severity: **Critical** = money moved or recorded wrongly at scale ·
**High** = wrong money for affected merchants, or nothing can run ·
**Medium** = reconciliation/pricing wrong · **Low** = monitoring only.

---

## M1. Fresh database cannot migrate or seed — High
**Where:** `db/migrations/0054_views.sql`, `db/migrations/0055_chart_of_accounts_suspense.sql`, `apps/api/src/config.ts`

- **What:** `docker compose up` / `npm run migrate` + `npm run seed` fail on a new database, so the system as handed over cannot be started.
- **Why:**
  - `0054` defines `v_unbatched_capture_events` with a join to `settlement_batch_events`, a table no migration creates. Batch membership is actually `transaction_events.settlement_batch_id` (0023).
  - `0055` inserts into `chart_of_accounts (code, account_type, description)` with kind `'suspense'`. The table (0007) is `(id, name, kind)` and `kind` must be asset/liability/revenue.
  - The dev fallback `WEBHOOK_SECRET_ENCRYPTION_KEY` is base64 of a 34-byte string, but `loadConfig` requires exactly 32 bytes, so the api and seed throw on startup outside production.
- **Breaks:** every fresh environment (local, CI, a new hosted box).
- **Fix:** view uses `te.settlement_batch_id IS NULL`; 0055 rewritten to the real schema (suspense modelled as `asset`, as 0007 already does for `scheme_rounding_residue`); a valid 32-byte dev-only key. Editing the two files in place is safe because neither could have applied anywhere (both error), so no database has them recorded as applied. (The runner tracks applied files by filename only, `db/migrate.ts:71-77`; the comment above it claiming a per-file checksum guard is wrong, so there is no guard to trip either way.)
- **Test:** migrate applies 68/68 and seed's own assertions pass on an empty Postgres 16.

## M2. Every refund created without a reason fails — High
**Where:** `apps/api/src/payments/processRefund.ts`

- **What:** refunds without an explicit reason are rejected with `chk_refunds_reason_not_null`.
- **Why:** migration 0070 made `reason` NOT NULL (CHECK) with `DEFAULT 'unspecified'`, but a column DEFAULT only applies when the column is omitted. The code passes `input.reason ?? null` — an explicit NULL — so the CHECK fires.
- **Breaks:** the refund feature (FP-300) for the common case.
- **Fix:** pass `'unspecified'` when no reason is given.
- **Test:** the existing refund suites (24 tests) go from failing to passing.

## M3. CSV balance-adjustment import is 10× too small — Critical
**Where:** `apps/api/src/admin/adjustmentCsvParsing.ts` (and `payments/discountAdjustment.ts`)
**Evidence:** Finance weekly — "uploaded 4.75 BD and it shows 0.475"; commit `9567ea0` "the csv import is 10x off".

- **What:** an uploaded `4.75` became 475 fils (0.475 BD) instead of 4750.
- **Why:** the importer used `parseDecimalMinor(raw)`, whose default is **2** decimals ("cents"). BHD has **3** (ADR-0001). The promotional-discount parser had the same bug plus a `parseFloat`, i.e. a float on a money path.
- **Breaks:** every manual ledger adjustment posted through the importer, and merchant balances with them.
- **Fix:** both parsers use the canonical `parseBhdToFils` (string → integer fils, 3 decimals, rejects more). Negative adjustments still work.
- **Test:** new `adjustmentCsvParsing.fix.test.ts`. The existing import tests asserted `"4.75"` → 475 and a total of 600 — they encoded the bug ("MK said it is in the tests"); corrected to 4750 / 6000 with a note.

## M4. Net payout computed through float32 — High
**Where:** `apps/settlement/internal/settlement/payable.go`

- **What:** the amount paid out for a batch could be a few fils wrong.
- **Why:** `NetPayableFils` computed `float32(gross)/1000 - float32(fee)/1000` and rounded back. float32 keeps ~7 significant digits; above ~10,000 BD it cannot represent the fils digit. In a sweep of batches between 10,000 and 60,000 BD, about two thirds came out wrong, by up to 6 fils, and the error grows with batch size.
- **Breaks:** the money actually disbursed to large merchants, every day.
- **Fix:** `return grossFils - feeFils`.
- **Test:** `payable_test.go` (large values exact).

## M5. Split payouts do not add up to the parent — High
**Where:** `apps/settlement/internal/splits/allocate.go`, `shares.go`
**Evidence:** Finance — Delta Marketplace child payouts "don't add up to the parent's total … every batch since launch".

- **What:** sub-merchant shares summed to more or less than the batch net payout.
- **Why:** each child share was rounded independently (`ApplyRateFils` per child). Independent rounding does not preserve the total: 1001 fils over 3333/3333/3334 bps paid 334+334+334 = **1002**; other splits paid less. The difference was never posted, so short splits left fils stranded in the parent's `merchant_payable` ("can't find them anywhere in the ledger").
- **Breaks:** every split batch.
- **Fix:** `ChildShares` floors each exact share and gives the leftover fils to the largest remainders (ties to the lower index); `PayoutSplitBatch` uses it. When weights sum to 10000 the children receive exactly the net payout; partial weights leave the remainder with the parent as before.
- **Test:** `shares_exact_test.go` (non-round splits, partial weights). The original test only used splits that happen to divide evenly.

## M6. "Rebuild cached balances" button reads the wrong source (FP-203) — High
**Where:** `apps/settlement/internal/ledger/refresh.go`
**Evidence:** Finance / FP-203 — Alpha Retail went from 135K to 7K on a click; the CLI rebuild gave the right number.

- **What:** the console button overwrote merchant balances with a different quantity from the one the cache holds.
- **Why:** `cached_payable_fils` caches the `merchant_payable` ledger account (captures − fees − refunds − payouts + adjustments, settled or not). The button rebuilt it from `merchant_payable_position`, a view over `scheme_export_lines` — the truncated card-scheme gross of settled batches only. ADR-0004 moved the button there because the CLI's per-merchant ledger walk was too slow for a 30 s request; ARCHITECTURE.md says the button "triggers the same refresh" as the CLI, and the handover says no button should read anything but the ledger.
- **Breaks:** any merchant balance the button touches; manual corrections are also wiped.
- **Fix:** rebuild from `ledger_entries` exactly like the CLI, as **one set-based aggregate** so it stays fast enough for the request (keeps ADR-0004's motivation, fixes its source).
- **Test:** new test proving button == CLI when the ledger holds activity the scheme export does not (135,000 captured − 7,000 refund = 128,000 both ways). The refresh test helper now posts the batch's ledger credit, as a real close does.

## M7. MDR recalculation rewrites already-paid batches — High
**Where:** `apps/settlement/internal/settlement/recalculate_mdr.go`
**Evidence:** Finance — "MDR recalculation changed batches that were already paid out … I'm seeing changes on closed ones too."

- **What:** a rate change re-derived and rewrote `fee_fils` / `net_payout_fils` on paid batches.
- **Why:** the scan selected `status <> 'open'`, which includes `'paid'`. The function's own doc ("closed batches") and `BatchAdjustment` ("the original batch's figures stay as they were paid") say otherwise.
- **Breaks:** the record of money already disbursed; the correction is posted against a batch that will never be paid again.
- **Fix:** `status = 'closed'`.
- **Test:** `recalculate_mdr_paid_test.go` (DB-backed).

## M8. Daily close fires about three hours late (daemon reads the UTC date) — Medium
**Where:** `apps/settlement/internal/scheduler/daemon.go`
**Evidence:** group chat — "the daily close is running at 3am local, not midnight"; ARCHITECTURE: business day is Asia/Bahrain.

- **What:** the daemon closed each business day about three hours late (at the first poll after 00:00 UTC, i.e. from 03:00 Bahrain, instead of 00:15; the ops log comment reports ~03:15). The day it closed, and that day's window, were always correct.
- **Why:** it read `time.Now().UTC()` and passed it to `BusinessDayWindow`, which takes the calendar date from the instant's own location. From 21:00 to 24:00 UTC (00:00 to 03:00 Bahrain) the UTC date is still the previous day, so "yesterday" resolved to the day before the one that had just ended. That day was already closed, so the run was a no-op (CloseBatch is idempotent). The day that had just ended was only picked up once the UTC date rolled over at 00:00 UTC, i.e. 03:00 Bahrain. Its window was still the correct Bahrain window `[D-1 21:00Z, D 21:00Z)`, because `BusinessDayWindow` always builds the boundaries in Asia/Bahrain. The code comment "UTC here is fine, BusinessDayWindow converts to Bahrain" is wrong — it converts the boundaries, not the date it is given.
- **Breaks:** close and payout timing only: the 00:15 run (15-minute default delay after Bahrain midnight) became ~03:00 or later, so payouts and the scheme file were three hours late every day. No transaction was put in the wrong settlement day. (An earlier version of this note said the daemon "closed the wrong business day"; that overstated it.)
- **Fix:** read the clock in the business timezone (`settlement.BusinessLocation()`); `BusinessDayWindow` and its tests unchanged.
- **Test:** `window_bahrain_test.go`. (`window_utc_compat_test.go` asserts the buggy "clock time is irrelevant" behaviour; fixing at the call site leaves it green rather than rewriting it.)

## M9. Platform volume counter overflows and the volume discount switches itself off — Medium
**Where:** `db/migrations/0073_platform_stats_bigint.sql`, `apps/settlement/internal/settlement/platform_volume.go`, `apps/api/src/fees/platformVolumeTier.ts`

- **What:** shortly after lifetime volume reaches the 0.15% discount threshold, the discount turns back off.
- **Why:** `platform_stats.total_processed_fils` is `INTEGER` (0049) and Go held it in `int32`. The threshold is 2,000,000,000 fils; `int32` max is 2,147,483,647. Go does not trap overflow, so `current + int32(gross)` wrapped negative ~147K BD later and the tier test failed again. (A comment says "asked Claude — INTEGER is 64-bit on 64-bit builds"; it is always 32-bit.)
- **Breaks:** consistent pricing for every merchant around the tier.
- **Fix:** migration 0073 to `BIGINT`, `int64` in Go, and the API converts node-pg's BIGINT string.
- **Test:** `platform_volume_int64_test.go` (values above int32 max).
- **Pricing decision needed.** The discount itself has no recorded finance sign-off. The handover says "I said no until finance signs off in writing" (HANDOVER.md:38-39), and the threshold's "approved by finance" comment is challenged in the code itself: "which finance ticket? cant find one. Huda didnt know about it" (`platformVolumeTier.ts:3-4`). Before our fix the overflow switched the discount off again ~147K BD after it switched on; after it, the 0.15% discount applies consistently to every merchant once lifetime volume passes 2,000,000 BD. We fixed the counter, not the policy: finance must confirm the tier exists (or it should be disabled) before this ships. It is not approved by this audit.

## M10. Lifetime payout estimate stored as a 32-bit float — Low
**Where:** `db/migrations/0074_lifetime_payout_estimate_bigint.sql`, `payout_estimate.go`
**Evidence:** group chat — "lifetime payout estimate drifts for high-volume merchants".

- **What / why:** `merchants.lifetime_net_payout_monitoring_estimate` is `REAL` and the delta was sent as `float32`; past 2^24 fils a payout added to the running total rounds away. Monthly estimate also accumulated in float32. Money in floats violates ADR-0001.
- **Fix:** migration 0074 to `BIGINT` (existing values rounded); integer delta; int64 accumulation.

## M11. Merchant dashboard shows a different fee from the one charged — Medium
**Where:** `apps/api/src/fees/currentFeeScheduleDisplay.ts`, `apps/settlement/internal/settlement/fee_schedule.go`
**Evidence:** Finance — "fee shown in the merchant dashboard … 245 bps, but payments go through at 225 bps … one was a backfill fix."

- **What:** the dashboard showed 245 bps while capture and settlement billed 225 bps.
- **Why:** display picked the most recently *entered* schedule (`ORDER BY created_at DESC`). Billing picks the one *in effect* (`effective_from <= now`). A correction backdated to March but entered in August therefore "won" the display. Separately, schedules sharing an `effective_from` (nothing makes them unique) tie-broke by `created_at DESC` in the API but arbitrarily in settlement, so the two could compute different fees.
- **Fix:** display resolves the in-effect row exactly like billing; settlement orders ties by `created_at` so the newest entry wins on both sides.
- **Test:** the display test that asserted 245 now asserts 225 (it encoded the bug).

## M12. Scheme file over-reports and the rounding residue is never journalled — Medium
**Where:** `apps/settlement/internal/settlement/batch.go`, `scheme_export.go`
**Evidence:** Finance — "the scheme statement total is always a few fils higher than ours … always over, never under"; ADR-0002; handover "nothing posts residue yet".

- **What:** the scheme received slightly larger amounts than we booked, on every line, and the truncated-off fils were never recorded.
- **Why:** `scheme_export_lines.amount` (what the file sends) was set from the *untruncated* gross as a `float64`; Postgres rounded it half-up into `numeric(10,2)` — 4747 fils went out as **4.75** while `amount_fils` booked **4740**. Rounded ≥ truncated on every line, hence "always over, never under". ADR-0002 is marked "implemented", but no code posted the residue.
- **Breaks:** scheme reconciliation never ties; residue sits unexplained in `card_scheme_clearing`.
- **Fix:** `amount` = exactly `amount_fils / 1000` (the float helper is removed), and each line with residue posts the ADR-0002 balanced group (`card_scheme_clearing` credit / `scheme_rounding_residue` debit).
- **Test:** `scheme_residue_test.go` (4747 → "4.74" + 7 fils residue journalled; whole-10 lines post nothing).

## M13. March reconciliation sweep is not safe to re-run, uses the wrong month and charges merchants — High
**Where:** `scripts/reconcile_march.ts`
**Evidence:** Finance — "someone ran it twice on staging and the gap doubled. Nobody knows if it ran more than once on production … Is it safe to run again? I wouldn't." Handover — "must use the Bahrain month, not a UTC month."

- **What / why:**
  - **Not idempotent.** Each run posted a group with a fresh `randomUUID()`; the comment "re-running is safe, entry_group_id dedupes it" is false — nothing deduplicates, so every run adds the residue again.
  - **UTC month.** `monthBounds` uses `Date.UTC`, but the business day is Asia/Bahrain: Bahrain March is `2026-02-28T21:00Z .. 2026-03-31T21:00Z`, so the sweep missed March's first three local hours and swept April's.
  - **Wrong accounts.** It debited `merchant_payable` and credited `scheme_rounding_residue`, i.e. it charged *merchants* for the platform's scheme rounding. ADR-0002's legs are `card_scheme_clearing` credit / `scheme_rounding_residue` debit.
- **Why the Bahrain month, although ADR-0003 is Accepted.** ADR-0003 says calendar-month finance reports and one-off scripts use the UTC month. We deliberately depart from it for this script, and say so openly:
  - ADR-0003 rests on the claim that the three hours at each end "net out" over a month, and its own Consequences limit it: "If a month has unusual volume at the boundary, compare against the batch totals before booking." MK's reply to YA's objection in the same ADR is "revisit if a month doesn't tie".
  - March does not tie. Huda reports it out by "roughly 4.7–4.8 BD" (meetings/2026-07-08-finance-eng.md:17) and "4.75 BD-ish" (archive/slack-export-fp-finance-2026-09.txt:71). The seed fixture puts 528 residue captures (527 × 9 + 7 = 4,750 fils = 4.750 BD) in the first three Bahrain hours of 1 March, which a UTC month counts as February (`db/seed/fixtures/marchReconciliation.ts:28-33`). That is exactly the gap, so the ADR's own revisit condition is met. August tied under the UTC window because its boundaries were ordinary, which is what the ADR predicts.
  - This script is not a report: it posts ledger entries for the ADR-0002 residue that `CloseBatch` would have journalled per daily batch, and daily batches use the Bahrain business day (ADR-0003's own "daily" rule). A month of Bahrain days is the Bahrain month; a UTC window would book residue for transactions whose batches belong to February and April.
  - The handover is explicit for this script: "Whoever writes it must use the Bahrain month, not a UTC month" (HANDOVER.md:30-32).
  - We did not edit ADR-0003. Finance should supersede it for any script that posts to the ledger; until then this is a documented exception, not a silent change. `monthBounds` (UTC) is kept for callers that want a UTC report.
- **Fix:** an exported `runSweep` that takes a transaction-scoped advisory lock and skips any merchant whose sweep group already exists (matched by the original description, so earlier production runs are detected), uses Bahrain month bounds, posts the ADR-0002 legs, and has a `--check` mode that writes nothing and reports how many times each merchant was already swept — which answers "did it run twice in production?" from the ledger itself. Groups already posted by old runs are not reversed automatically; `--check` lists them for finance.
- **Test:** `reconcile_march.fix.test.ts` — Bahrain bounds; three consecutive runs post exactly one balanced group and never touch `merchant_payable`.

## M14. An admin repair tool takes sandbox merchants live, so test merchants get settled — High
**Where:** `apps/api/src/routes/adminMerchantsRecompute.ts` (removed `admin/merchantFlags.ts`)
**Evidence:** group chat — "test merchants keep showing up in the real settlement run"; notes — "what happens to test merchants when certain admin tools run?"

- **What:** after a finance admin ran **Recompute transaction statuses** on a sandbox merchant, that merchant was settled and paid in the real daily run.
- **Why:** the daily run correctly selects `test_mode = false` merchants, but the recompute route also called `reconcileSandboxFlag`, which set `test_mode = false` whenever the merchant had no open authorizations. A routine status repair therefore silently took the merchant live; the audit log only recorded it as `flagsUpdated: ["test_mode"]`.
- **Breaks:** test transactions enter real settlement batches, scheme files and payouts.
- **Fix:** the recompute no longer touches `test_mode` (going live is a deliberate decision, not a repair side effect); `flagsUpdated` stays in the response, always empty, so clients are unaffected. The helper, whose only behaviour was this, is removed.
- **Test:** `adminMerchantsRecompute.fix.test.ts` drives the real admin login + OTP and the route; it fails on the old code and passes on the fix.

## M15. A reporting health check can wedge the reporting consumer permanently — Medium
**Where:** `apps/reporting/src/consumer/applyEvent.ts`

- **What:** applying a `settlement.batch_closed` event threw `Cannot read properties of undefined (reading 'captured_count')`.
- **Why:** the batch-closed handler runs a "rollup parity" check and read `rows[0].captured_count` without checking that a `merchant_daily_volume` row exists. When a day has real captures but no rollup row yet — its capture events consumed later (consumption is by id, not commit order), or bucketed on the other side of midnight — the read throws. The consumer applies a pass all-or-nothing, so the whole pass rolls back and the watermark can never move past that event: reporting stalls for good, and the check that was meant to detect a stuck consumer is what sticks it.
- **Fix:** treat a missing row as a rollup of 0 (the most-lagging case) and warn, as the check intends.
- **Test:** `applyEvent.rollupGap.test.ts` — fails on the old code with exactly that TypeError, passes on the fix.

## M16. The nightly hold janitor deletes every hold on a quiet night — Critical
**Where:** `scripts/expire_holds.ts`, `scripts/lib/sqlFilter.ts`
**Evidence:** HANDOVER: "flips `active` to `expired` with one UPDATE. Holds are never deleted." Migration 0005 notes that MK switched it to deleting rows (FP-219). FH flagged the SELECT/DELETE race in a comment.

- **What:** on any night with no expired holds, the janitor deleted every row in `holds`: active authorizations, released and expired ones alike.
- **Why:**
  - The script SELECTed the expired hold ids, then built a DELETE from them with `buildDelete`.
  - `buildWhere` silently skips an empty array, so zero ids produced `DELETE FROM holds` with no WHERE.
  - Even on normal nights, a hold captured between the SELECT and the DELETE was deleted anyway.
- **Breaks:** every active authorization loses its hold record, so capture and void can no longer find or release it. Hold history is gone as well.
- **Fix:**
  - One atomic `UPDATE holds SET status = 'expired' WHERE status = 'active' AND expires_at < now()`, as the handover and the 0005 status CHECK describe. Nothing is deleted, and there is no race.
  - `buildWhere` now turns an empty list into `FALSE`, so no other caller can build an unconditional statement.
- **Test:** `expire_holds.test.ts`.
  - On the old code, an empty id list builds `DELETE FROM holds`.
  - On the fix, it builds `... WHERE FALSE`.
  - Against the DB: a quiet night deletes nothing, and exactly one abandoned hold becomes `expired`.
  - The old tests asserted the delete design, so they were replaced.

## M17. Admin status recompute resurrects refunded transactions — Critical
**Where:** `apps/api/src/admin/transactionStatusRecompute.ts`
**Evidence:** every seeded `refunded` transaction has `refunded_fils = 0`, because the column arrived later (0043) with DEFAULT 0. Teammate B's R7 fix excluded only `chargeback`.

- **What:** running **Recompute transaction statuses** turned refunded transactions back into `captured`.
- **Why:** the tool rebuilds each status from the amounts. A legacy refunded row says nothing was refunded, so it is recomputed as `captured`.
- **Breaks:** the transaction becomes capturable and refundable again. A second capture credits `merchant_payable` again, and a second refund through the new FP-300 route pays the customer twice.
- **Fix:** `refunded` is excluded from recomputation, like `chargeback`: it can't be reliably derived from the amounts. Forward moves (`captured` → `partially_refunded` / `refunded`) still work.
- **Test:** `transactionStatusRecompute.refunded.test.ts`.
  - On the old code, the legacy refunded row comes back as `captured`.
  - On the fix, both refunded shapes stay `refunded`, and a captured row with refunds moves forward to `partially_refunded`.

> **Test isolation note.** The shared-database failures noted earlier came from an API test fixture that inserted real event types with `{}` payloads. Teammate B fixed that fixture at the source (see T1 in the API write-up), so `npm test` now passes on one database.
