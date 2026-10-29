package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Regression: refunds were never deducted from payouts. CloseBatch only read
// capture events, so a capture refunded the same day was paid out in full
// (97,500 of 100,000 at 2.50%) while processRefund had already debited
// merchant_payable by the refund, leaving the merchant owing -97,500 that
// nothing ever recovered, and refunds.settlement_batch_id was never set.

func refundBatchOf(t *testing.T, pool *pgxpool.Pool, refundID uuid.UUID) uuid.UUID {
	t.Helper()
	var batchID *uuid.UUID
	if err := pool.QueryRow(context.Background(), `SELECT settlement_batch_id FROM refunds WHERE id = $1`, refundID).Scan(&batchID); err != nil {
		t.Fatalf("read refund batch: %v", err)
	}
	if batchID == nil {
		return uuid.Nil
	}
	return *batchID
}

func TestCloseBatch_SameDayFullRefundNetsToZero(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	date := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(date)

	txnID, fee := headCapture(t, pool, merchantID, mdrBps, 0, 100_000, start.Add(time.Hour))
	refundID, reversed := headRefund(t, pool, merchantID, txnID, 100_000, start.Add(2*time.Hour))
	if fee != 2_500 || reversed != 2_500 {
		t.Fatalf("fixture: fee %d, reversed %d, want 2500 and 2500", fee, reversed)
	}

	out := runOne(t, pool, merchantID, date)

	if out.GrossFils != 100_000 || out.FeeFils != 2_500 {
		t.Errorf("gross/fee = %d/%d, want 100000/2500", out.GrossFils, out.FeeFils)
	}
	if out.NetPayoutFils != 0 {
		t.Errorf("net payout = %d, want 0 (100,000 captured and refunded, fee fully reversed)", out.NetPayoutFils)
	}
	if got := refundBatchOf(t, pool, refundID); got != out.BatchID {
		t.Errorf("refunds.settlement_batch_id = %s, want %s (the batch that deducted it)", got, out.BatchID)
	}
	if paid := payoutLegFils(t, pool, out.BatchID); paid != 0 {
		t.Errorf("payout legs = %d fils, want none", paid)
	}
	if p := merchantPayable(t, pool, merchantID); p != 0 {
		t.Errorf("merchant_payable after payout = %d, want 0", p)
	}
	if c := cachedPayable(t, pool, merchantID); c != 0 {
		t.Errorf("cached_payable_fils after payout = %d, want 0", c)
	}

	// The scheme file stays a presentment of the capture: the refund went to
	// the acquirer online under its own reference and its ledger legs
	// already credit card_scheme_clearing, so netting it here as well would
	// count it twice (and the file has no credit line type).
	var lineFils int64
	if err := pool.QueryRow(context.Background(), `SELECT amount_fils FROM scheme_export_lines WHERE settlement_batch_id = $1`, out.BatchID).Scan(&lineFils); err != nil {
		t.Fatalf("read scheme line: %v", err)
	}
	if lineFils != 100_000 {
		t.Errorf("scheme line = %d fils, want 100000 (the capture presentment)", lineFils)
	}
}

