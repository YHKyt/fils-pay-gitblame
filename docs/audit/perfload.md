# Performance under the hosted budget (perfload)

Scope: the hot paths under the hosted limits (API 0.5 vCPU / 512 MB, reporting 0.5 vCPU / 256 MB, `pg` pool max 5), with a production-sized history.

**Harness.**
- API and reporting ran in their own compose project (`-p filspay-perfload`) on the repo's Node image, with `cpus: 0.5` and `mem_limit` 512m / 256m. The worktree source was mounted read-only.
- Postgres was a dedicated database on the shared dev server, with no limits, as in FP-209.
- Dataset: the deterministic seed cloned 80 times. That gives 170,505 transactions, 1,503,719 ledger entries, 115,668 transaction events and 115,651 outbox events. Delta Wholesale has about 100k transactions.
- Load: small Node scripts (authorize → capture → refund loops, payment-link create → read → pay loops, mixed GETs, concurrent CSV exports). Slow statements came from `log_min_duration_statement` on that database.

## PL1. Every money write commits with a full scan of the ledger — High

**Where:** `db/migrations/0007_ledger_double_entry.sql:43-70` (`check_ledger_group_balance`, deferred constraint trigger `ledger_entries_balance`); fix in `db/migrations/0117_ledger_entries_lookup_indexes.sql`.

**Evidence:** one balanced 3-leg group (like a capture) at 1.5M ledger rows: COMMIT 412-497 ms without the index, 3-4 ms with it. With 10 concurrent authorize/capture/refund loops on the 0.5 vCPU API for 40 s:

| | capture p50 | capture p95 | refund p50 | flows done |
|---|---|---|---|---|
| before | 1857 ms | 2543 ms | 2677 ms | 81 |
| after | 468 ms | 670 ms | 650 ms | 258 |

Loading the dataset itself would not finish: the bulk COMMIT ran for more than 8 minutes before it was cancelled. With the index it finished in 3.4 minutes.

- **What:** the trigger sums `ledger_entries WHERE entry_group_id = v_group_id` once for every inserted leg, at COMMIT. `ledger_entries` had only an index on `(merchant_id, occurred_at)`, so each lookup was a sequential scan of the whole table.
- **Why:** the double-entry guarantee was added as a trigger, but no index was added for the column it looks up.
- **Breaks:** every capture (2-4 legs), refund (2-4 legs), batch close, payout, credit and adjustment commits in time that grows with the size of the ledger. The scan runs while the transaction still holds its row locks and one of the 5 pool connections, so latency and lock waits grow with platform age. At FP-209's scale (Delta Wholesale, 400k events) this is hundreds of milliseconds on every money write.
- **Fix:** `CREATE INDEX idx_ledger_entries_entry_group ON ledger_entries (entry_group_id)`. It is one index and needs no code change. It also serves the reconciliation report's and the settlement service's `EXISTS` / `NOT EXISTS` probes by `entry_group_id`. It is a plain `CREATE INDEX` because `db/migrate.ts` wraps each file in a transaction. It blocks ledger writes only while it builds: the whole migration took 2.8 s on 1.5M rows.
- **Test:** `apps/api/src/db/ledgerLookupIndexes.test.ts` test 1. It checks that the trigger function still does this lookup, then runs `EXPLAIN` on it with `enable_seqscan = off`. Before the fix: `not ok 1`, `Seq Scan on ledger_entries (cost=10000000000.00..)`. After: `ok 1`, with an `Index Cond: (entry_group_id = ...)` plan.

## PL2. Every refund scans the whole ledger under the transaction's row lock — Medium

**Where:** `apps/api/src/payments/processRefund.ts:249-258` (the fee charged, read from the `platform_fee_revenue` legs); fix in `0117`.

**Evidence:** at 1.5M rows, `EXPLAIN ANALYZE` of the lookup gives a Parallel Seq Scan in 89.7-102 ms. With the index it is a Bitmap Index Scan in 0.2 ms. The same 10-loop load (with PL1 already applied):

| | refund p50 | refund p95 | refund p99 | flows done in 40 s |
|---|---|---|---|---|
| before | 662 ms | 1540 ms | 2431 ms | 246 |
| after | 471 ms | 749 ms | 900 ms | 335 |

- **What:** `SELECT ... FROM ledger_entries WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue'`. There is no index with `transaction_id` as its leading column.
- **Why:** FP-300 added this lookup (fee reversal read from what was actually charged) without an index.
- **Breaks:** each refund adds a full ledger scan while it holds `SELECT ... FOR UPDATE` on the transaction and a pool connection. Concurrent refunds and captures of other transactions slow down with it.
- **Fix:** `CREATE INDEX idx_ledger_entries_transaction ON ledger_entries (transaction_id)`, in the same migration. It also turns the reconciliation report's journaled-corrections query (`transaction_id IS NULL`) into an index scan (0.08 ms).
- **Test:** `ledgerLookupIndexes.test.ts` test 2. It checks that `processRefund.ts` still issues this lookup, then runs `EXPLAIN` with `enable_seqscan = off`. On a database with PL1 but not PL2: `not ok 2`, `Seq Scan on ledger_entries`. After: `ok 2`.

