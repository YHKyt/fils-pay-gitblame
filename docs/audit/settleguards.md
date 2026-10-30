# Settlement run guards: business day, split weights, shutdown

Three fixes on the settlement run path. Each one has a regression test that
fails on the old code and passes on the fix (proof quoted under **Test**).
Ground truth used: the settlement business day is Asia/Bahrain (UTC+3,
`internal/settlement/window.go`); money is integer fils (ADR-0001).

---

## G1. Closing a business day before it ends strands its later captures — High

**Where:** `apps/settlement/internal/internalapi/server.go` (`handleRunBatch`), `apps/settlement/cmd/settlement/main.go` (`run-batch`), `apps/api/src/routes/admin.ts` (`POST /v1/admin/settlement/run-batch`); the selection itself is `CloseBatch` in `internal/settlement/batch.go`.

**Evidence:** with the old code, `run-batch` for today *and for tomorrow* returned 200 and left a `paid` batch (test output below). `docs/ADMIN.md` told finance that re-running "is always safe".

- **What:** all three entry points accepted any well-formed date, including today and future dates.
- **Why:** `CloseBatch` only selects capture events inside that one Bahrain day's window, marks the batch `closed`, and never looks at the day again: a second run is an idempotent no-op. So a run at 13:00 closes and pays the morning's captures. A 40 BD capture at 15:00 the same day falls inside a window that is already closed, and no later batch ever selects it.
- **Breaks:** the merchant is never paid for anything captured after the early run, and nothing shows it. A future date closes an empty batch, and that day's captures are then lost the same way.
- **Fix:** refuse any business date whose Bahrain window ends after now. `settlement.RequireBusinessDayOver` (new file `business_day_guard.go`, built on the existing `BusinessDayWindow`) is called by the CLI (non-zero exit, message on stderr) and by the internal API (`422 {"error":"business_day_not_over","message":...}`). The admin route makes the same check before it writes an audit row or calls settlement, and answers `422 business_day_not_over` with a message naming the latest date that can be closed. The console already shows `message`, and its default date is already yesterday. `ADMIN.md` and `RUNBOOK.md` now say that today is refused. This is the smallest change because it adds one check at each entry point and leaves `CloseBatch` and the scheduler alone. The scheduler only ever runs the day that has just ended.
- **Test:** `internalapi/run_batch_business_day_test.go` (today and tomorrow get 422, with no batch and no batched event; yesterday is closed and paid), `cmd/settlement/run_batch_guard_test.go` (runs the real `main()` in a child process: today and tomorrow exit non-zero and write nothing; yesterday exits 0 and is paid), `settlement/business_day_guard_test.go` (edges at Bahrain midnight, and Bahrain vs UTC day), and `routes/admin.test.ts` "refuses a business day that has not ended" (422, settlement never called, no audit row; yesterday is still 200).
  - Before: `run-batch 2026-10-30: status = 200, want 422`; `run-batch --date=2026-10-31 exited 0, want non-zero`; `left a "paid" batch, want none`; admin `expected: 422 actual: 200`.
  - After: all PASS.

## G2. Split weights never validated: children over- or under-paid — Medium-Low

**Where:** `apps/settlement/internal/splits/allocate.go` (`PayoutSplitBatch`), `apps/settlement/internal/splits/shares.go`

**Evidence:** old code, net payout 97,500 fils: weights 6000+6000 gave `status=paid legs=4 splitRows=2 cached=-19500`, and 3000+3000 gave `status=paid ... cached=39000`.

- **What:** `PayoutSplitBatch` paid each child `net × weight / 10000` without checking that the weights add up to 10000.
- **Why:** migration 0045 only checks each row (`0 < weight <= 10000`). Its comment leaves the "sum to 10000" rule to whoever writes the rows. The seed enforces it, but nothing else does, and the payout trusted it. The existing test `TestChildShares_PartialWeightsLeaveParentRemainder` described the leftover as intended.
- **Breaks:** over 10000, the children receive more than the batch's net payout (117,000 for 97,500) and the parent's `merchant_payable` goes negative (−19,500). Under 10000, the batch is marked `paid` while the remainder stays in the parent's payable, and no later batch ever pays it out.
- **Fix:** `ValidateWeights` returns `ErrSplitWeightsNotWhole` unless the weights sum to exactly 10000. `PayoutSplitBatch` calls it after reading the children and before writing anything. The transaction rolls back, the batch stays `closed`, and no legs, split rows or cache changes are written. The error stops the run, so the configuration gets fixed and the run is then repeated. This is the smallest change because `ChildShares`' arithmetic is unchanged.
- **Test:** `splits/payout_weights_test.go` checks that 6000+6000 and 3000+3000 are refused, leaving the batch `closed`, 0 legs, 0 split rows and the cache at 97,500, and that 5000+3000+2000 pays exactly 97,500. `shares_exact_test.go`: the partial-weights test above locked in the bug, so it is replaced by `TestValidateWeights_RequiresExactly10000`.
  - Before (old `allocate.go`): `err = <nil>, want ErrSplitWeightsNotWhole`; `status=paid legs=4 splitRows=2 cached=-19500, want closed/0/0/97500`.
  - After: PASS.

