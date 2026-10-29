package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type batchClosedFigures struct {
	count            int
	lastFee, lastNet int64
}

// readBatchClosedEvents counts the settlement.batch_closed outbox rows for
// one batch and returns the figures on the newest, which is the one
// reporting's id-ordered consumer and rebuild apply last.
func readBatchClosedEvents(t *testing.T, pool *pgxpool.Pool, batchID uuid.UUID) batchClosedFigures {
	t.Helper()
	var got batchClosedFigures
	got.count = countRows(t, pool, `
		SELECT COUNT(*) FROM outbox_events
		 WHERE event_type = 'settlement.batch_closed' AND aggregate_id = $1
	`, batchID)
	if err := pool.QueryRow(context.Background(), `
		SELECT (payload->>'feeFils')::bigint, (payload->>'netPayoutFils')::bigint
		  FROM outbox_events
		 WHERE event_type = 'settlement.batch_closed' AND aggregate_id = $1
		 ORDER BY id DESC LIMIT 1
	`, batchID).Scan(&got.lastFee, &got.lastNet); err != nil {
		t.Fatalf("read newest batch_closed event: %v", err)
	}
	return got
}

// Regression: RecalculateMDR rewrote settlement_batches.fee_fils and
// net_payout_fils but put nothing on the outbox. apps/reporting is fed only
// from the outbox (ARCHITECTURE "Overview", "Events"), so the merchant's
// payout trends kept the old fee/net for good, even after a rebuild.
func TestRecalculateMDR_EnqueuesCorrectedBatchFigures(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	pinPlatformProcessedFils(t, pool, 0)

	merchantID := insertActiveMerchant(t, pool, 250)
	businessDate := time.Date(2026, 4, 25, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, 250, 1_000_000, start.Add(time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if got := readBatchClosedEvents(t, pool, closed.BatchID); got.count != 1 || got.lastFee != 25_000 {
		t.Fatalf("after close: %+v, want one event with fee 25000", got)
	}

	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 300 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("update mdr_bps: %v", err)
	}
	from, to := recalcWindow(businessDate)
	if _, err := RecalculateMDR(ctx, pool, merchantID, from, to); err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	got := readBatchClosedEvents(t, pool, closed.BatchID)
	if got.count != 2 || got.lastFee != 30_000 || got.lastNet != 970_000 {
		t.Errorf("after recalculation: %d event(s), newest fee/net %d/%d, want 2 events, newest 30000/970000", got.count, got.lastFee, got.lastNet)
	}

	// A second run changes nothing, so it announces nothing.
	if _, err := RecalculateMDR(ctx, pool, merchantID, from, to); err != nil {
		t.Fatalf("RecalculateMDR (no-op): %v", err)
	}
	if again := readBatchClosedEvents(t, pool, closed.BatchID); again.count != got.count {
		t.Errorf("no-change run enqueued an event: %d event(s), want %d", again.count, got.count)
	}
}