func TestCloseBatch_PartialRefundExactFils(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	date := time.Date(2026, 6, 2, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(date)

	// 4,747 @ 2.50% = 118.675 -> 119 fee. Refund 1,333: 119 * 1333 / 4747
	// = 33.42 -> 33 reversed. Net = 4747 - 119 - (1333 - 33) = 3,328.
	txnID, fee := headCapture(t, pool, merchantID, mdrBps, 0, 4_747, start.Add(time.Hour))
	refundID, reversed := headRefund(t, pool, merchantID, txnID, 1_333, start.Add(3*time.Hour))
	if fee != 119 || reversed != 33 {
		t.Fatalf("fixture: fee %d, reversed %d, want 119 and 33", fee, reversed)
	}

	out := runOne(t, pool, merchantID, date)

	if out.NetPayoutFils != 3_328 {
		t.Errorf("net payout = %d, want 3328", out.NetPayoutFils)
	}
	if paid := payoutLegFils(t, pool, out.BatchID); paid != 3_328 {
		t.Errorf("payout legs = %d fils, want 3328", paid)
	}
	if got := refundBatchOf(t, pool, refundID); got != out.BatchID {
		t.Errorf("refunds.settlement_batch_id = %s, want %s", got, out.BatchID)
	}
	if p := merchantPayable(t, pool, merchantID); p != 0 {
		t.Errorf("merchant_payable after payout = %d, want 0", p)
	}
	if c := cachedPayable(t, pool, merchantID); c != 0 {
		t.Errorf("cached_payable_fils after payout = %d, want 0", c)
	}
}

// A refund on a day with less captured than refunded closes negative: it is
// not paid, and the shortfall comes off the merchant's next batch.
func TestCloseBatch_RefundShortfallCarriedForward(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	d1 := time.Date(2026, 6, 3, 0, 0, 0, 0, time.UTC)
	d2, d3 := d1.AddDate(0, 0, 1), d1.AddDate(0, 0, 2)
	s1, _ := BusinessDayWindow(d1)
	s2, _ := BusinessDayWindow(d2)
	s3, _ := BusinessDayWindow(d3)

	txnID, _ := headCapture(t, pool, merchantID, mdrBps, 0, 100_000, s1.Add(time.Hour))
	b1 := runOne(t, pool, merchantID, d1)
	if b1.NetPayoutFils != 97_500 || payoutLegFils(t, pool, b1.BatchID) != 97_500 {
		t.Fatalf("day 1: net %d, want 97500 paid", b1.NetPayoutFils)
	}

	// Day 2: the whole capture is refunded and nothing new is captured.
	refundID, _ := headRefund(t, pool, merchantID, txnID, 100_000, s2.Add(time.Hour))
	b2 := runOne(t, pool, merchantID, d2)
	if b2.NetPayoutFils != -97_500 {
		t.Errorf("day 2: net %d, want -97500", b2.NetPayoutFils)
	}
	if got := refundBatchOf(t, pool, refundID); got != b2.BatchID {
		t.Errorf("refund claimed by %s, want day-2 batch %s", got, b2.BatchID)
	}
	if paid := payoutLegFils(t, pool, b2.BatchID); paid != 0 {
		t.Errorf("day 2: payout legs = %d, want none for a negative net", paid)
	}
	if p := merchantPayable(t, pool, merchantID); p != -97_500 {
		t.Errorf("day 2: merchant_payable = %d, want -97500 (owed back by the merchant)", p)
	}
	if c := cachedPayable(t, pool, merchantID); c != -97_500 {
		t.Errorf("day 2: cached_payable_fils = %d, want -97500", c)
	}

	// Day 3: a new 200,000 capture (fee 5,000). The day-2 shortfall comes off.
	headCapture(t, pool, merchantID, mdrBps, 0, 200_000, s3.Add(time.Hour))
	b3 := runOne(t, pool, merchantID, d3)
	if b3.NetPayoutFils != 97_500 {
		t.Errorf("day 3: net %d, want 97500 (195000 own - 97500 carried)", b3.NetPayoutFils)
	}
	if paid := payoutLegFils(t, pool, b3.BatchID); paid != 97_500 {
		t.Errorf("day 3: payout legs = %d, want 97500", paid)
	}
	var carriedTo *uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT carried_forward_to_batch_id FROM settlement_batches WHERE id = $1`, b2.BatchID).Scan(&carriedTo); err != nil {
		t.Fatalf("read carried_forward_to_batch_id: %v", err)
	}
	if carriedTo == nil || *carriedTo != b3.BatchID {
		t.Errorf("day-2 shortfall carried to %v, want %s", carriedTo, b3.BatchID)
	}
	if p := merchantPayable(t, pool, merchantID); p != 0 {
		t.Errorf("after day 3: merchant_payable = %d, want 0", p)
	}
	if c := cachedPayable(t, pool, merchantID); c != 0 {
		t.Errorf("after day 3: cached_payable_fils = %d, want 0", c)
	}

	// Re-running any of the days changes nothing: the shortfall is taken once.
	for _, d := range []time.Time{d1, d2, d3} {
		runOne(t, pool, merchantID, d)
	}
	if p := merchantPayable(t, pool, merchantID); p != 0 {
		t.Errorf("after re-runs: merchant_payable = %d, want 0", p)
	}
}