## G3. SIGTERM cancels an in-flight admin run despite the "30 s graceful" shutdown — Medium

**Where:** `apps/settlement/internal/internalapi/server.go` (`Serve`), `apps/settlement/cmd/settlement/main.go` (`daemon`)

**Evidence:** old code: `PayoutBatch: update lifetime payout monitoring estimate: context canceled`, `status=500`, `batch status after shutdown = "closed", want paid`.

- **What:** `BaseContext` returned the daemon's own ctx, so every request context was cancelled as soon as SIGTERM arrived. `Shutdown` was given 30 s to drain requests, but by then they had already been cancelled. Separately, `main` returned as soon as `scheduler.Run` returned, without waiting for `Serve`.
- **Why:** the old comment said cancelling in-flight work was intended. But `RunDailyBatch` is a sequence of separate transactions (close, then pay out, per merchant), so cancelling it stops the run between steps.
- **Breaks:** a deploy or restart during an admin run leaves the current merchant's batch `closed` but unpaid, and later merchants unprocessed. Re-running that date repairs it, because `PayoutBatch` pays a `closed` batch, but only if someone notices.
- **Fix:** request contexts now come from `context.WithoutCancel(ctx)` and are cancelled only after `Shutdown`'s 30 s wait ends. The daemon waits for `Serve` to return before `main` exits and the pool is closed. That is two small hunks, and the handler is unchanged.
- **Deployment caveat:** the 30 s drain only helps if the process is allowed to live that long after SIGTERM. Docker's default stop timeout is 10 s, after which it sends SIGKILL, and the `settlement` service in `ops/docker-compose.yml` sets no `stop_grace_period` (checked at `d68585e`). Under compose, a `docker compose stop`/redeploy therefore still kills an admin run after 10 s. The service needs `stop_grace_period` above 30 s (for example `35s`); `agent/fixpack1` was meant to add it and is not merged at `d68585e`.
- **Test:** `internalapi/serve_drain_test.go` holds the merchant row so the payout step waits after `CloseBatch` has committed, cancels the daemon ctx, then releases the row. The request must finish with 200, the batch must be `paid`, and `Serve` must return nil. The `main.go` wait has no test of its own, because `daemon` runs until a signal arrives.
  - Before: `status=500 err=<nil>, want 200`; `batch status after shutdown = "closed"`.
  - After: PASS.

## Not fixed (reported only)

- **One merchant's error stops the whole daily run.** `RunDailyBatch` (`batch.go`) returns on the first `CloseBatch`, `IsSplitParent`, `PayoutBatch` or `PayoutSplitBatch` error. It skips only `ErrMerchantNotEligible`. Every merchant after the failing one, in id order, is not settled that day. G2 adds a new error of this kind, so a misconfigured split parent now blocks later merchants until its weights are fixed. That is better than silently paying the wrong amounts, but continuing past one merchant and reporting the failures should be decided in `batch.go`, which is not in this change.
- **The scheduler's own run is cancelled by SIGTERM in the same way.** `scheduler/daemon.go` passes the daemon ctx to `RunDailyBatch`. On restart, the next run of the same day repairs it, as described in G3.
- **Fixed in `e38dc15`: a client disconnect also cancelled an admin run.** `r.Context()` is cancelled when apps/api gives up. Its default timeout is 30 s (`SETTLEMENT_INTERNAL_REQUEST_TIMEOUT_MS`), so an all-merchant run that took longer stopped partway, the same way as in G3, and a `recalculate-mdr` rolled back. Both handlers now run under `context.WithoutCancel(r.Context())` with their own 30 min limit (`runContext` in `server.go`). The run is still cancelled when `Serve`'s 30 s graceful-shutdown wait ends, as G3 intends. Test: `internalapi/run_batch_disconnect_test.go` hangs up while the run waits on a lock. Old code: `batch status after the caller hung up = "closed"` (`PayoutBatch: ... context canceled`), and the recalculation left `fee = 2500 fils, unchanged`. Fix: the batch is paid and the recalculation is committed. Still open: on a timeout, apps/api answers `502 settlement_unreachable`, and its client comment says "Nothing ran". The run now carries on, so the admin should check the result before running it again. Running it again is safe: per merchant and day, `CloseBatch` and `PayoutBatch` serialize on the batch row, and a concurrent `RecalculateMDR` waits on the batch rows and then finds no difference.
