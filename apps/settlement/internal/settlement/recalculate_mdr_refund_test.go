package settlement

import (
	"context"
	"testing"
	"time"
)

// Regression: RecalculateMDR rewrote net_payout_fils as gross - new fee,
// dropping the refund deduction CloseBatch nets into the payout. A batch
// with a 10,000-fils refund closed at 87,750 net; re-rating it from 2.50% to
// 4.00% must leave 86,250 (only the 1,500 fee increase comes off), but it
// produced 96,000 and paid the refund out a second time.
func TestRecalculateMDR_KeepsRefundDeduction(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	date := time.Date(2026, 6, 20, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(date)

	// 100,000 @ 2.50% = 2,500 fee. Refund 10,000 reverses 250 of it.
	txnID, fee := headCapture(t, pool, merchantID, mdrBps, 0, 100_000, start.Add(time.Hour))
	_, reversed := headRefund(t, pool, merchantID, txnID, 10_000, start.Add(2*time.Hour))
	if fee != 2_500 || reversed != 250 {
		t.Fatalf("fixture: fee %d, reversed %d, want 2500 and 250", fee, reversed)
	}

	batch, err := CloseBatch(ctx, pool, merchantID, date)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	// 100,000 - 2,500 - (10,000 - 250) = 87,750.
	if batch.NetPayoutFils != 87_750 {
		t.Fatalf("close net = %d, want 87750", batch.NetPayoutFils)
	}

	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 400 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("update mdr_bps: %v", err)
	}
	from, to := recalcWindow(date)
	result, err := RecalculateMDR(ctx, pool, merchantID, from, to)
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if len(result.Adjusted) != 1 || result.Adjusted[0].DiffFils != 1_500 {
		t.Fatalf("adjusted = %+v, want one batch with diff 1500", result.Adjusted)
	}

	var gotFee, gotNet int64
	if err := pool.QueryRow(ctx, `SELECT fee_fils, net_payout_fils FROM settlement_batches WHERE id = $1`, batch.BatchID).Scan(&gotFee, &gotNet); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	if gotFee != 4_000 {
		t.Errorf("fee after recalc = %d, want 4000", gotFee)
	}
	if gotNet != 86_250 {
		t.Errorf("net after recalc = %d, want 86250 (87750 - 1500 fee increase; refund still deducted)", gotNet)
	}
	// The cache and the ledger moved by the fee difference only, so the
	// batch's net must still equal what merchant_payable says is owed.
	if p := merchantPayable(t, pool, merchantID); p != gotNet {
		t.Errorf("merchant_payable = %d, want %d (the batch's net)", p, gotNet)
	}
}
