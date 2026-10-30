package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
)

// Regression: settlement recomputed the fee at close instead of settling the
// fee booked at capture. A rate change between capture and close was paid
// out (or withheld) without ever being journaled: 1,000,000 fils booked at
// 250 bps (25,000 fee) and closed after the merchant's rate moved to 200 bps
// charged 20,000 and paid 980,000, leaving merchant_payable at -5,000.

func setMerchantRates(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, mdrBps, discountBps int64) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`UPDATE merchants SET mdr_bps = $2, negotiated_discount_bps = $3 WHERE id = $1`,
		merchantID, mdrBps, discountBps); err != nil {
		t.Fatalf("setMerchantRates: %v", err)
	}
}

func TestRunDailyBatch_SettlesTheFeeBookedAtCapture(t *testing.T) {
	cases := []struct {
		name                    string
		amount                  money.Fils
		bookMdr, bookDiscount   int64 // rates when the capture was booked
		closeMdr, closeDiscount int64 // rates when the batch closes
		wantFee                 money.Fils
	}{
		// The case-file repro: 1,000,000 at 2.50% = 25,000; the rate later 2.00%.
		{"mdr lowered after capture", 1_000_000, 250, 0, 200, 0, 25_000},
		// Discount-first, as captureTransaction books it: 602 at 2.75% with
		// 12.5% off = 527 * 2.75% = 14.49 -> 14. The discount later removed
		// (recomputed: 16.555 -> 17).
		{"discount removed after capture", 602, 275, 1250, 275, 0, 14},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pool := mustPool(t)
			merchantID := insertActiveMerchant(t, pool, tc.bookMdr)
			setMerchantRates(t, pool, merchantID, tc.bookMdr, tc.bookDiscount)
			date := time.Date(2026, 9, 1+i, 0, 0, 0, 0, time.UTC)
			start, _ := BusinessDayWindow(date)

			_, booked := headCapture(t, pool, merchantID, tc.bookMdr, tc.bookDiscount, tc.amount, start.Add(time.Hour))
			if booked != tc.wantFee {
				t.Fatalf("fixture: booked fee %d, want %d", booked, tc.wantFee)
			}

			setMerchantRates(t, pool, merchantID, tc.closeMdr, tc.closeDiscount)
			out := runOne(t, pool, merchantID, date)

			if out.FeeFils != tc.wantFee || out.NetPayoutFils != tc.amount-tc.wantFee {
				t.Errorf("fee/net = %d/%d, want %d/%d (the fee booked at capture)",
					out.FeeFils, out.NetPayoutFils, tc.wantFee, tc.amount-tc.wantFee)
			}
			if paid := payoutLegFils(t, pool, out.BatchID); paid != int64(tc.amount-tc.wantFee) {
				t.Errorf("payout legs = %d, want %d", paid, tc.amount-tc.wantFee)
			}
			if p := merchantPayable(t, pool, merchantID); p != 0 {
				t.Errorf("merchant_payable after payout = %d, want 0", p)
			}
			if c := cachedPayable(t, pool, merchantID); c != 0 {
				t.Errorf("cached_payable_fils after payout = %d, want 0", c)
			}
		})
	}
}
