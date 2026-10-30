package scheduler

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/filspay/settlement/internal/settlement"
)

// Regression: a batch that closed but was never paid (the daemon was killed
// between CloseBatch and PayoutBatch, or the payout kept failing until the
// next midnight) was never paid by the daemon. runIfDue only re-runs
// yesterday, and closeMissedDays skipped every day that already had a closed
// batch, so the day's net stayed in merchant_payable until someone ran
// `run-batch --date` for it by hand.
func TestRunIfDue_PaysBatchLeftClosedOnAnEarlierDay(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()

	var merchantID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
		VALUES ($1, 250, 'active', false) RETURNING id
	`, "scheduler-closed-unpaid-test-"+uuid.New().String()).Scan(&merchantID); err != nil {
		t.Fatalf("insert merchant: %v", err)
	}

	todayStart, _ := settlement.BusinessDayWindow(time.Now().In(settlement.BusinessLocation()))
	day := todayStart.AddDate(0, 0, -3)
	dayStart, _ := settlement.BusinessDayWindow(day)
	insertCapture(t, pool, merchantID, 100_000, dayStart.Add(10*time.Hour))

	// The close committed; the payout never ran.
	if _, err := settlement.CloseBatch(ctx, pool, merchantID, day); err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if s := readDay(t, pool, merchantID, day); s.status != "closed" {
		t.Fatalf("after close: %+v, want status closed", s)
	}

	for run := 1; run <= 2; run++ {
		runIfDue(ctx, pool, 0)
		s := readDay(t, pool, merchantID, day)
		want := dayState{batches: 1, status: "paid", payoutFils: 97_500, paidEvents: 1, unbatchedEvents: 0}
		if s != want {
			t.Errorf("run %d, %s: %+v, want %+v", run, day.Format("2006-01-02"), s, want)
		}
	}
}
