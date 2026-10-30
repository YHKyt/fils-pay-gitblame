package scheduler

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/settlement"
)

func mustPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping DB-backed test")
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func cachedPayable(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID) int64 {
	t.Helper()
	var n int64
	if err := pool.QueryRow(context.Background(),
		`SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&n); err != nil {
		t.Fatalf("read cache: %v", err)
	}
	return n
}

// Regression: ARCHITECTURE.md and ADMIN.md say the daemon refreshes the
// balance cache at 02:00 Bahrain time, but the daemon never did. A drifted
// cache stayed wrong until someone pressed the console button.
//
// The merchant's merchant_payable ledger balance is 40,000 fils and its
// cache says 99,999. Before 02:00 Bahrain nothing changes; the first wake
// at or after 02:00 rewrites the cache from the ledger; a later wake the
// same day does not run it again; the next day it runs again.
func TestRefreshBalancesIfDue_NightlyAt0200Bahrain(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()

	var merchantID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
		VALUES ($1, 250, 'active', false) RETURNING id
	`, "scheduler-refresh-test-"+uuid.New().String()).Scan(&merchantID); err != nil {
		t.Fatalf("insert merchant: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES ($1, $2, 'merchant_payable', 'credit', 40000, now(), 'test leg'),
		       ($1, $2, 'card_scheme_clearing', 'debit', 40000, now(), 'test leg (other side)')
	`, uuid.New(), merchantID); err != nil {
		t.Fatalf("post ledger legs: %v", err)
	}
	drift := func() {
		t.Helper()
		if _, err := pool.Exec(ctx, `
			INSERT INTO merchant_balances (merchant_id, cached_payable_fils) VALUES ($1, 99999)
			ON CONFLICT (merchant_id) DO UPDATE SET cached_payable_fils = 99999
		`, merchantID); err != nil {
			t.Fatalf("drift cache: %v", err)
		}
	}
	drift()

	bh := settlement.BusinessLocation()
	day := time.Date(2026, 10, 30, 0, 0, 0, 0, bh)

	// 01:59 Bahrain (22:59 UTC the day before): not due yet.
	last := refreshBalancesIfDue(ctx, pool, day.Add(119*time.Minute).UTC(), time.Time{})
	if !last.IsZero() {
		t.Errorf("refresh ran before 02:00 Bahrain: last = %v", last)
	}
	if c := cachedPayable(t, pool, merchantID); c != 99_999 {
		t.Errorf("cache before 02:00 = %d, want untouched 99999", c)
	}

	// 02:05 Bahrain: due, cache rebuilt from the ledger.
	last = refreshBalancesIfDue(ctx, pool, day.Add(125*time.Minute), last)
	if !last.Equal(day) {
		t.Errorf("last refresh = %v, want %v", last, day)
	}
	if c := cachedPayable(t, pool, merchantID); c != 40_000 {
		t.Errorf("cache after 02:00 refresh = %d, want 40000 (merchant_payable ledger balance)", c)
	}

	// Later the same day: already done, no second refresh.
	drift()
	last = refreshBalancesIfDue(ctx, pool, day.Add(20*time.Hour), last)
	if c := cachedPayable(t, pool, merchantID); c != 99_999 {
		t.Errorf("cache after a second wake the same day = %d, want 99999 (one refresh per day)", c)
	}

	// Next day, 02:00 exactly: runs again.
	next := day.AddDate(0, 0, 1)
	last = refreshBalancesIfDue(ctx, pool, next.Add(2*time.Hour), last)
	if !last.Equal(next) {
		t.Errorf("next-day last refresh = %v, want %v", last, next)
	}
	if c := cachedPayable(t, pool, merchantID); c != 40_000 {
		t.Errorf("cache after next-day refresh = %d, want 40000", c)
	}
}
