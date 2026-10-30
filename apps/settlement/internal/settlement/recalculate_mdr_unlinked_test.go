package settlement

import (
	"context"
	"errors"
	"testing"
	"time"
)

// Regression: RecalculateMDR re-rates a batch from the transaction_events
// that carry its id. A closed batch written without linking its events (as
// db/seed used to write the Alpha, Beta, Gamma and Delta Wholesale
// 2026-08-31 fixture batches; it now links every settled capture event to
// its batch) re-rated to a fee of 0, so a run with no rate change refunded
// the whole fee: on that seed, Alpha Retail's 183.174 BD. It must refuse
// such a batch instead, and leave it, the ledger and the outbox as they
// were.
func TestRecalculateMDR_RefusesBatchWhoseEventsDoNotAddUp(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	pinPlatformProcessedFils(t, pool, 0)

	merchantID := insertActiveMerchant(t, pool, 250)
	businessDate := time.Date(2026, 4, 26, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	// The capture happened, but the batch below was written directly with
	// its figures and never linked to the event, as the old seed did.
	insertCaptureEvent(t, pool, merchantID, 250, 1_000_000, start.Add(time.Hour))
	var batchID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
		VALUES ($1, $2, 'closed', 1000000, 25000, 975000, now())
		RETURNING id
	`, merchantID, businessDate).Scan(&batchID); err != nil {
		t.Fatalf("insert fixture batch: %v", err)
	}

	from, to := recalcWindow(businessDate)
	result, err := RecalculateMDR(ctx, pool, merchantID, from, to)
	if !errors.Is(err, ErrBatchEventsIncomplete) {
		t.Fatalf("RecalculateMDR err = %v, result %+v; want ErrBatchEventsIncomplete", err, result)
	}

	var gotFee, gotNet int64
	if err := pool.QueryRow(ctx, `SELECT fee_fils, net_payout_fils FROM settlement_batches WHERE id = $1`, batchID).Scan(&gotFee, &gotNet); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	if gotFee != 25_000 || gotNet != 975_000 {
		t.Errorf("batch fee/net = %d/%d, want 25000/975000 unchanged", gotFee, gotNet)
	}
	if n := countMdrAdjustmentLegs(t, pool, merchantID); n != 0 {
		t.Errorf("posted %d adjustment legs, want 0", n)
	}
	if n := countRows(t, pool, `SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = $1`, batchID); n != 0 {
		t.Errorf("enqueued %d outbox events, want 0", n)
	}
}
