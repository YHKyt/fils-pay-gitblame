package settlement

import (
	"context"
	"testing"
	"time"
)

// Regression (Finance: "the scheme statement total is always a few fils
// higher than ours"; ADR-0002 residue never posted):
//   - the scheme file amount must be exactly amount_fils/1000 (4747 -> 4.74,
//     not the rounded 4.75), and
//   - the truncated-off fils must be journalled, balanced, out of
//     card_scheme_clearing into scheme_rounding_residue.
func TestCloseBatch_SchemeAmountMatchesBookedAndResidueJournalled(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	date := time.Date(2026, 5, 6, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(date)
	insertCaptureEvent(t, pool, merchantID, mdrBps, 4747, start.Add(time.Hour))

	res, err := CloseBatch(ctx, pool, merchantID, date)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	var amountFils int64
	var amountText string
	if err := pool.QueryRow(ctx, `SELECT amount_fils, amount::text FROM scheme_export_lines WHERE settlement_batch_id = $1`, res.BatchID).Scan(&amountFils, &amountText); err != nil {
		t.Fatalf("read export line: %v", err)
	}
	if amountFils != 4740 || amountText != "4.74" {
		t.Fatalf("export line = %d fils / %q, want 4740 / \"4.74\" (file must equal what we book)", amountFils, amountText)
	}

	var clearingCredit, residueDebit int64
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(amount_fils) FILTER (WHERE account_id = 'card_scheme_clearing'    AND direction = 'credit'), 0),
		       COALESCE(SUM(amount_fils) FILTER (WHERE account_id = 'scheme_rounding_residue' AND direction = 'debit'),  0)
		  FROM ledger_entries WHERE settlement_batch_id = $1 AND description = 'scheme export: rounding residue'`,
		res.BatchID).Scan(&clearingCredit, &residueDebit); err != nil {
		t.Fatalf("read residue legs: %v", err)
	}
	if clearingCredit != 7 || residueDebit != 7 {
		t.Fatalf("residue legs: clearing credit %d, residue debit %d, want 7 and 7", clearingCredit, residueDebit)
	}
}

func TestCloseBatch_NoResidueLegsForWholeTenFils(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	date := time.Date(2026, 5, 7, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(date)
	insertCaptureEvent(t, pool, merchantID, mdrBps, 4750, start.Add(time.Hour))

	res, err := CloseBatch(ctx, pool, merchantID, date)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM ledger_entries WHERE settlement_batch_id = $1 AND description = 'scheme export: rounding residue'`, res.BatchID); n != 0 {
		t.Fatalf("posted %d residue legs for a whole-10-fils line, want 0", n)
	}
}
