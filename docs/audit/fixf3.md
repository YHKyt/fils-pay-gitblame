# fixf3: residual items from hunt-a/b, concfuzz, seeddemo, S9 and adrdrift

Branch `agent/fixf3`, from `fix/money-parsing` (`3133b39`). Each finding has a
regression test that fails on the code before the fix and passes after it.
Migrations used: 0123, 0124.

## FC1. Authorization rows written before the card-hash fix still held the card — High

**Where:** `idempotency_keys.request_hash` for `endpoint = 'transactions.authorize'`; new `db/migrations/0124_redact_legacy_authorize_request_hash.sql`
**Evidence:** `api-security-and-refunds.md` S9 "Open": rows written before `0c34a1e` keep `sha256(canonicalJson({ amountFils, card, reference }))`. Test `apps/api/src/routes/authorizeLegacyHash.test.ts` plants such a row and applies the migration. With the migration replaced by a no-op it fails with `the stored hash still covers the raw card`; with 0124 it passes, and a 000-999 CVV search over the stored value finds nothing.

- **What:** the S9 code fix only changed what new authorization rows store. Every row written before it still carries an unkeyed hash of the full card, CVV included.
- **Why:** the amount and reference sit on the `transactions` row, so with the PAN the CVV is one of 1,000 sha256 guesses, and the PAN itself is a small search from a known BIN, the expiry and the Luhn digit. PCI DSS forbids keeping the CVV in any form after authorization.
- **Breaks:** anyone who can read the table (a backup, a replica, an SQL injection) can recover card data for every historical authorization.
- **Fix:** 0124 overwrites `request_hash` on every `transactions.authorize` row with the constant `redacted:pre-0124`, which no request hashes to.
  - Old and new hashes are both 64 hex characters, so SQL cannot tell them apart. The database also lacks the HMAC key, and the card, needed to recompute a new-style hash. So all authorize rows are overwritten.
  - A pre-fix row could never match a new request anyway, so it loses nothing.
  - A post-fix row loses its replay. A same-key retry that spans the migration gets 422 `idempotency_key_reused`, the same one-off effect S9 itself had at deploy.
  - `resource_id`, `status` and `response_body` are kept, so the payment-link checks that read `resource_id` still work. Capture, refund and admin rows hash no card data and are not touched (the test checks a capture row).
  - Smallest change: one idempotent `UPDATE`, no code change.
- **Test:** `apps/api/src/routes/authorizeLegacyHash.test.ts` (runs inside a rolled-back transaction).

## FC2. The admin credit form quoted merchants.mdr_bps as the fee-reversal rate — Low

**Where:** `apps/admin/src/pages/merchants/MerchantDetailPage.tsx` (credit form checkbox), `apps/admin/src/format.ts`, `apps/admin/src/api/credits.ts` (comment)
**Evidence:** the checkbox read `Also reverse the MDR on this amount ({(merchant.mdrBps / 100).toFixed(2)}%)`. The server computes the reversal at the dated `fee_schedules` rate in force on the effective date, less the volume-tier bonus (`apps/api/src/admin/credits.ts`; locked by `credits.test.ts` "the fee reversal uses the dated fee_schedules rate in effect on the effective date, not merchants.mdr_bps"). Reported by hunt-a/b. New test `apps/admin/src/creditFeeReversalLabel.test.ts` fails on the old page with `the reversal box still quotes merchants.mdr_bps`.

- **What:** a merchant with `mdr_bps = 250` and a 180 bps schedule row was shown "2.50%" while the ledger reversed 1.80%.
- **Why:** B2b moved the server to the effective-dated rate. The form label was not updated.
- **Breaks:** the operator approves a credit having been shown one reversal rate while another is journaled. Second-approver review relies on what the form shows.
- **Fix:** the label comes from `creditFeeReversalLabel(effectiveDate)`. It names the rule and the chosen date ("at the rate charged on 2026-09-15 (fee schedule, less any volume-tier bonus)") instead of quoting a rate. The console has neither the schedule for an arbitrary date nor the tier bonus. Showing the exact figure would need a new preview endpoint, which is a bigger change than this display bug deserves. No money path changes.
- **Test:** `apps/admin/src/creditFeeReversalLabel.test.ts`.

## FC3. Seeded marketplace and instalment captures booked a fee settlement would not charge — Medium

**Where:** `db/seed/fixtures/transactions.ts` (`generateMarketplaceOrdersForMerchant`, `generateInstalmentCaptures`), `db/seed/generate.ts` (capture event metadata)
**Evidence:** `seeddemo.md` "Still open": Delta Marketplace's 210 capture events and Alpha's 11 instalment events had no `discountBps`. seeddemo assumed the recomputed and the booked fee agree. They do not. The marketplace fee took the discount off the fee (`mdr(amount) - discount(fee)`), while `capture.ts` and Go `ComputeSettlementFee` discount the amount first. At 275 bps and a 12.5% discount, every order total in the fixture comes out 1 fil higher (14,100 fils: 340 vs 339). Real run on a seeded DB, `settlement run-batch --date=2026-08-31` for Delta Marketplace: journaled fee 5,360, batch `fee=5358 netPayout=217342`, so `merchant_payable` was debited 2 fils more than it had been credited for that day.

