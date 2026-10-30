# Bug hunt B: settlement, reporting, money, frontends, SQL, ops

Each finding has a regression test that fails on the code before the fix
and passes after it.

## HB1. A batch left closed past midnight is never paid by the daemon — Medium

**Where:** `apps/settlement/internal/settlement/missed_days.go` (`FindMissedBusinessDays`), used by `scheduler.closeMissedDays`

- **What:** a batch that `CloseBatch` committed but `PayoutBatch` never paid stayed `closed` for good. The daemon only re-runs yesterday. Its missed-day scan only looked for days with unclaimed captures and no closed or paid batch, so a closed day was skipped.
- **Why:** `RunDailyBatch` is two transactions per merchant: close, then pay. A daemon killed between them (OOM under the 128 MB limit, a host restart) and not back before the next Bahrain midnight leaves the batch closed. So does a payout that keeps failing until then (for example a split parent with invalid weights, settleguards G2). The settleguards G3 note says "the next run of the same day repairs it". That holds only while the day is still yesterday.
- **Breaks:** the day's net payout stays in `merchant_payable` and is never paid unless someone notices and runs `run-batch --date`. A negative closed batch is never carried forward either, because `claimCarriedShortfall` only takes `paid` batches.
- **Fix:** the missed-day scan also returns `(merchant, date)` for every `closed` batch in the 31-day lookback whose merchant is eligible now. `closeMissedDays` already runs `RunDailyBatch` for those days: `CloseBatch` reports the batch already closed, and `PayoutBatch` pays it. Both are idempotent per batch.
- **Test:** `scheduler/closed_unpaid_test.go` `TestRunIfDue_PaysBatchLeftClosedOnAnEarlierDay` closes a day 3 days back without paying it, then runs the daemon pass twice.
  - Before: `{batches:1 status:closed payoutFils:0 paidEvents:0}`.
  - After: `paid`, 97,500 paid out once, one `settlement.paid` event.
