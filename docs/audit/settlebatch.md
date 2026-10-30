# Settlement batch close and payout — findings

Scope: `apps/settlement/internal/settlement/batch.go` (`CloseBatch`, `PayoutBatch`, `RunDailyBatch`) and helpers next to it. Same format as the other notes in this folder. Every fix has a regression test that fails on the previous code and passes on the fix. Go suite: `cd apps/settlement && DATABASE_URL=… go test -p 1 ./...`.

Invariant used throughout: once a business day is closed and paid, the merchant's `merchant_payable` ledger balance for that day's activity is exactly 0. Whatever the ledger booked is what the payout settles.

---

## Refunds were never deducted from payouts — Critical
**Where:** `apps/settlement/internal/settlement/batch.go` (`CloseBatch` selected only `captured`/`partially_captured` events; nothing in `apps/settlement` read `refunds`), `db/migrations/0042_refunds.sql`
**Evidence:** a 100,000 fils capture at 2.50% and a same-day full refund, both written exactly as `capture.ts` and `processRefund.ts` write them. The batch paid 97,500, the refund's `settlement_batch_id` stayed NULL, and `merchant_payable` ended at −97,500 (`TestCloseBatch_SameDayFullRefundNetsToZero` on the old code: `net payout = 97500, want 0`, `merchant_payable after payout = -97500, want 0`).

- **What:** `processRefund` debits `merchant_payable` by the refund and credits back the reversed fee. Settlement ignored both and paid the merchant the full capture net, so every refund was paid twice: once back to the cardholder, and once to the merchant. Migration 0042 says a settlement pass claims each refund through `refunds.settlement_batch_id`. Nothing did.
- **Why:** refunds shipped (FP-212/FP-300) on the API side only. The 2026-06-02 eng sync deferred the settlement side to v2 ("leave the batch alone until cutover"), and v2 is paused (ADR-0005).
- **Breaks:** merchant payouts are too high by `refund − fee reversed` for every refund. The platform funds the difference, and `merchant_payable` drifts negative with nothing to recover it. Finance's one requirement, that reconciliation ties out after refunds, fails.
- **Fix:**
  - **Claiming refunds:** `CloseBatch` claims, in its own transaction, every unbatched succeeded refund of the merchant with `occurred_at < window end` (one `UPDATE … RETURNING` that locks the rows and sets `settlement_batch_id`). There is no lower bound, so an unclaimed older refund is still deducted.
  - **New net:** `net = gross − fee − (Σ amount − Σ fee_reversed) + carried-in shortfall`. This is exactly the merchant_payable movement `processRefund` journals.
  - **Refund timeline events are not stamped:** `RecalculateMDR` rates every event carrying a batch id, and the refunds row is the record.
  - **Negative net:** the schema already allows it (`net_payout_fils` has no `>= 0` CHECK, and payout, disbursement and the `settlement.paid` scan all skip `net <= 0`). Such a batch pays nothing and is marked `paid`. Its shortfall stays owed in `merchant_payable` and in the cache. The merchant's next close claims it through the new `settlement_batches.carried_forward_to_batch_id` (migration 0090) and deducts it, so it is recovered once and never twice. Only `paid` shortfalls are carried, because `RecalculateMDR` may still rewrite a `closed` batch.
  - **Cache:** it moves by the batch's own net at close and by what was actually paid at payout, so a carried shortfall is never counted twice.
  - **Why this is the smallest change:** it reuses the claim idiom already used for events, adds one nullable column, and does not change the scheme file or the API.
- **Scheme file (decided: refunds stay out of it):**
  - `scheme_export_lines` has `CHECK (amount_fils >= 0)`, a `UNIQUE (batch, transaction)` key and no line type. A refund of an earlier day's capture would need a negative line with no capture to net against, so the file format cannot carry refunds.
  - The refund is executed online with the acquirer (`acquirer.refund`, with its own reference stored in `refunds.acquirer_reference`). Its ledger legs already credit `card_scheme_clearing` at refund time.
  - Netting the refund into the presentment line as well would clear it twice, and would make ADR-0002's residue (`gross − amount` per capture line) wrong.
  - So the line stays the capture presentment (100,000 in the repro), and `card_scheme_clearing` nets to 0 against the acquirer's refund record.
  - Open item for finance and the acquirer: confirm Acquirer B clears online refunds itself, and whether it truncates refund amounts to 2dp (an ADR-0002-style residue on refunds).
