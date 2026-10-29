package settlement

import (
	"context"
	"testing"
	"time"
)

// Regression: RecalculateMDR dated its correction legs now(). ARCHITECTURE
// ("The ledger") says corrections are posted with the effective date of the
// period they correct. Recalculating an April batch in October rewrote the
// April batch's fee_fils but booked the difference in October, so April's
// fee revenue no longer tied to April's batch and October carried an
// unexplained adjustment.
func TestRecalculateMDR_CorrectionDatedInCorrectedPeriod(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	pinPlatformProcessedFils(t, pool, 0)

	merchantID := insertActiveMerchant(t, pool, 250)
	businessDate := time.Date(2026, 4, 24, 0, 0, 0, 0, time.UTC)
	start, end := BusinessDayWindow(businessDate)
	// capture posts its 25.000 BD MDR fee legs inside the business day.
	insertCaptureEvent(t, pool, merchantID, 250, 1_000_000, start.Add(time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 300 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("update mdr_bps: %v", err)
	}

	from, to := recalcWindow(businessDate)
	result, err := RecalculateMDR(ctx, pool, merchantID, from, to)
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if len(result.Adjusted) != 1 || result.Adjusted[0].DiffFils != 5_000 {
		t.Fatalf("Adjusted = %+v, want one +5000 adjustment", result.Adjusted)
	}

	// Both legs sit at Asia/Bahrain midnight of the batch's business day.
	rows, err := pool.Query(ctx, `
		SELECT occurred_at FROM ledger_entries
		 WHERE merchant_id = $1 AND description = 'MDR recalculation adjustment'
	`, merchantID)
	if err != nil {
		t.Fatalf("query adjustment legs: %v", err)
	}
	legs := 0
	for rows.Next() {
		var occurredAt time.Time
		if err := rows.Scan(&occurredAt); err != nil {
			t.Fatalf("scan: %v", err)
		}
		legs++
		if !occurredAt.Equal(start) {
			t.Errorf("adjustment leg dated %s, want %s (start of the corrected business day)", occurredAt.UTC(), start.UTC())
		}
	}
	rows.Close()
	if legs != 2 {
		t.Fatalf("found %d adjustment legs, want 2", legs)
	}

	// The corrected period ties: fee revenue booked in the batch's business
	// day equals the batch's rewritten fee_fils.
	var periodFeeRevenue, batchFee int64
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)
		  FROM ledger_entries
		 WHERE merchant_id = $1 AND account_id = 'platform_fee_revenue'
		   AND occurred_at >= $2 AND occurred_at < $3
	`, merchantID, start, end).Scan(&periodFeeRevenue); err != nil {
		t.Fatalf("sum period fee revenue: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT fee_fils FROM settlement_batches WHERE id = $1`, closed.BatchID).Scan(&batchFee); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	if batchFee != 30_000 || periodFeeRevenue != batchFee {
		t.Errorf("period fee revenue = %d, batch fee_fils = %d, want both 30000", periodFeeRevenue, batchFee)
	}
}
