# Reporting and analytics correctness (AN1–AN5)

Scope: the merchant analytics, reporting and settlement read routes in
`apps/api`. Each figure was compared with a direct query on the ledger,
`refunds`, `settlement_batches` or `transactions`. Every finding was
reproduced with a route-level test on a real Postgres. Each test fails on
`fix/money-parsing` and passes with the fix.

The reporting consumer, its cursor, the admin rebuild and payout-trend status
belong to the reporting lane (`docs/audit/reporting*.md`) and are not repeated
here.

## AN1. Reconciliation counted a settled refund as still pending — High

**Where:** `apps/api/src/settlement/query.ts`, `getReconciliationReport`, the refund part of the pending query.
**Evidence:** a 10,000 fils capture at 250 bps and a 4,000 fils refund (100 fils fee reversed), both claimed by the day's batch (net 5,850). `GET /v1/settlement/reconciliation` returned `ledgerMerchantPayableNetFils 5850, settlementNetPayoutFils 5850, pendingUnbatchedFils -3900, gapFils 3900, explained false`.

- **What:** a refund that settlement has already deducted is reported a second time as pending, so a fully settled day shows an unexplained gap of `refund - fee reversed`.
- **Why:** pending refunds were selected from the refund timeline events (`transaction_events` `refunded`/`refund_partial`) with `settlement_batch_id IS NULL`. Since refunds settle, `CloseBatch` claims them on the `refunds` row (`refunds.settlement_batch_id`) and deliberately leaves the timeline event unstamped (`batch_refunds.go`). So the event column is always NULL, and every refund looks unbatched forever.
- **Breaks:** finance's tie-out. Any day with a refund reports `explained: false` once its batch closes, which is the state finance looks at.
- **Fix:** an unbatched refund event is one whose `refunds` row (`metadata.refundId`) has not been claimed. This is one `NOT EXISTS` in place of the always-true column test, and the rest of the computation is unchanged.
- **Test:** `apps/api/src/settlement/reconciliationRefund.test.ts`, "a refund claimed by a closed batch…". Before the fix: `-3900 !== 0`. After: pending 0, gap 0. The unbatched case ("a period with a partial refund still explains to zero") still passes.

## AN2. Reconciliation counted a carried-forward shortfall twice — High

**Where:** `apps/api/src/settlement/query.ts`, the settlement-total query in `getReconciliationReport`.
**Evidence:** on 2026-04-01 a 100,000 fils refund (2,500 fils fee reversed) closes a batch at −97,500, and the shortfall is carried. On 2026-04-03 a 100,000 fils capture at 2.50% closes at 97,500 − 97,500 = 0. Reconciling 04-01..04-05 returned `ledger 0, settlement -97500, gapFils 97500`.

- **What:** when one period holds both a negative batch and the later batch that absorbed its shortfall, the shortfall is subtracted twice.
- **Why:** since refunds settle (migration 0090), a negative batch is marked `carried_forward_to_batch_id` and its deficit is added to the next batch's `net_payout_fils`. Reconciliation summed every batch's net, so the deficit counted once in its own batch and again inside the claiming batch.
- **Breaks:** multi-day and monthly reconciliations for any merchant with a refund-heavy day show a false gap equal to the shortfall.
- **Fix:** each batch contributes its net minus the nets it took over (a lateral sum over `carried_forward_to_batch_id = batch.id`). Chains telescope, and each day alone still ties out: −97,500 for the refund day and 97,500 for the capture day.
- **Test:** `reconciliationRefund.test.ts`, "a negative batch carried into a later batch…". It checks all three windows. Before the fix: `97500 !== 0`.

## AN3. Transactions report silently stopped at 500 rows — Medium

**Where:** `apps/api/src/reporting/transactionsReportQuery.ts:61` (`LIMIT 500`), `apps/api/src/routes/reporting.ts`.
**Evidence:** a merchant with 501 matching transactions got 500 rows back. There was no cursor and no flag, so the report looked complete.

