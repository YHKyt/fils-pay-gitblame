package settlement

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
)

// Fixtures that write rows exactly as apps/api writes them today, so the
// batch tests settle what production books rather than what settlement
// would like to recompute.

// headCapture writes one full capture the way captureTransaction
// (apps/api/src/payments/capture.ts) does: the transaction row, the
// 'capture: gross' and 'capture: MDR fee' leg pairs in one entry group, and
// the 'captured' event carrying metadata.feeFils and discountBps. The fee is
// the MDR on the amount net of the negotiated discount, each step rounded
// half-even. Ledger legs and the event share one timestamp, as now() does
// inside the capture transaction.
func headCapture(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, mdrBps, discountBps int64, amountFils money.Fils, at time.Time) (txnID uuid.UUID, feeFils money.Fils) {
	t.Helper()
	ctx := context.Background()
	acquirerRef := "acq_" + uuid.New().String()

	err := pool.QueryRow(ctx, `
		INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
		VALUES ($1, 'captured', $2, $2, $3, $4)
		RETURNING id
	`, merchantID, int64(amountFils), acquirerRef, at).Scan(&txnID)
	if err != nil {
		t.Fatalf("headCapture: insert transaction: %v", err)
	}

	discounted := amountFils - money.ApplyRateFils(amountFils, discountBps)
	feeFils = money.ApplyRateFils(discounted, mdrBps)

	groupID := uuid.New()
	_, err = pool.Exec(ctx, `
		INSERT INTO ledger_entries
		  (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES
		  ($1, $2, $3, 'card_scheme_clearing', 'debit',  $4, $5, 'capture: gross'),
		  ($1, $2, $3, 'merchant_payable',     'credit', $4, $5, 'capture: gross')
	`, groupID, merchantID, txnID, int64(amountFils), at)
	if err != nil {
		t.Fatalf("headCapture: insert gross legs: %v", err)
	}
	if feeFils > 0 {
		_, err = pool.Exec(ctx, `
			INSERT INTO ledger_entries
			  (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
			VALUES
			  ($1, $2, $3, 'merchant_payable',     'debit',  $4, $5, 'capture: MDR fee'),
			  ($1, $2, $3, 'platform_fee_revenue', 'credit', $4, $5, 'capture: MDR fee')
		`, groupID, merchantID, txnID, int64(feeFils), at)
		if err != nil {
			t.Fatalf("headCapture: insert fee legs: %v", err)
		}
	}

	metadata, _ := json.Marshal(map[string]any{"feeFils": int64(feeFils), "discountBps": discountBps, "acquirerReference": acquirerRef})
	_, err = pool.Exec(ctx, `
		INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, actor_id, metadata, occurred_at)
		VALUES ($1, 'captured', $2, 'merchant_api_key', $3, $4, $5)
	`, txnID, int64(amountFils), uuid.New(), metadata, at)
	if err != nil {
		t.Fatalf("headCapture: insert event: %v", err)
	}
	return txnID, feeFils
}