## PL3. The reporting worker drains a backlog at one batch per poll interval — Medium

**Where:** `apps/reporting/src/consumer/listener.ts:27-39` (`triggerPass`).

**Evidence:** with the cursor reset over 117k events, under 0.5 vCPU / 256 MB:
- Before: the worker advanced 500 events every ~10-15 s (about 50 events/s). That is about 39 minutes to catch up. The one-shot `catch-up` CLI drained the same backlog in about 110 s.
- After: the worker drained all 117k events in 121 s (about 1000 events/s). RSS was 81 MB.

- **What:** a pass applies at most `REPORTING_CONSUMER_BATCH_LIMIT` (500) events. The next pass waits for the next NOTIFY or the 15 s poll tick. A NOTIFY that arrives while a pass is running is dropped (`if (running) return`).
- **Why:** the loop was copied from the dispatcher's "one pass per trigger" shape. Only the CLI loops until the backlog is empty.
- **Breaks:** after any backlog (downtime, a deploy, a failed pass, a rebuild that resets the cursor, or a burst of traffic), merchant dashboards and reports lag by tens of minutes. An event inserted mid-pass also waits up to 15 s even when the system is idle.
- **Fix:** a `rerun` flag. It is set when a pass applied a full batch, or when a NOTIFY or tick arrived during the pass. When the pass ends, the next one starts at once. There is no change to the pass itself, the cursor or its transaction, so exactly-once is untouched. On error the behaviour is as before: the next trigger retries.
- **Test:** `apps/reporting/src/consumer/listener.test.ts` uses 4 pending events, batch limit 1 and a 10-minute poll interval. Before: `not ok 1`, `expected: 4n actual: 1n` (only the start-up pass ran). After: `ok 1` in 116 ms.

## Checked, no change needed

Numbers are on the 0.5 vCPU API with Delta Wholesale's 100k transactions.

| Path | Serial p50 | Note |
|---|---|---|
| `GET /v1/transactions?limit=50` | 5 ms | keyset on `idx_transactions_merchant_occurred` |
| `GET /v1/settlement/summary` (6 months) | 62 ms | index-only scan (`f43824d`) |
| `GET /v1/settlement/batches`, batch detail, batch transactions | 4-20 ms | |
| `GET /v1/analytics/*`, `/v1/reporting/transactions`, export-summary | 3-15 ms | |
| `GET /v1/transactions/:id`, `/events` | 3-5 ms | |
| Admin merchant list and detail | 6-24 ms | |
| `POST .../recompute-statuses` (100,821 rows) | 0.92 s | admin, one-off |

- **CSV export** (`E1`): 100k rows stream in about 19 s each with 3 at once, RSS 130-134 MB. A client that aborts stops the queries; CPU drops back to 0.1 % within a second.
- **Memory:** three 30 s rounds of mixed reads plus payment loops held RSS at 167-168 MB. There is no growth.
- **`api_keys.last_used_at`:** the write on every request does not limit throughput. Disabling it changed 9904 to 9722 requests in 20 s at 20 concurrency, which is noise: the node process is CPU-bound.
- **Reconciliation, 6 months, Delta:** 240 ms. Its first query aggregates about 300k `merchant_payable` legs, and a seq scan is the right plan when one merchant owns 60 % of the ledger.

## Reported, not fixed (other lanes)