- **Follow-ups outside this file:**
  - `RecalculateMDR` sets `net = gross − newFee`, which would drop a closed batch's refund deduction. It should apply `net − diff`.
  - The API and web DTOs document `netPayoutFils === grossFils − feeFils`. That is no longer true for a batch with refunds, and the refund totals should be shown (`SUM` over `refunds WHERE settlement_batch_id = batch`).
- **Test:** `internal/settlement/batch_refunds_test.go`, using fixtures in `head_rows_test.go` that write rows exactly as `capture.ts` and `processRefund.ts` do today:
  - **Same-day full refund:** net 0, refund linked to the batch, no payout legs, `merchant_payable` and cache 0, scheme line 100,000.
  - **Partial refund, exact fils:** 4,747 fils with fee 119, refund 1,333 with 33 reversed. Net is 3,328 and is paid, and payable is 0. On the old code it paid 4,628 and left −1,300.
  - **Shortfall carried forward:** day 2 refunds day 1's capture, so its net is −97,500 and nothing is paid. Day 3 deducts it and pays 97,500, payable ends at 0, and re-running all three days changes nothing.

---

## Test-mode captures settled once the merchant went live — High
**Where:** `apps/settlement/internal/settlement/batch.go` (`CloseBatch` eligibility `merchants.test_mode = false`, read at close time; the event select had no per-transaction test flag), `apps/settlement/internal/scheduler/daemon.go` (re-runs "yesterday" on every tick), `db/migrations/0002_merchants.sql` ("Test-mode merchants' transactions never settle")
**Evidence:** a test-mode merchant captures 100,000 fils on day D, then goes live before D's batch closes. `RunDailyBatch(D)` on the old code: `gross/fee/net = 100000/2500/97500, want 0/0/0`, one scheme export line, 97,500 paid out (`TestRunDailyBatch_TestModeCaptureDoesNotSettleAfterGoLive`). With refunds settling (finding above), a sandbox refund made before go-live came off the first live payout: `net = -29250, want 9750` (`TestRunDailyBatch_TestModeRefundNotDeductedAfterGoLive`).

- **What:** whether a capture settles was decided by the merchant's mode when the batch closes, not when the money moved. The daemon re-runs the previous business day on every tick after its due time, so a merchant that goes live during day D+1 has its day-D sandbox captures settled and presented to the scheme on the next tick.
- **Why:** the only test-mode signal was `merchants.test_mode`, a current-state flag. Nothing recorded the mode a transaction was made in.
- **Breaks:** real payouts for sandbox payments the acquirer never captured (the platform funds them), and scheme presentments for them. Sandbox refunds reduce live payouts, because refunds are claimed with no lower date bound.
- **Fix:**
  - Migration 0091 adds `transactions.test_mode` and a `BEFORE INSERT` trigger that copies `merchants.test_mode` onto every new transaction. This is the "flag at authorize" without touching `authorize.ts` (another lane), and it covers every insert path (API, payment links, seeds). Nothing in `apps/api` flips `test_mode` today (the recompute side effect was removed earlier), so going live is an ops change and a merchant-side `live_since` hook would have no code path to live in.
  - `CloseBatch` selects only events of non-test transactions, and `claimBatchRefunds` claims only refunds of non-test transactions. The close-time merchant check stays, so a merchant still in test mode is skipped as before.
  - Backfill: transactions of merchants in test mode now are marked `true`. They never settled under the old rule either, so no live merchant's settlement changes. A sandbox transaction of a merchant that is already live cannot be identified after the fact and keeps the old behaviour.
  - Why this is the smallest change: one column, one trigger, two `WHERE` clauses. A per-transaction flag also handles the cases a `live_since` timestamp gets wrong: a payment authorized in test mode and captured after go-live, and a merchant that goes back to test mode and live again.
- **Test:** `internal/settlement/batch_test_mode_test.go`:
  - **Capture:** test-mode capture on D, go live, `RunDailyBatch(D)`. Gross, fee and net are 0, no scheme line, no payout legs, the event stays unclaimed.
  - **Refund:** test-mode capture and 40,000 refund on day 1, go live, 10,000 live capture on day 3. Day 3 nets exactly 9,750, the sandbox refund stays unclaimed, and the only scheme line is the live transaction.

---

