package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

// settlemdr R5: recalculating an older batch's MDR pointed
// merchant_balances.last_settlement_batch_id back at that batch, because the
// fee delta went through ApplyBatchClose, which also sets the pointer. The
// console's merchant view then showed the older batch as the latest. The
// delta now goes through ApplyLedgerDelta, which leaves the pointer alone.
func TestRecalculateMDR_KeepsLatestBatchPointer(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const originalMdrBps = 250
	merchantID := insertActiveMerchant(t, pool, originalMdrBps)

	olderDate := time.Date(2026, 4, 5, 0, 0, 0, 0, time.UTC)
	newerDate := time.Date(2026, 4, 9, 0, 0, 0, 0, time.UTC)
	olderStart, _ := BusinessDayWindow(olderDate)
	newerStart, _ := BusinessDayWindow(newerDate)
	insertCaptureEvent(t, pool, merchantID, originalMdrBps, 6_000, olderStart.Add(time.Hour))
	insertCaptureEvent(t, pool, merchantID, originalMdrBps, 6_000, newerStart.Add(time.Hour))

	if _, err := CloseBatch(ctx, pool, merchantID, olderDate); err != nil {
		t.Fatalf("CloseBatch(older): %v", err)
	}
	newer, err := CloseBatch(ctx, pool, merchantID, newerDate)
	if err != nil {
		t.Fatalf("CloseBatch(newer): %v", err)
	}

	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 400 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("update mdr_bps: %v", err)
	}
	from, to := recalcWindow(olderDate)
	result, err := RecalculateMDR(ctx, pool, merchantID, from, to)
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if len(result.Adjusted) != 1 {
		t.Fatalf("fixture: %d batches adjusted, want 1 (the older batch at the new rate)", len(result.Adjusted))
	}

	var last uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT last_settlement_batch_id FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&last); err != nil {
		t.Fatalf("read last_settlement_batch_id: %v", err)
	}
	if last != newer.BatchID {
		t.Errorf("last_settlement_batch_id = %s, want the newer batch %s (a recalculation of an older batch must not rewind it)", last, newer.BatchID)
	}
}
