# Example task prompt: `ledgerint`

A real builder prompt, reproduced as sent. This one was a resumed run (an
earlier run hit the usage limit), so it tells the agent to review and rebase
the commits it already pushed. It also shows how we kept a hunk in another
lane's file tiny instead of forbidding it outright. The resulting write-up is
`docs/audit/ledgerint.md`.

---

NAME = ledgerint. Builder (builder-rules.md, incl. RESUMING + FAILOVER; your
branch already has commits from earlier runs: review, rebase, continue).
Migrations: 0092, 0093.

Scope: migrations 0092/0093, `apps/settlement/internal/config/config.go`
(+ test), a small new Go function for the payout disbursement record (at most a
one-line isolated call in `batch.go`), `apps/api/src/webhooks/dispatcher.ts`
ONLY for the disbursement step (teammate B owns the dispatcher otherwise: keep
the hunk tiny), Go test isolation.

1. MEDIUM: the ledger is not immutable. 0007 only checks that groups balance;
   a whole-group UPDATE x10 and a whole-group DELETE both commit. Fix: 0092
   adds a BEFORE UPDATE OR DELETE trigger that raises. First grep everything
   (apps, scripts, seed, all tests incl. Go) for legitimate
   UPDATE/DELETE/TRUNCATE on `ledger_entries` and keep them working. Tests.
2. MED-HIGH: `settlement_payout_disbursements` ("one row per paid batch",
   0057) is only written by the webhook dispatcher, so merchants without an
   endpoint never get one. Fix: write the row in the Go pay path (same
   transaction) with UNIQUE(settlement_batch_id) (0093; dedupe first so it
   applies on a populated DB); the dispatcher tolerates an existing row.
   Tests: no endpoints gives 1 row; running it twice still gives 1.
3. LOW-MED: `PGCONN_SETTLEMENT` overrides `DATABASE_URL` (`config.go` ~72-74),
   the opposite of `ops/README`; `TestLoad_PgconnSettlementOverridesWhenSet`
   locks it in. Fix: `DATABASE_URL` wins; update the test (say so).
4. LOW: Go tests flake in parallel (shared `platform_stats` row): make a plain
   `go test ./...` reliably green.

Note: `docs/audit/ledgerint.md`.
