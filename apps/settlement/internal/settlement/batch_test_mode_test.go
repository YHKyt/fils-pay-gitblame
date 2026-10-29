package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Regression: test-mode captures settled after go-live. CloseBatch read
// eligibility from merchants.test_mode at close time, so a sandbox capture
// made on day D was settled and paid out for real once the merchant went
// live before D's batch closed (the daemon re-runs "yesterday" on every
// tick). Migration 0002: test-mode transactions never settle.

func insertTestModeMerchant(t *testing.T, pool *pgxpool.Pool, mdrBps int64) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(context.Background(), `
		INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
		VALUES ($1, $2, 'active', true)
		RETURNING id
	`, "settlement-test-mode-"+uuid.New().String(), mdrBps).Scan(&id)
	if err != nil {
		t.Fatalf("insertTestModeMerchant: %v", err)
	}
	return id
}

func goLive(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `UPDATE merchants SET test_mode = false WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("goLive: %v", err)
	}
}

func schemeLineCount(t *testing.T, pool *pgxpool.Pool, batchID uuid.UUID) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM scheme_export_lines WHERE settlement_batch_id = $1`, batchID).Scan(&n); err != nil {
		t.Fatalf("schemeLineCount: %v", err)
	}
	return n
}

func TestRunDailyBatch_TestModeCaptureDoesNotSettleAfterGoLive(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertTestModeMerchant(t, pool, mdrBps)
	date := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(date)

	// Day D, in test mode: a sandbox capture.
	txnID, _ := headCapture(t, pool, merchantID, mdrBps, 0, 100_000, start.Add(time.Hour))

	// The merchant goes live before D's batch closes; the next daemon tick
	// re-runs D.
	goLive(t, pool, merchantID)
	out := runOne(t, pool, merchantID, date)

	if out.GrossFils != 0 || out.FeeFils != 0 || out.NetPayoutFils != 0 {
		t.Errorf("gross/fee/net = %d/%d/%d, want 0/0/0 (a test-mode capture never settles)", out.GrossFils, out.FeeFils, out.NetPayoutFils)
	}
	if n := schemeLineCount(t, pool, out.BatchID); n != 0 {
		t.Errorf("scheme export lines = %d, want 0 (a sandbox capture must not be presented to the scheme)", n)
	}
	if paid := payoutLegFils(t, pool, out.BatchID); paid != 0 {
		t.Errorf("payout legs = %d fils, want none", paid)
	}
	var batched int
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM transaction_events WHERE transaction_id = $1 AND settlement_batch_id IS NOT NULL
	`, txnID).Scan(&batched); err != nil {
		t.Fatalf("read event batch: %v", err)
	}
	if batched != 0 {
		t.Errorf("%d test-mode capture event(s) claimed by a batch, want 0", batched)
	}
}

// A sandbox refund is not deducted from the first live payout either, while
// live activity on the same merchant settles normally. Refunds are claimed
// with no lower date bound, so an old sandbox refund would otherwise come
// off whichever live batch closes first.
func TestRunDailyBatch_TestModeRefundNotDeductedAfterGoLive(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertTestModeMerchant(t, pool, mdrBps)
	d1 := time.Date(2026, 7, 2, 0, 0, 0, 0, time.UTC)
	d3 := d1.AddDate(0, 0, 2)
	s1, _ := BusinessDayWindow(d1)
	s3, _ := BusinessDayWindow(d3)

	// Day 1, in test mode: a sandbox capture and refund. The daemon's day-1
	// run on day 2 skips the merchant (still in test mode).
	testTxn, _ := headCapture(t, pool, merchantID, mdrBps, 0, 100_000, s1.Add(time.Hour))
	testRefund, _ := headRefund(t, pool, merchantID, testTxn, 40_000, s1.Add(2*time.Hour))

	// Day 3, live: 10,000 captured at 2.50% (fee 250).
	goLive(t, pool, merchantID)
	liveTxn, fee := headCapture(t, pool, merchantID, mdrBps, 0, 10_000, s3.Add(time.Hour))

	b3 := runOne(t, pool, merchantID, d3)

	if b3.GrossFils != 10_000 || b3.FeeFils != fee || b3.NetPayoutFils != 10_000-fee {
		t.Errorf("day 3: gross/fee/net = %d/%d/%d, want 10000/%d/%d (the sandbox refund must not come off it)",
			b3.GrossFils, b3.FeeFils, b3.NetPayoutFils, fee, 10_000-fee)
	}
	if paid := payoutLegFils(t, pool, b3.BatchID); paid != int64(10_000-fee) {
		t.Errorf("day 3: payout legs = %d, want %d", paid, 10_000-fee)
	}
	if got := refundBatchOf(t, pool, testRefund); got != uuid.Nil {
		t.Errorf("sandbox refund claimed by batch %s, want unclaimed", got)
	}
	var lineTxn uuid.UUID
	if err := pool.QueryRow(context.Background(), `SELECT transaction_id FROM scheme_export_lines WHERE settlement_batch_id = $1`, b3.BatchID).Scan(&lineTxn); err != nil {
		t.Fatalf("read day-3 scheme line: %v", err)
	}
	if lineTxn != liveTxn {
		t.Errorf("day-3 scheme line is for %s, want the live transaction %s", lineTxn, liveTxn)
	}
}