- **What:** the seed journaled one fee and recorded it without `discountBps`, so `CloseBatch` (and `RecalculateMDR`) ignored the booked fee and recomputed a different one.
- **Why:** the seed's discount formula predates the move of the discount into `captureTransaction`, and the events kept the old `{ feeFils }` shape.
- **Breaks:** every marketplace batch closed from the demo data pays out 1 fil per order more than the ledger credited. `merchant_payable` drifts negative, and platform fee revenue disagrees with the batches.
- **Fix:** both generators compute the fee as `capture.ts` does (discount the amount, then the MDR, each half-even), and both kinds of event record `{ feeFils, discountBps }`. The instalment fixture's merchant has no discount, so its fees are unchanged; it now takes `discountBps` so the metadata is truthful. After the fix the same run gives journaled fee 5,358 = batch fee and payout = credited net. All seed REAL assertions pass.
- **Test:** new `demoRealism.test.ts` "every seeded capture event books its fee as capture.ts does, with discountBps". Before: `Alpha Retail Co: 11 without discountBps`, `Delta Marketplace Bahrain: 210 without discountBps`. After: 6 of 6 pass. `selfVerify.integration` and `outboxParity` pass. (Run with `SEED_RESET=1` on a scratch DB, as the file header says.)

## FC4. Another key or a void could act on a capture whose outcome was unknown — Medium

**Where:** `apps/api/src/payments/capture.ts`, `apps/api/src/payments/void.ts`, new `db/migrations/0123_capture_attempts_unresolved.sql`
**Evidence:** `concfuzz.md` "Residual: another operation after a thrown capture". New test `apps/api/src/payments/captureUnknownOutcome.test.ts` uses an acquirer that captures and then times out. On the old code, a capture under a new key gives `the acquirer captured the card twice for one recorded capture` (`8000 !== 4000`), and a void gives `voided while the acquirer captured 5000 fils` (`200 !== 409`).

- **What:** when `acquirer.capture` threw, the capture's transaction rolled back and left no trace. Only a same-key retry was safe (h4: same acquirer key). A capture under another Idempotency-Key sent a new acquirer key and captured again. A void that waited on the row lock voided locally while the acquirer had captured.
- **Why:** unlike refunds, capture kept no durable record of an in-flight acquirer call.
- **Breaks:** the customer is charged twice with one capture on the books, or charged with the transaction shown voided and nothing owed to the merchant.
- **Fix:** capture catches a throw from the acquirer call only. It records `(transaction, claim, amount, acquirer key)` in `capture_attempts_unresolved`, marks the claim `failed`, and commits before rethrowing. The record therefore exists before the row lock is released, and a waiting void or capture sees it. Callers still see the same throw. While the record exists:
  - a capture of the same amount, under any key, resends the recorded acquirer key, so the acquirer replays its answer. On any acquirer answer the record is deleted, and on approve or decline the first claim is completed with the same response, so a late retry of the first key replays instead of capturing again;
  - a capture of another amount gets 409 `capture_outcome_unknown` (with `pendingCaptureFils`, claim left retryable), and no acquirer call is made;
  - a void gets 409 `capture_outcome_unknown`. The merchant resolves by capturing and can refund afterwards. This is the safe choice: the platform cannot ask the acquirer whether the capture happened, and voiding guesses "no".
  - Smallest change: one table, one SELECT, a try/catch around the acquirer call, and one check in void. No reservation of `captured_fils`, so every reader of the transaction row is unchanged.
- **Existing test changed:** `pay.voidProcessing.test.ts` (HA3) asserted that a link payment whose capture threw can be voided at once. That is exactly the unsafe case. It now expects the 409, then a merchant capture that resolves it (link `paid`, one capture). A second test keeps HA3's link hand-back covered for a capture that threw before 0123 and left no record.
- **Not covered:** a throw after the acquirer approved but while journalling (a DB failure) still rolls everything back with no record, as before. The record is written in the same transaction, so it cannot survive that failure. A crash of the process during the call is also not covered.
- **Test:** `captureUnknownOutcome.test.ts` (2 tests) and `pay.voidProcessing.test.ts` (2 tests). `acquirerTimeoutRetry.test.ts` (h4) still passes.

## Checked, not changed

- **hunt-a.md / hunt-b.md "suspected, not fixed" lists:** neither file has such a list (also checked their history on `origin/b/hunt-a` and `ec44ed8`). B's hand-off message names two items. The admin credit form is FC2. The other is below.
- **Test-mode captures stay in merchant_payable after go-live** (hunt-a/b): true as code reading. `capture.ts` journals every capture to `merchant_payable` and `merchant_balances`, whatever `transactions.test_mode` is. Since settlebatch, `CloseBatch` never claims a test-mode capture, so after go-live the sandbox amount stays in the payable and in the admin "cached payable" figure for good. Reconciliation stays consistent (the same events count as ledger and as pending). Not changed:
  - no code path takes a merchant live (`test_mode` is only cleared by hand in SQL, since the recompute that cleared it was removed);
  - the fix is an accounting policy choice for finance: do not journal sandbox captures at all, or reverse the sandbox balance at go-live. Either one changes ledger history that ADR-0004 rebuilds from.
- **Two roundings for a discounted fee** (adrdrift): capture and settlement still agree with each other (`ComputeSettlementFee` and `capture.ts` both discount the amount, then apply the MDR). FC3 brought the seed into line with them. Whether to round once is a pricing decision for finance, not a ledger break.
- **Reconciliation and backdated credits** (adrdrift): unchanged. A range covering both days explains to zero, by design.
- **Migration numbers 0054-0056 reused** (adrdrift): `db/migrate.ts` tracks applied files by full filename, so there is no collision. Renaming applied migrations is riskier than the drift.
- **`FEATURE_ASYNC_CLOSE`** (adrdrift): still read nowhere (grep of apps, packages, scripts, db). Documentation only.
- **Dead float helpers** (adrdrift): `apps/api/src/fees/estimate.ts`, `apps/api/src/lib/decimal.ts` and Go `EstimateMonthlyPayout` still have no callers (grep finds only the definition). They produce no figure today.
- **Batch detail progress bar** (adrdrift): `SettlementBatchDetailPage.tsx` still uses `grossFils / 10000` only as a bar width. No amount is displayed from it.
