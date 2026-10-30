# Settlement CLI, scheme export and daemon (gosettle2)

Scope: `apps/settlement` scheme file export, payout notifications, daemon
scheduling and configuration, and each CLI subcommand checked against
`docs/RUNBOOK.md`. Earlier write-ups (settlebatch, settlemdr, settleguards,
settlerun, ledgerint, settlefix2, money-and-settlement) were read first and
nothing here repeats them.

## GS1. `export-scheme-file` writes an empty file for an open or unknown batch — Medium
**Where:** `apps/settlement/internal/settlement/scheme_export.go` (`ExportSchemeFile`)
**Evidence:** old code, `TestExportSchemeFileRefusesBatchWithoutFrozenLines`: `ExportSchemeFile(open batch) = 0 line(s), nil error` and `ExportSchemeFile(unknown batch) = 0 line(s), nil error`; the existing file at `--out` was replaced by an empty one.

- **What:** exporting a batch that is still `open`, or a mistyped batch id, printed `export-scheme-file: wrote 0 line(s) to <path>` and exited 0.
- **Why:** scheme lines are written once, when `CloseBatch` closes the batch. The exporter only read `scheme_export_lines` for the id and never checked that the batch existed or had closed, so "no lines yet" and "no such batch" looked exactly like a closed day with no captures.
- **Breaks:** an operator can hand the scheme an empty file for a day that had sales (the scheme then pays nothing for it), and a good file already at `--out` is overwritten with nothing.
- **Fix:** read the batch status first; refuse unless it exists and is `closed` or `paid`, before any file is written. A closed batch with no captures still exports an empty file. Smallest change: one query and two error returns in the exporter; the CLI already exits non-zero on an error. RUNBOOK updated with one sentence.
- **Test:** `scheme_export_unclosed_test.go`: open batch and unknown id return an error and leave the existing file untouched; a closed empty batch returns `(0, nil)`.

## GS2. Daemon settings that stop the daily close were accepted — Low-Medium
**Where:** `apps/settlement/internal/config/config.go` (`Load`)
**Evidence:** old code, `TestLoad_RejectsDaemonValuesThatStopTheDailyClose`: `Load accepted map[SETTLEMENT_DAEMON_POLL_INTERVAL_SECONDS:0]: poll=0s`, `... RUN_DELAY_MINUTES:1440]: delay=1440m`, `... :2000]`, `... :-1]`. `time.NewTicker(0)` panics: `panic: non-positive interval for NewTicker`.

- **What:** `SETTLEMENT_DAEMON_POLL_INTERVAL_SECONDS` of 0 or less, and `SETTLEMENT_DAEMON_RUN_DELAY_MINUTES` of 1440 or more (or negative), loaded without error.
- **Why:** `scheduler.Run` passes the poll interval to `time.NewTicker`, which panics on a non-positive value, so the daemon crash-loops at boot. `runIfDue` fires when now is past today's Bahrain midnight plus the delay; a delay of a whole day or more puts that time past the next midnight on every wake, so the check never passes.
- **Breaks:** with a long delay the daemon runs, logs, and never closes or pays a business day, with no error anywhere. With a zero interval it never starts.
- **Fix:** `Load` rejects a poll interval <= 0 and a run delay outside 0-1439 with a clear message. Smallest change: two bounds checks where the values are parsed.
- **Test:** `daemon_bounds_test.go`: 0, -5 s; -1, 1440, 2000 min refused; 1 s, 0 min and 1439 min accepted.

## GS3. A partial `run-batch` failure hides the merchants that were paid — Medium
**Where:** `apps/settlement/cmd/settlement/main.go` (`run-batch`)
**Evidence:** old code, `TestRunBatchCLI_PartialFailureStillReportsAndNotifiesPaidMerchants`: the good merchant's batch is `paid`, but the output is only the `log.Fatalf` line with the split-weight errors (`output does not report the merchant that was paid`), and `settlement.paid events for the paid batch = 0, want 1`.

- **What:** when one merchant failed, `run-batch` printed only the error. The merchants it had already closed and paid were not listed, and their `settlement.paid` notifications were not enqueued.
- **Why:** `RunDailyBatch` was changed (settlerun) to carry on past a failing merchant and return the report together with the joined failures. The CLI still called `log.Fatalf` as soon as `err != nil`, which skipped the report loop and `EnqueuePayoutNotifications`.
- **Breaks:** a backfill with one misconfigured merchant looks like a total failure although money moved for everyone else. An operator who re-runs or investigates cannot see what was paid, and those merchants get no payout webhook until a daemon tick happens to enqueue it (never, if the daemon is not running).
- **Fix:** keep the error, print the report, enqueue the notifications, then exit non-zero with the failures. Smallest change: the existing `log.Fatalf` moves below the existing report and notify code.
- **Test:** `run_batch_partial_test.go` runs the real CLI in a child process on a fresh date with one normal merchant and one split parent whose weights total 5000: non-zero exit, the paid merchant is in the output, and its batch has exactly one `settlement.paid` event.

## GS4. Scheme file fallback amount has sixteen decimals — Low
**Where:** `apps/settlement/internal/settlement/scheme_export.go` (`LoadSchemeExportLines`)
**Evidence:** old code, `TestExportSchemeFileFallbackAmountHasTwoDecimals`: file lines `acq-ref-...,93.2700000000000000,BHD,1` and `acq-ref-...,5.0000000000000000,BHD,2`. In SQL, `(93270::numeric/1000)::text` = `93.2700000000000000`.