## An explicit re-run paid out a suspended merchant — Medium
**Where:** `apps/settlement/internal/settlement/batch.go` (`CloseBatch` returned "already closed" before its merchant eligibility check; `RunDailyBatch` pays whatever batch `CloseBatch` returns; `PayoutBatch` never reads the merchant)
**Evidence:** close a 100,000 fils batch without paying it (a failed payout, or a run that died between the two steps), suspend the merchant, then `RunDailyBatch(D, --merchant)`. On the old code the batch went to `paid` with a 97,500 payout leg (`TestRunDailyBatch_ExplicitRerunDoesNotPaySuspendedMerchant`: `batch status = "paid", want closed`, `payout legs = 97500 fils, want none`).

- **What:** the merchant check (`status = 'active' AND test_mode = false`) ran only for an open batch. For an already-closed batch `CloseBatch` returned early, and `RunDailyBatch` went straight on to `PayoutBatch` (or `PayoutSplitBatch`), neither of which looks at the merchant.
- **Why:** the early return was written for idempotency, and the eligibility check was placed after it on the assumption that the default scan had already filtered merchants. An explicit `--merchant` (CLI `run-batch` or the internal API's run endpoint) skips that scan.
- **Breaks:** money leaves for a merchant that compliance or risk has suspended, which is exactly what suspension is for. The same applies to a merchant switched back to test mode.
- **Fix:** move the eligibility query above the already-closed return, inside the same locked transaction. An ineligible merchant now gets `ErrMerchantNotEligible`, which `RunDailyBatch` already skips, so neither payout path runs. The batch stays `closed` and is paid by the first re-run after the merchant is reinstated. This is the smallest change: no new code, one block moved, and it covers the split-payout path too. Side effect: re-running an already-paid day for a suspended merchant no longer lists it in the report (it was a no-op anyway).
- **Test:** `internal/settlement/batch_suspended_test.go`. Close, suspend, explicit re-run: the merchant is not in the report, the batch stays `closed`, there are no payout legs and the cache still owes 97,500. After reinstatement the same re-run pays 97,500 exactly once and `merchant_payable` is 0.

---

## Settlement recomputed the fee instead of settling the fee booked at capture — Medium-High
**Where:** `apps/settlement/internal/settlement/batch.go` (`CloseBatch` step 8 recomputed every event's fee from the merchant's rates at close time)
**Evidence:** capture 1,000,000 fils at 250 bps (the capture journals a 25,000 fee), change `mdr_bps` to 200, then close and pay the day. On the old code the batch charged 20,000, paid 980,000 and left `merchant_payable` at -5,000 (`TestRunDailyBatch_SettlesTheFeeBookedAtCapture`: `fee/net = 20000/980000, want 25000/975000`, `merchant_payable after payout = -5000, want 0`). Removing a 12.5% discount after a 602 fils capture at 275 bps gave `fee/net = 17/585, want 14/588` and payable `3`.

- **What:** the capture posts `capture: MDR fee` legs with the fee computed at capture time (discount-first, inside `captureTransaction` since b068fdf). `CloseBatch` ignored those legs and computed a new fee from `merchants.mdr_bps`, `negotiated_discount_bps` and the volume tier as they are when the batch closes.
- **Why:** the two calculations run at different times with different inputs. Any rate, discount or tier change between capture and close (an ops edit, a renegotiation, the tier moving at month end) makes them disagree, and the difference is paid out without a journal entry.
- **Breaks:** the payout leg no longer equals what the ledger owes the merchant, so `merchant_payable` drifts by the difference on every affected batch. A lowered rate overpays the merchant from platform money; a raised rate underpays. ADR-0004's rebuild and the reconciliation both see the drift but no entry explains it.
- **Fix:** `CloseBatch` reads the fee each capture event recorded (`transaction_events.metadata.feeFils`, written by `captureTransaction` in the same transaction as the fee legs, so the two always match) and settles exactly that. The recomputation stays only as a fallback for events that predate the discount change: those carry no `discountBps` marker and their recorded fee excludes the discount that was posted as a separate adjustment. Smallest change: one extra column in the existing query and a three-line branch in the existing loop. A true-up journal group was rejected because it would post fee changes nobody approved; the booked fee is the contract with the merchant, and Recalculate MDR remains the explicit tool for re-rating.
- **Test:** `internal/settlement/batch_booked_fee_test.go`, using capture rows exactly as `captureTransaction` writes them. Booked at 250, changed to 200: fee 25,000, payout legs 975,000, `merchant_payable` and the cache both 0. Booked with a 12.5% discount, discount removed: fee 14, payout 588, payable 0.
