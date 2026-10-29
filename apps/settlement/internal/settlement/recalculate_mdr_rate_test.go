package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// pinPlatformProcessedFils sets the platform-wide volume counter for one
// test and puts the previous value back afterwards, so the volume tier is
// on or off on purpose rather than by whatever earlier tests left behind.
func pinPlatformProcessedFils(t *testing.T, pool *pgxpool.Pool, totalFils int64) {
	t.Helper()
	ctx := context.Background()
	var previous int64
	if err := pool.QueryRow(ctx, `SELECT total_processed_fils FROM platform_stats WHERE id = 1`).Scan(&previous); err != nil {
		t.Fatalf("read platform_stats: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE platform_stats SET total_processed_fils = $1 WHERE id = 1`, totalFils); err != nil {
		t.Fatalf("pin platform_stats: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `UPDATE platform_stats SET total_processed_fils = $1 WHERE id = 1`, previous); err != nil {
			t.Errorf("restore platform_stats: %v", err)
		}
	})
}

func countMdrAdjustmentLegs(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID) int {
	t.Helper()
	return countRows(t, pool, `
		SELECT COUNT(*) FROM ledger_entries
		 WHERE merchant_id = $1 AND description = 'MDR recalculation adjustment'
	`, merchantID)
}

// Regression: RecalculateMDR priced every event at merchants.mdr_bps and
// ignored fee_schedules, so a merchant on a negotiated schedule was re-rated
// at the default on a run with no rate change. Here the merchant's default is
// 250 bps but its schedule says 225 bps from January; a 1,000 BD batch closes
// at 22.500 BD and the old code "corrected" it to 25.000 BD (+2.500 BD).
// The later, not-yet-effective 200 bps row must not reach back into April
// either — the rate is the one in force at each event's time.
func TestRecalculateMDR_FeeScheduleRateUnchangedAdjustsNothing(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	pinPlatformProcessedFils(t, pool, 0)

	merchantID := insertActiveMerchant(t, pool, 250)
	insertFeeSchedule(t, pool, merchantID, 225, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	insertFeeSchedule(t, pool, merchantID, 200, time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC))

	businessDate := time.Date(2026, 4, 20, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, 225, 1_000_000, start.Add(time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if closed.FeeFils != 22_500 {
		t.Fatalf("CloseBatch fee = %d, want 22500 (225 bps from the fee schedule)", closed.FeeFils)
	}

	from, to := recalcWindow(businessDate)
	result, err := RecalculateMDR(ctx, pool, merchantID, from, to)
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if result.BatchesConsidered != 1 {
		t.Fatalf("BatchesConsidered = %d, want 1", result.BatchesConsidered)
	}
	if len(result.Adjusted) != 0 {
		t.Fatalf("no rate changed, but RecalculateMDR adjusted %d batch(es): %+v", len(result.Adjusted), result.Adjusted)
	}

	var gotFee int64
	if err := pool.QueryRow(ctx, `SELECT fee_fils FROM settlement_batches WHERE id = $1`, closed.BatchID).Scan(&gotFee); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	if gotFee != 22_500 {
		t.Errorf("fee_fils = %d after a no-change recalculation, want 22500", gotFee)
	}
	if n := countMdrAdjustmentLegs(t, pool, merchantID); n != 0 {
		t.Errorf("posted %d adjustment legs, want 0", n)
	}
}

// Regression: RecalculateMDR left out the platform volume-tier bonus that
// CloseBatch subtracts. With the tier active a 250 bps merchant's 1,000 BD
// batch closes at 23.500 BD (235 bps); the old recalculation put it back to
// 25.000 BD (+1.500 BD) for every merchant on every run.
func TestRecalculateMDR_VolumeTierUnchangedAdjustsNothing(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	pinPlatformProcessedFils(t, pool, 2_000_000_000) // exactly the tier threshold

	merchantID := insertActiveMerchant(t, pool, 250)
	businessDate := time.Date(2026, 4, 21, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, 235, 1_000_000, start.Add(time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if closed.FeeFils != 23_500 {
		t.Fatalf("CloseBatch fee = %d, want 23500 (250 bps less the 15 bps tier)", closed.FeeFils)
	}

	from, to := recalcWindow(businessDate)
	result, err := RecalculateMDR(ctx, pool, merchantID, from, to)
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if len(result.Adjusted) != 0 {
		t.Fatalf("no rate changed, but RecalculateMDR adjusted %d batch(es): %+v", len(result.Adjusted), result.Adjusted)
	}
	if n := countMdrAdjustmentLegs(t, pool, merchantID); n != 0 {
		t.Errorf("posted %d adjustment legs, want 0", n)
	}
}

// All three terms together: a 225 bps schedule (default 250), the 15 bps
// volume tier and a 10% negotiated discount, which reduces the amount the
// MDR is charged on (ARCHITECTURE "Settlement"; capture.ts since b068fdf).
// 1,000 BD closes at 900 BD x 2.10% = 18.900 BD; the old recalculation
// moved it to 900 BD x 2.50% = 22.500 BD (+3.600 BD).
func TestRecalculateMDR_ScheduleTierAndDiscountUnchangedAdjustsNothing(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	pinPlatformProcessedFils(t, pool, 2_000_000_000)

	merchantID := insertActiveMerchant(t, pool, 250)
	if _, err := pool.Exec(ctx, `UPDATE merchants SET negotiated_discount_bps = 1000 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("set discount: %v", err)
	}
	insertFeeSchedule(t, pool, merchantID, 225, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))

	businessDate := time.Date(2026, 4, 23, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, 210, 1_000_000, start.Add(time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if closed.FeeFils != 18_900 {
		t.Fatalf("CloseBatch fee = %d, want 18900 (225 - 15 bps on the 10%%-discounted amount)", closed.FeeFils)
	}

	from, to := recalcWindow(businessDate)
	result, err := RecalculateMDR(ctx, pool, merchantID, from, to)
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if len(result.Adjusted) != 0 {
		t.Fatalf("no rate changed, but RecalculateMDR adjusted %d batch(es): %+v", len(result.Adjusted), result.Adjusted)
	}
	if n := countMdrAdjustmentLegs(t, pool, merchantID); n != 0 {
		t.Errorf("posted %d adjustment legs, want 0", n)
	}
}

// A real rate change on a scheduled merchant is still applied: finance
// back-dates a renegotiated 200 bps row over April, and the April batch
// moves from 22.500 BD to 20.000 BD. The old code ignored the schedule and
// moved it to 25.000 BD instead.
func TestRecalculateMDR_FeeScheduleRateChangeApplied(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	pinPlatformProcessedFils(t, pool, 0)

	merchantID := insertActiveMerchant(t, pool, 250)
	insertFeeSchedule(t, pool, merchantID, 225, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))

	businessDate := time.Date(2026, 4, 22, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, 225, 1_000_000, start.Add(time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	insertFeeSchedule(t, pool, merchantID, 200, time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC))

	from, to := recalcWindow(businessDate)
	result, err := RecalculateMDR(ctx, pool, merchantID, from, to)
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if len(result.Adjusted) != 1 {
		t.Fatalf("len(Adjusted) = %d, want 1", len(result.Adjusted))
	}
	adj := result.Adjusted[0]
	if adj.OldFeeFils != 22_500 || adj.NewFeeFils != 20_000 || adj.DiffFils != -2_500 {
		t.Errorf("adjustment = old %d new %d diff %d, want old 22500 new 20000 diff -2500", adj.OldFeeFils, adj.NewFeeFils, adj.DiffFils)
	}

	var gotFee, gotNet int64
	if err := pool.QueryRow(ctx, `SELECT fee_fils, net_payout_fils FROM settlement_batches WHERE id = $1`, closed.BatchID).Scan(&gotFee, &gotNet); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	if gotFee != 20_000 || gotNet != 980_000 {
		t.Errorf("batch fee/net = %d/%d, want 20000/980000", gotFee, gotNet)
	}
}
