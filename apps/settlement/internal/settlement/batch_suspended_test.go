package settlement

import (
	"context"
	"testing"
	"time"
)

// Regression: an explicit-merchant re-run paid a suspended merchant.
// CloseBatch returned "already closed" before it checked the merchant's
// status, and RunDailyBatch then paid out whatever batch came back;
// PayoutBatch never looks at the merchant. A batch left 'closed' (its payout
// failed, or the run died between close and payout) was therefore paid on
// the next `run-batch --merchant` even after the merchant was suspended.
func TestRunDailyBatch_ExplicitRerunDoesNotPaySuspendedMerchant(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	date := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(date)

	headCapture(t, pool, merchantID, mdrBps, 0, 100_000, start.Add(time.Hour))

	// The batch closes, but its payout never ran.
	closed, err := CloseBatch(ctx, pool, merchantID, date)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if closed.NetPayoutFils != 97_500 {
		t.Fatalf("fixture: net %d, want 97500", closed.NetPayoutFils)
	}

	if _, err := pool.Exec(ctx, `UPDATE merchants SET status = 'suspended' WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("suspend merchant: %v", err)
	}

	report, err := RunDailyBatch(ctx, pool, date, &merchantID)
	if err != nil {
		t.Fatalf("RunDailyBatch: %v", err)
	}
	for _, r := range report.MerchantResults {
		if r.MerchantID == merchantID {
			t.Errorf("suspended merchant processed by the re-run: %+v", r)
		}
	}

	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM settlement_batches WHERE id = $1`, closed.BatchID).Scan(&status); err != nil {
		t.Fatalf("read batch status: %v", err)
	}
	if status != "closed" {
		t.Errorf("batch status = %q, want closed (no payout while suspended)", status)
	}
	if paid := payoutLegFils(t, pool, closed.BatchID); paid != 0 {
		t.Errorf("payout legs = %d fils, want none for a suspended merchant", paid)
	}
	if c := cachedPayable(t, pool, merchantID); c != 97_500 {
		t.Errorf("cached_payable_fils = %d, want 97500 (still owed, not paid)", c)
	}

	// Reinstated, the same re-run pays the batch exactly once.
	if _, err := pool.Exec(ctx, `UPDATE merchants SET status = 'active' WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("reinstate merchant: %v", err)
	}
	out := runOne(t, pool, merchantID, date)
	if !out.AlreadyClosed || out.NetPayoutFils != 97_500 {
		t.Errorf("after reinstatement: %+v, want the already-closed batch paid", out)
	}
	if paid := payoutLegFils(t, pool, closed.BatchID); paid != 97_500 {
		t.Errorf("after reinstatement: payout legs = %d, want 97500", paid)
	}
	if p := merchantPayable(t, pool, merchantID); p != 0 {
		t.Errorf("after reinstatement: merchant_payable = %d, want 0", p)
	}
}
