# Ledger integrity, payout disbursements and settlement config

Five findings in the settlement worker and the ledger schema. Each has a regression test that fails on the code before the fix and passes after it.

## Ledger entries can be rewritten or deleted while staying balanced — Medium

**Where:** `db/migrations/0007_*` (balance trigger), table `ledger_entries`. Fix: `db/migrations/0092_ledger_entries_append_only.sql`.
**Evidence:** `TestLedgerEntries_BalancedRewriteIsRejected` (`apps/settlement/internal/ledger/append_only_test.go`) on a database without the 0092 trigger: `UPDATE of a whole group x10 committed; ledger_entries must be append-only`. With 0092: `ok`.

- **What:** 0007 says the ledger is immutable, but its deferred trigger only checks that every touched entry group still nets to zero at commit. An `UPDATE` that multiplies every leg of a group by 10, or a `DELETE` of a whole group, leaves the group balanced, so both commit.
- **Why:** "balanced" is not the same as "unchanged". Nothing rejects a mutation of an already-posted leg.
- **Breaks:** anyone with write access (a bad script, a compromised role, a mistaken console query) can silently rewrite history. Merchant balances rebuilt from the ledger (ADR-0004) then reproduce the forged figures, and there is no trace of the original postings.
- **Fix:** a `BEFORE UPDATE OR DELETE ... FOR EACH ROW` trigger that raises, for every role including the owner. Corrections are already reversing entry groups. A grep of `apps/`, `scripts/`, `db/` and every TS and Go test found no legitimate `UPDATE`/`DELETE` on `ledger_entries`. `TRUNCATE` (the seed's reset) fires no row trigger and keeps working; `npm run seed` passes twice in a row. One trigger is the smallest change that enforces the documented rule.
- **Test:** the test posts a balanced group, then tries the x10 update and the whole-group delete; both must fail and the legs must be unchanged.

## Merchants without a webhook endpoint never get a payout disbursement record — Medium-High

**Where:** `apps/settlement/internal/settlement/batch.go` (`PayoutBatch`), `apps/settlement/internal/splits/allocate.go` (`PayoutSplitBatch`), `apps/api/src/webhooks/dispatcher.ts` (previous only writer). Fix: `apps/settlement/internal/disbursement/disbursement.go`, `db/migrations/0093_settlement_payout_disbursements_one_per_batch.sql`.
**Evidence:** with the two `disbursement.Record` calls removed: `after payout: 0 disbursement rows (amount 0, ref ""), want 1 row of 97500 with a disb_ reference` and `split batch: 0 disbursement rows (amount 0), want 1 row of 10001`. With them: all four disbursement tests pass.

- **What:** `settlement_payout_disbursements` is "one row per paid batch" (0057) and `docs/ARCHITECTURE.md` says the pay step records it, but the only writer was the webhook dispatcher, as a side effect of delivering `settlement.paid`. Deliveries only exist for active endpoints.
- **Why:** the record of money leaving was tied to whether the merchant had configured a webhook, not to the payout itself. Nothing enforced one row per batch either; the 2026-08-21 incident left two rows per batch.
- **Breaks:** a merchant without an endpoint is marked paid, with payout legs posted, but has no disbursement instruction or reference. Finance cannot reconcile the payout against the bank rail, and duplicates can mean two instructions for one batch.
- **Fix:** `disbursement.Record` inserts the row inside the same transaction that marks the batch paid, with `ON CONFLICT (settlement_batch_id) DO NOTHING`, and writes nothing for a zero or negative net payout (the column has `CHECK > 0`). It is one isolated call in each pay path. 0093 first moves existing duplicates (keeping the earliest row per batch) into `settlement_payout_disbursement_duplicates`, then adds `UNIQUE (settlement_batch_id)`, so it applies on a populated database without losing data. The dispatcher's existing `NOT EXISTS` insert already skips a batch that has a row, so `dispatcher.ts` is unchanged; `apps/api/src/webhooks/payoutDisbursement.test.ts` covers that.
- **Test:** no endpoints gives exactly 1 row (plain and split payout); a re-pay and four repeated `Record` calls still give 1 row; a zero net payout gives none.

## PGCONN_SETTLEMENT overrides DATABASE_URL — Low-Medium

**Where:** `apps/settlement/internal/config/config.go` (`Load`), `apps/settlement/internal/config/config_test.go`.
**Evidence:** old `config.go` against the new tests: `--- FAIL: TestLoad_DatabaseURLWinsOverPgconnSettlement` and `--- FAIL: TestLoad_PgconnSettlementOnlyWhenDatabaseURLUnset`. New code: `ok`.

- **What:** `ops/README.md` says `PGCONN_SETTLEMENT` only applies when `DATABASE_URL` is unset. `Load()` did the opposite: whenever it was set, it replaced `DATABASE_URL`.
- **Why:** the variable is documented as a settlement role or read replica, but the worker has a single pool, and every batch close and payout writes through it.
- **Breaks:** a deployment that sets both (the code's own comments show the authors were unsure whether compose does) sends all settlement writes to the replica or the wrong role: they fail, or land in the wrong database.
- **Fix:** `DATABASE_URL` always wins; `PGCONN_SETTLEMENT` is only the fallback. The existing test `TestLoad_PgconnSettlementOverridesWhenSet` asserted the buggy precedence and was replaced.
- **Test:** both set gives `DATABASE_URL`; only `PGCONN_SETTLEMENT` set uses it; neither set is still a boot error.

## Concurrent full balance rebuilds deadlock — Low-Medium

**Where:** `apps/settlement/internal/ledger/refresh.go` (`RefreshBalanceCache`), `apps/settlement/internal/ledger/rebuild.go` (`RebuildAllBalances`).
**Evidence:** `TestBalanceRebuilds_ConcurrentCallsDoNotDeadlock` (four rebuilds at once): 5/5 runs hit `40P01 deadlock detected` before, 5/5 pass after.

- **What:** the console's "Rebuild cached balances" wrote `merchant_balances` while ranging over a Go map, whose order is random on every call.
- **Why:** two rebuilds running at once lock the same rows in different orders, which is the textbook deadlock.
- **Breaks:** a double click, or the button racing the `rebuild-balances` CLI, aborts one rebuild. It also made `go test ./...` fail about one run in four.
- **Fix:** both full rebuilds write in `merchant_id` order (`ORDER BY` plus a slice instead of the map), so a second rebuild waits instead of deadlocking. Values written are unchanged.
- **Test:** as above.

## Platform volume test flakes under parallel packages — Low

**Where:** `apps/settlement/internal/settlement/platform_volume_test.go`.
**Evidence:** with a concurrent `CloseBatch` writer, the old test failed 200/200 runs (read 51,010,000 instead of 51,000,000); the new one passed 200/200. This fixes one source of cross-package interference, not all of them: the Go suite is green only with `go test -p 1 ./...`. At `d68585e`, plain `go test -count=1 ./...` on a fresh database still failed in `internal/settlement` in 2 of 2 runs (`TestRunDailyBatch_SettlesTheFeeBookedAtCapture`, once also `TestCloseBatch_RefundShortfallCarriedForward`), while `-p 1` passed 2 of 2.

- **What:** `go test ./...` runs packages in parallel against one database, and every `CloseBatch` adds to the single `platform_stats` row. The test reset that row in autocommit and then locked it in a new transaction, so a close from another package could land in between.
- **Why:** the reset and the lock were not in one transaction.
- **Breaks:** CI is red at random, which hides real failures (CI should run the Go suite with `-p 1`, see the evidence above).
- **Fix:** the test reads the counter under `FOR UPDATE` inside its own transaction and asserts the growth from that baseline; the lock is held until rollback. Test-only change.
- **Test:** the test itself, under a concurrent writer.
