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