- **What:** the report truncates large result sets without saying so.
- **Why:** a fixed `LIMIT 500` with no pagination (noted in `large-export-upload.md`, not fixed there).
- **Breaks:** a merchant or finance user exporting a busy month quietly misses rows and totals.
- **Fix:** the query fetches one row past the page, orders by `(occurred_at, id)` and returns `X-Truncated: true|false` plus an `X-Next-Cursor` keyset cursor, which the caller passes back as `?cursor=`. The cursor carries `occurred_at` as Postgres text, so microsecond ties at a page edge are neither skipped nor repeated. An invalid cursor is a 400. The body stays the same plain array, so existing callers keep working.
- **Test:** `apps/api/src/reporting/transactionsReportPaging.test.ts`: 501 rows in groups of three sharing a timestamp. Page 1 has 500 rows and is flagged truncated, page 2 has 1 row, and all 501 ids appear exactly once. It fails on the old code (no header).

## AN4. Impossible calendar dates accepted by the report date ranges — Low

**Where:** `apps/api/src/routes/analytics.ts` (`isValidDateString`), `apps/api/src/routes/settlement.ts` (`/summary`, `/reconciliation`).
**Evidence:** `to=2026-02-30` returned 200 from `/v1/analytics/top-links` and `/v1/settlement/summary`, with the window silently ending on 2 March. `from=garbage` on `/v1/settlement/summary` and `/v1/settlement/reconciliation` returned 500.

- **What:** malformed dates are either accepted with a shifted window or crash the request.
- **Why:** the analytics check used `Date.parse`, which rolls 2026-02-30 over to 2026-03-02. Its own comment claims it rejects that date. The settlement routes checked only that the parameters were present. `bahrainLocalMidnightUtc` then threw a `RangeError` (500) or built the rolled-over instant.
- **Breaks:** reports for the wrong period with no error, and 500s for a bad query string.
- **Fix:** a date must match `YYYY-MM-DD` and round-trip through `toISOString` unchanged, or the response is 400.
- **Test:** `apps/api/src/analytics/impossibleDate.test.ts` covers all six endpoints plus the garbage case. Four cases fail on the old code (200/500 instead of 400).

## AN5. Non-numeric `limit` on settlement batches was a 500 — Low

**Where:** `apps/api/src/settlement/query.ts`, `listSettlementBatches`.
**Evidence:** `GET /v1/settlement/batches?limit=abc` returned 500.

- **What / Why:** `parseInt("abc")` is `NaN`. `Math.min`/`Math.max` pass `NaN` through, and Postgres rejects `LIMIT NaN`.
- **Breaks:** a bad query string crashes the request instead of being handled.
- **Fix:** a non-finite limit falls back to the default page size, as the analytics top-links limit already does.
- **Test:** `apps/api/src/settlement/batchesLimit.test.ts`. Before the fix: `500 !== 200`.

## Checked, not changed

- **`refund_merchant_summary` (0072/0075):** it was never refreshed. That is now fixed in the sqlhunt lane, which turned it into a live view. No API route reads it.
- **`apps/reporting/src/consumer/applyEvent.ts` `applyDailySummaryRollup`:** dead code. It buckets by the UTC date (`toISOString().slice(0,10)`) and writes `refund_count`/`refund_gross_fils`. It would be wrong on Bahrain days if it were ever wired in. That is the reporting lane.
- **Settlement batch DTOs** (`/v1/settlement/batches`, payout trends) still document `netPayoutFils === grossFils - feeFils`. With refunds and carried shortfalls this no longer holds, and no refund total is shown. `settlebatch.md` raises the same point.
- **`/v1/settlement/batches` `from`/`to`** go through `new Date(...)` and are bound as a JS Date. On a server whose process time zone is west of UTC, a date-only bound would move one day earlier. The deployment runs in UTC or +03, so this has no effect today.
- **Reconciliation with admin credits or balance adjustments** in the period: these move `merchant_payable` and are not settlement, so they show as a gap. This is arguably correct (they are unexplained by settlement) and was left as is.
