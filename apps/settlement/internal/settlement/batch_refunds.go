package settlement

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/filspay/settlement/internal/money"
)

// claimedRefunds is what one batch close takes over from the refunds table.
type claimedRefunds struct {
	amountFils      money.Fils // sum of refunds.amount_fils: the gross sent back to cardholders
	feeReversedFils money.Fils // sum of refunds.fee_reversed_fils: the MDR handed back to the merchant
}

// netDeductionFils is what the refunds take off the merchant's payout. It
// is exactly what processRefund journals against merchant_payable: a debit
// of the gross ('refund: gross') and a credit of the fee reversal
// ('refund: MDR fee reversal').
func (r claimedRefunds) netDeductionFils() money.Fils {
	return r.amountFils - r.feeReversedFils
}

// claimBatchRefunds marks every unbatched succeeded refund of the merchant
// that happened before windowEnd as settled by batchID, and returns their
// totals. The UPDATE takes the row locks itself and, under READ COMMITTED,
// re-checks settlement_batch_id IS NULL after any wait, so a refund is
// claimed by exactly one batch (migration 0042: settlement_batch_id mirrors
// transaction_events.settlement_batch_id).
//
// The bound is occurred_at < windowEnd with no lower bound, unlike capture
// events: a refund that no earlier batch claimed (made before this code
// shipped, or on a day whose batch closed first) is still owed and is
// deducted by the next close instead of never.
//
// Refund timeline events (transaction_events 'refunded'/'refund_partial')
// are deliberately not stamped: the refunds row is the settlement record,
// and RecalculateMDR rates every event carrying a batch id.
func claimBatchRefunds(ctx context.Context, tx pgx.Tx, merchantID, batchID uuid.UUID, windowEnd time.Time) (claimedRefunds, error) {
	var r claimedRefunds
	var amount, reversed int64
	err := tx.QueryRow(ctx, `
		WITH claimed AS (
			UPDATE refunds
			   SET settlement_batch_id = $2
			 WHERE merchant_id = $1
			   AND status = 'succeeded'
			   AND settlement_batch_id IS NULL
			   AND occurred_at < $3
			RETURNING amount_fils, fee_reversed_fils
		)
		SELECT COALESCE(SUM(amount_fils), 0), COALESCE(SUM(fee_reversed_fils), 0) FROM claimed
	`, merchantID, batchID, windowEnd).Scan(&amount, &reversed)
	if err != nil {
		return claimedRefunds{}, fmt.Errorf("settlement: CloseBatch: claim refunds: %w", err)
	}
	r.amountFils = money.Fils(amount)
	r.feeReversedFils = money.Fils(reversed)
	return r, nil
}

// claimCarriedShortfall takes over the shortfall of every earlier batch of
// the merchant that closed with a negative net and has finished its
// lifecycle ('paid', which for a negative net means nothing was paid), and
// returns their sum (zero or negative). The claiming batch adds it to its
// own net, so the deficit is recovered from the next money owed to the
// merchant instead of being left in merchant_payable for good. Each
// shortfall is marked with the claiming batch (migration 0090) so it is
// deducted once. If the claiming batch is itself still negative, its net
// already includes the carried amount and it is carried on in turn.
//
// Only 'paid' batches are taken: RecalculateMDR may still rewrite a
// 'closed' batch's net, and a shortfall must not change after it has been
// carried.
func claimCarriedShortfall(ctx context.Context, tx pgx.Tx, merchantID, batchID uuid.UUID) (money.Fils, error) {
	var carried int64
	err := tx.QueryRow(ctx, `
		WITH claimed AS (
			UPDATE settlement_batches
			   SET carried_forward_to_batch_id = $2
			 WHERE merchant_id = $1
			   AND id <> $2
			   AND status = 'paid'
			   AND net_payout_fils < 0
			   AND carried_forward_to_batch_id IS NULL
			RETURNING net_payout_fils
		)
		SELECT COALESCE(SUM(net_payout_fils), 0) FROM claimed
	`, merchantID, batchID).Scan(&carried)
	if err != nil {
		return 0, fmt.Errorf("settlement: CloseBatch: carry forward shortfall: %w", err)
	}
	return money.Fils(carried), nil
}

// paidOutFils is what a payout actually sends for a batch: its net, or
// nothing when the net is zero or negative (a negative net is carried into
// the next batch by claimCarriedShortfall, never paid or clawed back here).
func paidOutFils(netPayoutFils money.Fils) money.Fils {
	if netPayoutFils < 0 {
		return 0
	}
	return netPayoutFils
}
