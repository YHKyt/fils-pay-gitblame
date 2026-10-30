package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Regression: journaled money corrections were never settled. An admin
// credit (credits.ts) or a journaled balance adjustment (ledgerAdjustments.ts)
// credits or debits merchant_payable, but CloseBatch only read capture events
// and refunds, so the money stayed in merchant_payable for good: a 20,500
// fils credit was never paid out, and a 5,000 fils debit was never collected.

// postCredit posts an admin credit exactly as credits.ts does: base and MDR
// reversal in one group, dated at Asia/Bahrain midnight of the effective
// day, and the cache moved in the same step.
func postCredit(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, baseFils, reversalFils int64, at time.Time) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	groupID := uuid.New()
	if _, err := pool.Exec(ctx, `
		INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES ($1, $2, 'merchant_credit_contra', 'debit',  $3, $4, 'manual credit: base'),
		       ($1, $2, 'merchant_payable',       'credit', $3, $4, 'manual credit: base')
	`, groupID, merchantID, baseFils, at); err != nil {
		t.Fatalf("postCredit: base: %v", err)
	}
	if reversalFils > 0 {
		if _, err := pool.Exec(ctx, `
			INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
			VALUES ($1, $2, 'platform_fee_revenue', 'debit',  $3, $4, 'manual credit: MDR reversal'),
			       ($1, $2, 'merchant_payable',     'credit', $3, $4, 'manual credit: MDR reversal')
		`, groupID, merchantID, reversalFils, at); err != nil {
			t.Fatalf("postCredit: reversal: %v", err)
		}
	}
	moveCache(t, pool, merchantID, baseFils+reversalFils)
	return groupID
}

// postDebitAdjustment posts a negative journaled adjustment exactly as
// ledgerAdjustments.ts does (CSV import row "-5.000"), plus its cache move.
func postDebitAdjustment(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, fils int64, at time.Time) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES ($1, $2, 'merchant_payable',                 'debit',  $3, $4, 'CSV adjustment import'),
		       ($1, $2, 'manual_balance_adjustment_contra', 'credit', $3, $4, 'CSV adjustment import')
	`, uuid.New(), merchantID, fils, at); err != nil {
		t.Fatalf("postDebitAdjustment: %v", err)
	}
	moveCache(t, pool, merchantID, -fils)
}

func moveCache(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, delta int64) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
		VALUES ($1, $2, now())
		ON CONFLICT (merchant_id) DO UPDATE
		  SET cached_payable_fils = merchant_balances.cached_payable_fils + EXCLUDED.cached_payable_fils
	`, merchantID, delta); err != nil {
		t.Fatalf("moveCache: %v", err)
	}
}

func TestCloseBatch_PaysJournaledCreditsAndCollectsDebits(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	day1 := time.Date(2026, 6, 10, 0, 0, 0, 0, time.UTC)
	start1, end1 := BusinessDayWindow(day1)

	headCapture(t, pool, merchantID, mdrBps, 0, 100_000, start1.Add(time.Hour)) // net 97,500
	postCredit(t, pool, merchantID, 20_000, 500, start1)                          // +20,500
	postDebitAdjustment(t, pool, merchantID, 5_000, start1.Add(2*time.Hour))      // -5,000
	// A credit dated into the next business day belongs to that day's close.
	postCredit(t, pool, merchantID, 1_000, 0, end1)

	out1 := runOne(t, pool, merchantID, day1)
	if want := int64(97_500 + 20_500 - 5_000); int64(out1.NetPayoutFils) != want {
		t.Errorf("day 1 net payout = %d, want %d (capture net + credit - debit adjustment)", out1.NetPayoutFils, want)
	}
	if paid := payoutLegFils(t, pool, out1.BatchID); paid != 113_000 {
		t.Errorf("day 1 payout legs = %d fils, want 113000", paid)
	}

	out2 := runOne(t, pool, merchantID, day1.AddDate(0, 0, 1))
	if out2.NetPayoutFils != 1_000 {
		t.Errorf("day 2 net payout = %d, want 1000 (only the credit dated day 2; day 1's are settled once)", out2.NetPayoutFils)
	}
	if p := merchantPayable(t, pool, merchantID); p != 0 {
		t.Errorf("merchant_payable after both payouts = %d, want 0 (every correction settled)", p)
	}
	if c := cachedPayable(t, pool, merchantID); c != 0 {
		t.Errorf("cached_payable_fils after both payouts = %d, want 0 (corrections are in the cache once)", c)
	}

	out3 := runOne(t, pool, merchantID, day1.AddDate(0, 0, 2))
	if out3.NetPayoutFils != 0 {
		t.Errorf("day 3 net payout = %d, want 0 (nothing claimed twice)", out3.NetPayoutFils)
	}
}

func TestCloseBatch_BackdatedCreditSettlesOnNextClose(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool, 250)
	day1 := time.Date(2026, 6, 20, 0, 0, 0, 0, time.UTC)
	start1, _ := BusinessDayWindow(day1)

	if out := runOne(t, pool, merchantID, day1); out.NetPayoutFils != 0 {
		t.Fatalf("day 1 net = %d, want 0", out.NetPayoutFils)
	}
	// Issued after day 1 closed, with day 1 as its effective date.
	postCredit(t, pool, merchantID, 7_000, 0, start1)

	out2 := runOne(t, pool, merchantID, day1.AddDate(0, 0, 1))
	if out2.NetPayoutFils != 7_000 {
		t.Errorf("day 2 net payout = %d, want 7000 (a backdated credit is still owed)", out2.NetPayoutFils)
	}
	if p := merchantPayable(t, pool, merchantID); p != 0 {
		t.Errorf("merchant_payable = %d, want 0", p)
	}
}

func TestCloseBatch_IgnoresOtherUnbatchedPayablePostings(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool, 250)
	day := time.Date(2026, 6, 25, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(day)

	// The pre-fix March sweep charged merchants against the residue account
	// (money-and-settlement M13). It is not a sanctioned correction and must
	// not be collected from a payout.
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES ($1, $2, 'merchant_payable',        'debit',  9, $3, 'march residue sweep'),
		       ($1, $2, 'scheme_rounding_residue', 'credit', 9, $3, 'march residue sweep')
	`, uuid.New(), merchantID, start); err != nil {
		t.Fatal(err)
	}
	headCapture(t, pool, merchantID, 250, 0, 10_000, start.Add(time.Hour))

	out := runOne(t, pool, merchantID, day)
	if out.NetPayoutFils != 9_750 {
		t.Errorf("net payout = %d, want 9750 (the sweep group is not a correction)", out.NetPayoutFils)
	}
}
