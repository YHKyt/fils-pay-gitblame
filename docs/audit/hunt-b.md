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

## HB2. Reporting config read "15s" as 15 ms and accepted a batch limit of 0 — Low-Medium

**Where:** `apps/reporting/src/config.ts` (`loadConfig`)

- **What:** `parseIntEnv` used `Number.parseInt`. Its comment claimed trailing characters were rejected, but they were not: `REPORTING_POLL_INTERVAL_MS=15s` became a 15 ms poll, and `1e3` became 1. Zero and negative values were accepted too.
- **Why:** `REPORTING_CONSUMER_BATCH_LIMIT=0` makes every pass run `LIMIT 0`. The consumer then never applies an event and never advances, with no error logged. An interval of 0 or a few ms is a busy loop of transactions against the shared database. A negative limit makes every pass fail.
- **Breaks:** the merchant dashboard's volumes and payout trends silently stop updating, or the database is hammered.
- **Fix:** each setting must be a positive whole number written in digits only, otherwise boot fails and the message names the variable. Defaults are unchanged.
- **Test:** `apps/reporting/src/config.test.ts`. Before: `Missing expected exception: 15s` and `Missing expected exception.` (2 of 3 tests failed). After: 3 of 3 pass.