// headRefund writes one succeeded refund the way processRefund
// (apps/api/src/payments/processRefund.ts) does: the fee reversal is the
// pro-rata share of the fee the transaction was charged (its non-refund
// platform_fee_revenue legs) for the cumulative refunded amount, minus what
// earlier refunds reversed; then the refunds row, refunded_fils and status,
// the 'refund: gross' and 'refund: MDR fee reversal' leg pairs in one entry
// group, and the negative 'refunded'/'refund_partial' event.
func headRefund(t *testing.T, pool *pgxpool.Pool, merchantID, txnID uuid.UUID, amountFils money.Fils, at time.Time) (refundID uuid.UUID, feeReversedFils money.Fils) {
	t.Helper()
	ctx := context.Background()

	var captured, priorRefunded, fee, priorReversed int64
	var acquirerRef string
	err := pool.QueryRow(ctx, `
		SELECT t.captured_fils, t.refunded_fils, t.acquirer_reference,
		       (SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)
		          FROM ledger_entries
		         WHERE transaction_id = t.id AND account_id = 'platform_fee_revenue' AND description NOT LIKE 'refund:%'),
		       (SELECT COALESCE(SUM(fee_reversed_fils), 0) FROM refunds WHERE transaction_id = t.id AND status = 'succeeded')
		  FROM transactions t WHERE t.id = $1
	`, txnID).Scan(&captured, &priorRefunded, &acquirerRef, &fee, &priorReversed)
	if err != nil {
		t.Fatalf("headRefund: read transaction: %v", err)
	}
	if fee < 0 {
		fee = 0
	}
	newRefunded := priorRefunded + int64(amountFils)
	cumulativeShare := money.BankersRoundDiv(fee*newRefunded, captured)
	if owed := cumulativeShare - priorReversed; owed > 0 {
		feeReversedFils = money.Fils(owed)
	}

	status, eventType := "partially_refunded", "refund_partial"
	if newRefunded >= captured {
		status, eventType = "refunded", "refunded"
	}
	if _, err := pool.Exec(ctx, `UPDATE transactions SET refunded_fils = $2, status = $3 WHERE id = $1`, txnID, newRefunded, status); err != nil {
		t.Fatalf("headRefund: update transaction: %v", err)
	}

	err = pool.QueryRow(ctx, `
		INSERT INTO refunds
		  (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status,
		   acquirer_reference, reason, created_by_type, created_by_id, occurred_at)
		VALUES ($1, $2, $3, $4, 'succeeded', $5, 'unspecified', 'merchant_api_key', $6, $7)
		RETURNING id
	`, txnID, merchantID, int64(amountFils), int64(feeReversedFils), acquirerRef, uuid.New(), at).Scan(&refundID)
	if err != nil {
		t.Fatalf("headRefund: insert refund: %v", err)
	}

	groupID := uuid.New()
	_, err = pool.Exec(ctx, `
		INSERT INTO ledger_entries
		  (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES
		  ($1, $2, $3, 'merchant_payable',     'debit',  $4, $5, 'refund: gross'),
		  ($1, $2, $3, 'card_scheme_clearing', 'credit', $4, $5, 'refund: gross')
	`, groupID, merchantID, txnID, int64(amountFils), at)
	if err != nil {
		t.Fatalf("headRefund: insert gross legs: %v", err)
	}
	if feeReversedFils > 0 {
		_, err = pool.Exec(ctx, `
			INSERT INTO ledger_entries
			  (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
			VALUES
			  ($1, $2, $3, 'platform_fee_revenue', 'debit',  $4, $5, 'refund: MDR fee reversal'),
			  ($1, $2, $3, 'merchant_payable',     'credit', $4, $5, 'refund: MDR fee reversal')
		`, groupID, merchantID, txnID, int64(feeReversedFils), at)
		if err != nil {
			t.Fatalf("headRefund: insert fee reversal legs: %v", err)
		}
	}

	metadata, _ := json.Marshal(map[string]any{"refundId": refundID, "feeReversedFils": int64(feeReversedFils), "acquirerReference": acquirerRef})
	_, err = pool.Exec(ctx, `
		INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, actor_id, metadata, occurred_at)
		VALUES ($1, $2, $3, 'merchant_api_key', $4, $5, $6)
	`, txnID, eventType, -int64(amountFils), uuid.New(), metadata, at)
	if err != nil {
		t.Fatalf("headRefund: insert event: %v", err)
	}
	return refundID, feeReversedFils
}

// merchantPayable is the merchant_payable ledger balance (credits - debits):
// what the platform still owes the merchant. Zero once every booked
// movement has been settled and paid.
func merchantPayable(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID) int64 {
	t.Helper()
	var n int64
	err := pool.QueryRow(context.Background(), `
		SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)
		  FROM ledger_entries WHERE merchant_id = $1 AND account_id = 'merchant_payable'
	`, merchantID).Scan(&n)
	if err != nil {
		t.Fatalf("merchantPayable: %v", err)
	}
	return n
}

// cachedPayable is merchant_balances.cached_payable_fils (0 when no row).
func cachedPayable(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID) int64 {
	t.Helper()
	var n int64
	err := pool.QueryRow(context.Background(), `
		SELECT COALESCE((SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1), 0)
	`, merchantID).Scan(&n)
	if err != nil {
		t.Fatalf("cachedPayable: %v", err)
	}
	return n
}

// payoutLegFils sums the merchant_payable debits PayoutBatch posted for a batch.
func payoutLegFils(t *testing.T, pool *pgxpool.Pool, batchID uuid.UUID) int64 {
	t.Helper()
	var n int64
	err := pool.QueryRow(context.Background(), `
		SELECT COALESCE(SUM(amount_fils), 0) FROM ledger_entries
		 WHERE settlement_batch_id = $1 AND account_id = 'merchant_payable' AND direction = 'debit'
		   AND description LIKE 'settlement payout:%'
	`, batchID).Scan(&n)
	if err != nil {
		t.Fatalf("payoutLegFils: %v", err)
	}
	return n
}

// runOne runs the daily pass for one merchant and returns its outcome.
func runOne(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, date time.Time) MerchantBatchOutcome {
	t.Helper()
	report, err := RunDailyBatch(context.Background(), pool, date, &merchantID)
	if err != nil {
		t.Fatalf("RunDailyBatch(%s): %v", date.Format("2006-01-02"), err)
	}
	if len(report.MerchantResults) != 1 {
		t.Fatalf("RunDailyBatch(%s): %d results, want 1", date.Format("2006-01-02"), len(report.MerchantResults))
	}
	return report.MerchantResults[0]
}
