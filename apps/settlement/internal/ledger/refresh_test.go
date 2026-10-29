package ledger

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func insertClosedBatchWithLine(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, batchDate string, amountFils int64, lineSequence int) uuid.UUID {
	t.Helper()
	ctx := context.Background()

	var batchID uuid.UUID
	err := pool.QueryRow(ctx, `
		INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
		VALUES ($1, $2, 'closed', $3, 0, $3, now())
		RETURNING id
	`, merchantID, batchDate, amountFils).Scan(&batchID)
	if err != nil {
		t.Fatalf("insertClosedBatchWithLine: insert batch: %v", err)
	}

	_, err = pool.Exec(ctx, `
		INSERT INTO scheme_export_lines (settlement_batch_id, amount_fils, line_sequence)
		VALUES ($1, $2, $3)
	`, batchID, amountFils, lineSequence)
	if err != nil {
		t.Fatalf("insertClosedBatchWithLine: insert export line: %v", err)
	}

	// A real close also credits the merchant's payable in the ledger, which is
	// what the cache mirrors. (The helper used to write only the scheme line,
	// matching the old, wrong rebuild source — see RefreshBalanceCache.)
	postLedgerLeg(t, pool, merchantID, "credit", amountFils)

	return batchID
}

// Regression for FP-203: the button must agree with the ledger walk the CLI
// does, even when the ledger holds activity the scheme export does not (here a
// refund debit that never appears in scheme_export_lines).
func TestRefreshBalanceCache_MatchesLedgerNotSchemeExport(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool)

	insertClosedBatchWithLine(t, pool, merchantID, "2026-06-20", 135_000, 1)
	postLedgerLeg(t, pool, merchantID, "debit", 7_000) // e.g. a refund

	cli, err := RebuildMerchantBalance(context.Background(), pool, merchantID)
	if err != nil {
		t.Fatalf("RebuildMerchantBalance: %v", err)
	}
	diffs, err := RefreshBalanceCache(context.Background(), pool)
	if err != nil {
		t.Fatalf("RefreshBalanceCache: %v", err)
	}
	if got := diffs[merchantID].Rebuilt; got != cli || int64(got) != 128_000 {
		t.Fatalf("button rebuilt %d, CLI %d, want both 128000", got, cli)
	}
}

func TestRefreshBalanceCache_OverwritesDriftedCache(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool)

	insertClosedBatchWithLine(t, pool, merchantID, "2026-06-10", 25000, 1)
	want := int64(25000)

	_, err := pool.Exec(context.Background(), `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
		VALUES ($1, 888888, now())
	`, merchantID)
	if err != nil {
		t.Fatalf("seed drifted cache: %v", err)
	}

	diffs, err := RefreshBalanceCache(context.Background(), pool)
	if err != nil {
		t.Fatalf("RefreshBalanceCache: %v", err)
	}

	diff, ok := diffs[merchantID]
	if !ok {
		t.Fatalf("RefreshBalanceCache did not return a diff for merchant %s", merchantID)
	}
	if diff.CachedBefore != 888888 {
		t.Errorf("diff.CachedBefore = %d, want 888888", diff.CachedBefore)
	}
	if int64(diff.Rebuilt) != want {
		t.Errorf("diff.Rebuilt = %d, want %d", diff.Rebuilt, want)
	}
	if !diff.Changed() {
		t.Error("diff.Changed() = false, want true")
	}

	var persisted int64
	err = pool.QueryRow(context.Background(), `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&persisted)
	if err != nil {
		t.Fatalf("query persisted balance: %v", err)
	}
	if persisted != want {
		t.Errorf("persisted cached_payable_fils = %d, want %d", persisted, want)
	}
}

func TestRefreshBalanceCache_SumsAcrossBatches(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool)

	insertClosedBatchWithLine(t, pool, merchantID, "2026-06-11", 15000, 1)
	insertClosedBatchWithLine(t, pool, merchantID, "2026-06-12", 6000, 1)

	want := int64(15000 + 6000)

	diffs, err := RefreshBalanceCache(context.Background(), pool)
	if err != nil {
		t.Fatalf("RefreshBalanceCache: %v", err)
	}

	diff, ok := diffs[merchantID]
	if !ok {
		t.Fatalf("RefreshBalanceCache did not return a diff for merchant %s", merchantID)
	}
	if int64(diff.Rebuilt) != want {
		t.Errorf("diff.Rebuilt = %d, want %d", diff.Rebuilt, want)
	}
}
