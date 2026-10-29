package settlement

import (
	"context"
	"testing"
	"time"
)

// Regression (finance: "MDR recalculation changed batches that were already
// paid out"): RecalculateMDR must leave paid batches alone. The scan used
// status <> 'open', which also selected 'paid' and rewrote fee/net that had
// already been disbursed.
func TestRecalculateMDR_PaidBatchUntouched(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const originalMdrBps = 250
	merchantID := insertActiveMerchant(t, pool, originalMdrBps)

	date := time.Date(2026, 4, 12, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(date)
	insertCaptureEvent(t, pool, merchantID, originalMdrBps, 6_000, start.Add(time.Hour))

	batch, err := CloseBatch(ctx, pool, merchantID, date)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE settlement_batches SET status = 'paid', paid_at = now() WHERE id = $1`, batch.BatchID); err != nil {
		t.Fatalf("mark paid: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 400 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("update mdr_bps: %v", err)
	}

	from, to := recalcWindow(date)
	result, err := RecalculateMDR(ctx, pool, merchantID, from, to)
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if result.BatchesConsidered != 0 || len(result.Adjusted) != 0 {
		t.Fatalf("paid batch was selected: considered=%d adjusted=%d", result.BatchesConsidered, len(result.Adjusted))
	}
	var gotFee, gotNet int64
	if err := pool.QueryRow(ctx, `SELECT fee_fils, net_payout_fils FROM settlement_batches WHERE id = $1`, batch.BatchID).Scan(&gotFee, &gotNet); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	if gotFee != int64(batch.FeeFils) || gotNet != int64(batch.NetPayoutFils) {
		t.Fatalf("paid batch changed: fee %d->%d net %d->%d", batch.FeeFils, gotFee, batch.NetPayoutFils, gotNet)
	}
}
