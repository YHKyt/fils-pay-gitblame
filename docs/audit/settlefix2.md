# Settlement follow-ups: MDR recalculation, reconciliation payouts, rollback errors

Three defects left behind when refunds started being netted into batch payouts
(settlebatch 3aadad7) and one long-standing transaction-helper issue. Each was
reproduced on a fresh migrated database before it was fixed.

## Recalculate MDR pays a deducted refund out again — High

**Where:** `apps/settlement/internal/settlement/recalculate_mdr.go`, `RecalculateMDR` (net payout rewrite).
**Evidence:** `TestRecalculateMDR_KeepsRefundDeduction`. Capture 100,000 fils at 2.50% (fee 2,500), refund 10,000 (fee reversed 250), close: net 87,750. Re-rate to 4.00% (diff +1,500). Before the fix: `net after recalc = 96000, want 86250` and `merchant_payable = 86250, want 96000`. After: pass.

- **What:** the recalculation set `net_payout_fils = gross_fils - new fee`.
- **Why:** that formula predates refund netting. CloseBatch now freezes net as gross - fee - (refunded - fee reversed) + carried-in shortfall, so rebuilding net from gross and fee silently drops the refund deduction and any carried shortfall.
- **Breaks:** any closed batch re-rated after a refund pays the refunded money to the merchant a second time (9,750 fils in the example), and the batch's net no longer equals merchant_payable, while the ledger and balance cache (which correctly move by the fee difference only) disagree with the batch.
- **Fix:** `newNetPayout := b.netPayoutFils - diff`. Only the fee changed, so the net moves by exactly the fee difference; this is the same delta already posted to the ledger and the cache. One line, no new query.
- **Test:** `apps/settlement/internal/settlement/recalculate_mdr_refund_test.go`. All 13 `TestRecalculateMDR*` tests pass.

## Reconciliation counts payout legs as merchant earnings — High

**Where:** `apps/api/src/settlement/query.ts`, `getReconciliationReport` (ledger figure).
**Evidence:** a merchant with one paid 97,500-fils batch, window from its batch date to tomorrow (so it contains the payout legs dated now()): before the fix `ledgerMerchantPayableNetFils: 0, settlementNetPayoutFils: 97500, gapFils: -97500, explained: false`. Also reproduced with batches closed and paid by the real Go `RunDailyBatch`. After: gap 0.

- **What:** the ledger side summed every `merchant_payable` leg in the window, including the debit that PayoutBatch / PayoutSplitBatch post when a batch is paid.
- **Why:** reconciliation compares what the merchant earned (ledger) with what the batches say they owe (sum of `net_payout_fils` over closed and paid batches). The payout debit settles that same net, so counting it subtracts every paid batch twice.
- **Breaks:** any window that contains a payout date reports a gap equal to minus the paid amount and `explained: false`, so finance cannot tell real discrepancies from normal payouts.
- **Fix:** exclude merchant_payable legs whose entry group has a `platform_cash` leg. Only the two payout paths post to `platform_cash`, so the selector is structural (account-based) rather than relying on the description text. Other batch-linked legs, such as MDR recalculation adjustments, still count, because they do change what the merchant earned and the batch net moves with them.
- **Test:** `apps/api/src/settlement/reconciliationSettled.test.ts`, first case. Fails before (`expected: 97500, actual: 0`), passes after. The file's other two cases cross-check the settled-refund and carried-shortfall handling from agent/analytics (AN1, AN2) against rows written the way CloseBatch writes them; both pass with that code, and fail on the code before it (independently reproduced: a batch with a 10,000-fils refund showed gap 9,750; the carried-shortfall case showed gap 195,000, from the refund counted again as pending plus the shortfall counted twice, with the window excluding the payouts).

## A failed ROLLBACK hides the real error — Low

**Where:** `apps/api/src/db/withTransaction.ts` and its copy `apps/reporting/src/db/withTransaction.ts`.
**Evidence:** `apps/api/src/db/withTransaction.test.ts`. Before: `not ok 1 - a failed ROLLBACK does not hide the original error` with `Error: Client has encountered a connection error and is not queryable`. After: pass.

- **What:** the catch block awaited `ROLLBACK`; if that threw, its error replaced the one that caused the rollback, and the dead client was returned to the pool with a plain `release()`.
- **Why:** when the connection drops mid-transaction, every error the caller and the logs see is the generic "not queryable" message, never the real cause (constraint violation, acquirer error, timeout). Handing the broken client back also lets the next caller fail on it.
- **Breaks:** incident diagnosis, and correct HTTP error mapping in callers that branch on the original error type.
- **Fix:** wrap the ROLLBACK in its own try/catch, log its failure, rethrow the original error, and pass the rollback error to `release()` so pg destroys the client. The reporting copy is changed identically, as its header asks to keep the two in sync.
- **Test:** two unit cases with a fake pool: the original error is rethrown and the client is released with an error; a normal failure still runs BEGIN, ROLLBACK and releases the client without an error.

## Documentation corrected

`serializeBatch` in `apps/api/src/settlement/query.ts` and `SettlementBatchDto` in `apps/web/src/types.ts` stated `netPayoutFils === grossFils - feeFils`. With refund netting and carried shortfalls this is false and the net can be negative; both comments now describe the real formula.
