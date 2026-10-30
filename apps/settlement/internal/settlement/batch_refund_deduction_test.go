package settlement

import (
	"testing"
	"time"
)

// The run-batch outcome must say what refunds took off the payout, so the
// admin settlement page can show gross - fee - refunds = net instead of an
// unexplained gap. It must hold on a re-run (AlreadyClosed) too.
func TestCloseBatch_ReportsRefundDeduction(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	date := time.Date(2026, 6, 2, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(date)

	txnID, _ := headCapture(t, pool, merchantID, mdrBps, 0, 100_000, start.Add(time.Hour))
	_, reversed := headRefund(t, pool, merchantID, txnID, 100_000, start.Add(2*time.Hour))

	out := runOne(t, pool, merchantID, date)
	want := 100_000 - reversed
	if out.RefundDeductionFils != want {
		t.Errorf("RefundDeductionFils = %d, want %d", out.RefundDeductionFils, want)
	}
	if got := out.GrossFils - out.FeeFils - out.RefundDeductionFils; got != out.NetPayoutFils {
		t.Errorf("gross - fee - refunds = %d, net payout = %d", got, out.NetPayoutFils)
	}

	again := runOne(t, pool, merchantID, date)
	if !again.AlreadyClosed {
		t.Fatalf("second run: AlreadyClosed = false, want true")
	}
	if again.RefundDeductionFils != want {
		t.Errorf("re-run RefundDeductionFils = %d, want %d", again.RefundDeductionFils, want)
	}
}