1. **Authorize, capture and payment-link pay hold a pool connection across the acquirer call.** This starves every other request. Lane: payments and idempotency callers. Code: `payments/authorize.ts:57-93`, `payments/capture.ts:99-200` (and so `paymentLinks/pay.ts:102,155`). The `withTransaction` stays open, holding 1 of the 5 connections, for the whole simulated 100-400 ms acquirer call.
   - With 20 concurrent payment loops, a 5 ms `GET /v1/transactions` went to p50 186 ms / p95 674 ms. With 60 loops it went to p50 378 ms / p95 2985 ms. Creating a payment link went from 7 ms to 155 ms p50 while 10 links were being paid.
   - That is about 3 s, against the 5 s `PG_POOL_CONNECTION_TIMEOUT_MS`. A slower real acquirer, or more load, turns this into 500s on unrelated reads.
   - The lock is held on purpose (YA's comment, TOCTOU). The fix has to keep the safety: either reserve and record first and call the acquirer outside the transaction (as refunds already do), or use a separate pool for the payment paths.
2. **Webhook dispatcher.** Lane: webhooks dispatcher. Code: `webhooks/dispatcher.ts`.
   - (a) Step A (`:80-101`) scans every eligible outbox event and anti-joins `webhook_deliveries` on every pass: 141 ms at 115k events and 24k deliveries, growing without bound. It runs every 5 s and again on every NOTIFY, so on every capture.
     - **Re-measured, not changed** (lane w_hook, at `a188c95`, Step A is now `dispatcher.ts:91-117` with the text `merchant_id` join). Synthetic steady state (no due rows, 10 active endpoints), `EXPLAIN ANALYZE` of the exact statement on local Postgres 16:
       - 115,651 events / 23,139 deliveries: 68-75 ms serial (`max_parallel_workers_per_gather = 0`, closest to the 0.5 vCPU API), 36-46 ms with 2 workers. Plan: Seq Scan of `outbox_events` (109,869 rows pass the type filter) → Hash Join to endpoints → Hash Anti Join against a Seq Scan of **every** delivery.
       - 462,604 events / 92,556 deliveries (4×): **1.05-2.1 s** over five runs, with most pages read from outside shared buffers (`shared read=25017`). Allowing workers does not change the plan. It flips to a fast-start one because of `LIMIT 500`: Index Scan of `outbox_events_pkey` in id order over the whole 172 MB heap, a Nested Loop that evaluates `merchant_id::text = payload->>'merchantId'` 4.4M times (`Rows Removed by Join Filter: 4302204`), and a Merge Anti Join on an external sort of all deliveries. The planner expects the 500 due rows early; in the steady state there are none, so it reads everything. 4× the data costs 14-21× the serial time.
       - Ceiling of any bound: the same join and anti-join over only the newest 1,000 ids (`oe.id > max(id) - 1000`, a pkey range scan) takes 0.4 ms at both sizes.
     - **Why no change fit a small fix.** None of the cheap bounds is safe:
       - An id margin ("the last delivery's `outbox_event_id` minus N") misses a late-committing lower id (sqlhunt, reporting RP1), whatever N is.
       - A per-endpoint "last delivery" bound does not move for a quiet merchant, so its endpoint still scans every newer event of every merchant.
     - **What is safe (for the lane).** `ORDER BY oe.id LIMIT` gives a prefix property. A pass that created the delivery for event M also handled every due pair with a lower id that its snapshot could see. Below M, only events from transactions still running at that snapshot can be missing, and those have `xact_id >= pg_snapshot_xmin` of that snapshot (`xact_id` and its index exist since 0096). So a pass can skip `id < M AND xact_id < xmin`. It must be `<` and not `<=`, because `LIMIT` can cut between two endpoints of event M itself. This needs:
       - the pass to store (M, xmin), because no column records a pass's snapshot;
       - a full scan, bounded by `we.created_at`, for endpoints that became active after that snapshot. Today a re-enabled endpoint is backfilled from its `created_at`, because `update.ts` only flips `status`, so this behaviour must be kept.

       That is a migration plus state, so it is left to the dispatcher lane. Not tried: steering the planner off the fast-start plan (for example a `MATERIALIZED` CTE without the LIMIT, then top-N). It would at best stay linear, and it costs more on a real backlog.
     - **Reproduce:** the generator and EXPLAIN scripts were scratch files. The shape is 200 merchants, 10 of them with one active endpoint each; 21 % of events belong to those 10; types are 70 % captured, 10 % voided, 10 % refund, 5 % settlement.paid and 5 % authorized; every due pair already has its delivery. Then double the table twice.
   - (b) A pass sends at most 100 deliveries (`STEP_B_BATCH_LIMIT`) and then waits for the next NOTIFY or 5 s tick. Measured: 20 deliveries/s; a 115k backlog takes about 96 minutes. Because Step B orders by `next_attempt_at`, a fresh `transaction.captured` webhook waits behind the whole backlog.
   - The fix for (b) is the same `rerun` loop as PL3. (a) needs a watermark, or a `NOT EXISTS` driven from recent events only.

## Suspicious, not changed

- **Transaction search** (`transactions/query.ts:105-115`): `ILIKE '%x%'` over a merchant's rows costs 138 ms p50 (5 concurrent: 193 ms) for a term that matches nothing at 100k rows. `pg_trgm` is available, but the `OR id::text = $5` branch and the `$5 IS NULL OR` generic-plan form would also need a query rewrite before a trigram index could be used (backlog FP-244). Left as is: it is linear in one merchant's rows, not the platform's.
- **Reconciliation's refund-event query** (`settlement/query.ts:337-352`) seq-scans `transaction_events` by event type: 20 ms at 115k events. It is linear, but small.
