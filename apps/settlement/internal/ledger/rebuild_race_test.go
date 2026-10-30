package ledger

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// A rebuild must not overwrite a cache move that commits while it runs.
// Capture, refund and payout move merchant_payable and the cache in one
// transaction. A rebuild that read the ledger before such a transaction
// committed then waited for its row lock and, once it came free, wrote the
// older ledger figure over the cache move: the capture disappeared from the
// cache until the next rebuild.
func TestRebuild_KeepsCacheMoveThatCommitsDuringTheRebuild(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()

	rebuilds := map[string]func(merchantID uuid.UUID) error{
		"CLI": func(uuid.UUID) error {
			_, err := RebuildAllBalances(ctx, pool)
			return err
		},
		"CLI --merchant": func(merchantID uuid.UUID) error {
			_, err := RebuildOneBalance(ctx, pool, merchantID)
			return err
		},
		"console button": func(uuid.UUID) error {
			_, err := RefreshBalanceCache(ctx, pool)
			return err
		},
	}
	for name, rebuild := range rebuilds {
		t.Run(name, func(t *testing.T) {
			merchantID := insertActiveMerchant(t, pool)
			postLedgerLeg(t, pool, merchantID, "credit", 10_000)
			if _, err := pool.Exec(ctx, `
				INSERT INTO merchant_balances (merchant_id, cached_payable_fils) VALUES ($1, 10000)
			`, merchantID); err != nil {
				t.Fatalf("seed cache: %v", err)
			}

			// A capture in flight: its ledger leg and cache move are written
			// but not committed yet.
			capture, err := pool.Begin(ctx)
			if err != nil {
				t.Fatalf("begin capture: %v", err)
			}
			defer capture.Rollback(ctx) //nolint:errcheck
			var capturePID int
			if err := capture.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&capturePID); err != nil {
				t.Fatalf("capture pid: %v", err)
			}
			if _, err := capture.Exec(ctx, `
				INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
				VALUES
				  ($1, $2, 'card_scheme_clearing', 'debit',  5000, now(), 'capture: gross'),
				  ($1, $2, 'merchant_payable',     'credit', 5000, now(), 'capture: gross')
			`, uuid.New(), merchantID); err != nil {
				t.Fatalf("capture legs: %v", err)
			}
			if _, err := capture.Exec(ctx, `
				UPDATE merchant_balances SET cached_payable_fils = cached_payable_fils + 5000 WHERE merchant_id = $1
			`, merchantID); err != nil {
				t.Fatalf("capture cache move: %v", err)
			}

			done := make(chan error, 1)
			go func() { done <- rebuild(merchantID) }()
			waitUntilBlockedBy(t, pool, capturePID, done)

			if err := capture.Commit(ctx); err != nil {
				t.Fatalf("commit capture: %v", err)
			}
			if err := <-done; err != nil {
				t.Fatalf("rebuild: %v", err)
			}

			ledgerFils, err := RebuildMerchantBalance(ctx, pool, merchantID)
			if err != nil {
				t.Fatalf("RebuildMerchantBalance: %v", err)
			}
			if got := cachedPayable(t, pool, merchantID); got != ledgerFils {
				t.Fatalf("cached_payable_fils = %d, ledger walk = %d: the rebuild overwrote the capture that committed while it ran", got, ledgerFils)
			}
		})
	}
}

// waitUntilBlockedBy returns once some session is waiting on a lock held by
// backend pid: the rebuild has reached the merchant the capture holds.
func waitUntilBlockedBy(t *testing.T, pool *pgxpool.Pool, pid int, done <-chan error) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var blocked bool
		if err := pool.QueryRow(context.Background(), `
			SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY (pg_blocking_pids(pid)))
		`, pid).Scan(&blocked); err != nil {
			t.Fatalf("poll pg_blocking_pids: %v", err)
		}
		if blocked {
			return
		}
		select {
		case err := <-done:
			t.Fatalf("rebuild finished without waiting for the in-flight capture (err: %v)", err)
		default:
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("rebuild never waited for the in-flight capture")
}
