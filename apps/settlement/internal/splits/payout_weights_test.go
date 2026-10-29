package splits

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func mustPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping DB-backed test (run against a real, migrated Postgres)")
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatalf("failed to connect to DATABASE_URL: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// seedSplitBatch creates a parent with one child per weight and a closed
// batch for the parent with the given net payout (cached in
// merchant_balances, as CloseBatch would have left it).
func seedSplitBatch(t *testing.T, pool *pgxpool.Pool, netPayout int64, weights ...int64) (parentID, batchID uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	newMerchant := func() uuid.UUID {
		var id uuid.UUID
		if err := pool.QueryRow(ctx, `
			INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
			VALUES ($1, 250, 'active', false) RETURNING id
		`, "split-weights-"+uuid.NewString()).Scan(&id); err != nil {
			t.Fatalf("insert merchant: %v", err)
		}
		return id
	}
	parentID = newMerchant()
	for _, w := range weights {
		if _, err := pool.Exec(ctx, `
			INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps)
			VALUES ($1, $2, $3)
		`, parentID, newMerchant(), w); err != nil {
			t.Fatalf("insert split child: %v", err)
		}
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
		VALUES ($1, '2026-04-20', 'closed', $2, 0, $2, now()) RETURNING id
	`, parentID, netPayout).Scan(&batchID); err != nil {
		t.Fatalf("insert batch: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, last_settlement_batch_id, updated_at)
		VALUES ($1, $2, $3, now())
	`, parentID, netPayout, batchID); err != nil {
		t.Fatalf("insert balance: %v", err)
	}
	return parentID, batchID
}

// Regression: split weights were never checked. 6000+6000 on a 97,500 fils
// net payout paid the children 117,000 and left the parent's
// merchant_payable at -19,500; 3000+3000 marked the batch paid while 39,000
// stayed in the parent's payable for good. Both must be refused with the
// batch left 'closed' and nothing posted.
func TestPayoutSplitBatch_RefusesWeightsNotSummingTo10000(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()

	for _, weights := range [][]int64{{6000, 6000}, {3000, 3000}} {
		parentID, batchID := seedSplitBatch(t, pool, 97_500, weights...)

		_, err := PayoutSplitBatch(ctx, pool, batchID)
		if !errors.Is(err, ErrSplitWeightsNotWhole) {
			t.Errorf("weights %v: err = %v, want ErrSplitWeightsNotWhole", weights, err)
		}

		var status string
		var legs, splitRows int
		var cached int64
		if err := pool.QueryRow(ctx, `SELECT status FROM settlement_batches WHERE id = $1`, batchID).Scan(&status); err != nil {
			t.Fatalf("read batch: %v", err)
		}
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM ledger_entries WHERE settlement_batch_id = $1`, batchID).Scan(&legs); err != nil {
			t.Fatalf("count legs: %v", err)
		}
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM settlement_batch_splits WHERE settlement_batch_id = $1`, batchID).Scan(&splitRows); err != nil {
			t.Fatalf("count split rows: %v", err)
		}
		if err := pool.QueryRow(ctx, `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, parentID).Scan(&cached); err != nil {
			t.Fatalf("read balance: %v", err)
		}
		if status != "closed" || legs != 0 || splitRows != 0 || cached != 97_500 {
			t.Errorf("weights %v: status=%s legs=%d splitRows=%d cached=%d, want closed/0/0/97500",
				weights, status, legs, splitRows, cached)
		}
	}
}

// A split that covers exactly 10000 bps still pays out the whole net payout.
func TestPayoutSplitBatch_PaysWholeNetWhenWeightsSumTo10000(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	parentID, batchID := seedSplitBatch(t, pool, 97_500, 5000, 3000, 2000)

	result, err := PayoutSplitBatch(ctx, pool, batchID)
	if err != nil {
		t.Fatalf("PayoutSplitBatch: %v", err)
	}
	var total int64
	for _, s := range result.Shares {
		total += int64(s.AllocatedFils)
	}
	var status string
	var debited, cached int64
	if err := pool.QueryRow(ctx, `SELECT status FROM settlement_batches WHERE id = $1`, batchID).Scan(&status); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(sum(amount_fils), 0) FROM ledger_entries
		 WHERE settlement_batch_id = $1 AND account_id = 'merchant_payable' AND direction = 'debit'
	`, batchID).Scan(&debited); err != nil {
		t.Fatalf("sum legs: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, parentID).Scan(&cached); err != nil {
		t.Fatalf("read balance: %v", err)
	}
	if status != "paid" || total != 97_500 || debited != 97_500 || cached != 0 {
		t.Errorf("status=%s shares=%d debited=%d cached=%d, want paid/97500/97500/0", status, total, debited, cached)
	}
}