- **What:** for a line whose 0050 `amount` column is NULL, the file carried `93.2700000000000000` instead of `93.27`.
- **Why:** the reader falls back to `amount_fils::numeric / 1000`. Postgres numeric division is unscaled, so the text has sixteen fractional digits. The column is nullable on purpose (0050) and the fallback exists for such rows, but its output does not meet the two-decimal format the scheme takes (ADR-0002).
- **Breaks:** the scheme rejects or misreads the line. Today's `CloseBatch` always fills `amount`, so only rows from another writer or before 0050's backfill hit it.
- **Fix:** cast the fallback to `numeric(10,2)`, the column's own scale. It is exact because `amount_fils` is always a multiple of 10 (CHECK).
- **Test:** `scheme_export_legacy_test.go`: lines with NULL `amount` export as `93.27` and `5.00`.

## Reported, not fixed

- **Fixed in `8448f5e`: the admin `run-batch` (internal API) discarded the report on a partial failure.** `internal/internalapi/server.go` answered 500 `run_batch_failed` and dropped `report` whenever `RunDailyBatch` returned an error, although the other merchants were paid. This was the same problem as GS3 on the admin path. The handler still answers 500 `run_batch_failed`, now with `message` (the joined failures), `businessDate` and `merchantResults`; `apps/api`'s settlement client words the paid merchants (merchant, batch, net) and the failure into the admin's `{ error, message }` answer and the audit row. Tests: `internalapi/run_batch_partial_test.go` (old: `businessDate = ""`, `merchantResults [] does not list the merchant that was paid`) and `apps/api/src/admin/settlementClient.partialRunBatch.test.ts` (old: the message was the raw body cut at 500 characters). Still open: the internal API does not enqueue `settlement.paid`; the daemon's next tick does.
- **Fixed in `79c17db`: days missed while a merchant is suspended were never closed automatically.** A merchant not eligible at the nightly run gets no batch for that day; the daemon only ever retried yesterday, so after reactivation those captures stayed unbatched until someone ran `run-batch --date` for each day. Each daemon run now first runs `settlement.FindMissedBusinessDays` over the 31 business days before yesterday. It returns each (merchant, day) where a merchant that is eligible now has unclaimed live capture events and no closed or paid batch, and the daemon runs `RunDailyBatch` for that merchant and day, oldest first (`closeMissedDays` in `scheduler/daemon.go`). It cannot settle twice: there is one batch row per `(merchant_id, batch_date)` (unique, locked `FOR UPDATE`), a closed or paid batch is a no-op, events are claimed only while `settlement_batch_id IS NULL` under `FOR UPDATE`, and `PayoutBatch` pays only a `closed` batch. RUNBOOK updated. Test: `scheduler/missed_days_test.go` (suspended merchant, capture 3 days ago, reactivated, `runIfDue` twice). Old code: `{batches:0 status:none payoutFils:0 paidEvents:0 unbatchedEvents:1}`. Fix: one paid batch, 97,500 fils paid once, one `settlement.paid`, and a capture 40 days back left alone. Limits: anything older than 31 days still needs `run-batch --date`. A missed day whose close succeeded but whose payout failed stays `closed` and is not retried; the same happens to yesterday's batch once the day rolls over.
- **Partly fixed in `60215c2`: the notification scan reads every paid batch on every tick.** `EnqueuePayoutNotifications` anti-joins all `paid` batches against `outbox_events` every poll (no index on `outbox_events (event_type, aggregate_id)`). On a local copy with 182,500 paid batches and 3.18 M outbox rows it took 259 ms per tick, and each insert's re-check is a 150 ms sequential scan. It grows with history. An index alone did not help the scan (473 ms), because the scan is not bounded by date. Migration `0118_outbox_events_type_aggregate_index.sql` adds the index. It is a plain `CREATE INDEX IF NOT EXISTS`, because the runner's transaction rules out `CONCURRENTLY`; on a large outbox, build it `CONCURRENTLY` by hand first under the same name. `EXPLAIN (ANALYZE, BUFFERS)` was run on 6,000 paid batches and 41,990 outbox rows. The re-check went from a `Seq Scan` on `outbox_events` (566 buffers, 41,990 rows filtered) to an `Index Only Scan` (3 buffers, 0 heap fetches). On the scan, the outbox side of the hash anti-join went from a `Seq Scan` (566 buffers, 36,000 rows filtered) to a `Bitmap Index Scan` (120 buffers), 671 to 225 buffers in all, at the same ~7.5 ms. Still open: the scan still hashes every paid batch on every tick. Bounding it needs a code change, for example a "notified" marker on the batch or a `paid_at` window.
- **Fixed in `dec2109`: `status.go` logged the "next check-in" as the last check plus 24 h** in the process TZ. The real next check is one poll interval later. `Run` now logs it after each wake as that wake's tick plus the poll interval (still in the process TZ). The log does not give the next close, which is the next Bahrain midnight plus the delay. Logs only. `status_test.go`'s `TestEstimateNextRunAt` asserted the 24 h estimate and now expects tick + 60 s.
- **Baseline flake:** with the whole Go suite on one database, `TestCloseBatch_PartialRefundExactFils` and `TestCloseAndPayout_MerchantBalancesIncremental` sometimes fail on cache values (e.g. `19500, want 9750`). Both pass alone and with `-p 1`. The likely cause is the ledger package's full rebuild and refresh tests rewriting every merchant's cache while the settlement package runs in parallel. `agent/settlebal` changes this area.
