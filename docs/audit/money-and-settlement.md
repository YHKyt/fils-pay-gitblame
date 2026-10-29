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
- **Fix:** view uses `te.settlement_batch_id IS NULL`; 0055 rewritten to the real schema (suspense modelled as `asset`, as 0007 already does for `scheme_rounding_residue`); a valid 32-byte dev-only key. Neither migration could have applied anywhere (both error), so editing them does not trip the runner's checksum guard.
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

## M8. Daily close uses the UTC date, not Bahrain — High
**Where:** `apps/settlement/internal/scheduler/daemon.go`
**Evidence:** group chat — "the daily close is running at 3am local, not midnight"; ARCHITECTURE: business day is Asia/Bahrain.

- **What:** the daemon closed the wrong business day and ran about three hours late.
- **Why:** it read `time.Now().UTC()` and passed it to `BusinessDayWindow`, which takes the calendar date from the instant's own location. From 21:00 to 24:00 UTC it is already the next day in Bahrain (UTC+3), so the window was computed for the previous day and the run fired only once the UTC date caught up (~03:15 local). The code comment "UTC here is fine, BusinessDayWindow converts to Bahrain" is wrong — it does not convert.
- **Breaks:** which transactions land in which settlement day; payout timing.
- **Fix:** read the clock in the business timezone (`settlement.BusinessLocation()`); `BusinessDayWindow` and its tests unchanged.
- **Test:** `window_bahrain_test.go`. (`window_utc_compat_test.go` asserts the buggy "clock time is irrelevant" behaviour; fixing at the call site leaves it green rather than rewriting it.)

## M9. Platform volume counter overflows and the volume discount switches itself off — Medium
**Where:** `db/migrations/0073_platform_stats_bigint.sql`, `apps/settlement/internal/settlement/platform_volume.go`, `apps/api/src/fees/platformVolumeTier.ts`

- **What:** shortly after lifetime volume reaches the 0.15% discount threshold, the discount turns back off.
- **Why:** `platform_stats.total_processed_fils` is `INTEGER` (0049) and Go held it in `int32`. The threshold is 2,000,000,000 fils; `int32` max is 2,147,483,647. Go does not trap overflow, so `current + int32(gross)` wrapped negative ~147K BD later and the tier test failed again. (A comment says "asked Claude — INTEGER is 64-bit on 64-bit builds"; it is always 32-bit.)
- **Breaks:** consistent pricing for every merchant around the tier.
- **Fix:** migration 0073 to `BIGINT`, `int64` in Go, and the API converts node-pg's BIGINT string.
- **Test:** `platform_volume_int64_test.go` (values above int32 max).

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
