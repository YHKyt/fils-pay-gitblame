// Package disbursement writes settlement_payout_disbursements (0057): the
// payout-rail instruction, with its own reference, for a paid settlement
// batch. It is an operational record, not a ledger posting; the payout legs
// in ledger_entries stay the accounting record of the payout.
package disbursement

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/filspay/settlement/internal/money"
)

// Record writes batchID's disbursement row inside the caller's pay
// transaction, so a batch is never 'paid' without one. It used to be
// written only by apps/api's webhook dispatcher, once a settlement.paid
// delivery existed, so a merchant with no webhook endpoint was paid with no
// disbursement record at all.
//
// At most one row per batch: UNIQUE (settlement_batch_id) (0093) and
// ON CONFLICT DO NOTHING make a repeat call a no-op, and the dispatcher's
// own insert already skips a batch that has a row. A zero or negative
// amount pays nothing, so it writes nothing (amount_fils CHECK > 0).
func Record(ctx context.Context, tx pgx.Tx, batchID uuid.UUID, amountFils money.Fils) error {
	if amountFils <= 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO settlement_payout_disbursements (settlement_batch_id, amount_fils, disbursement_reference)
		VALUES ($1, $2, 'disb_' || gen_random_uuid())
		ON CONFLICT (settlement_batch_id) DO NOTHING
	`, batchID, int64(amountFils))
	if err != nil {
		return fmt.Errorf("disbursement: record batch %s: %w", batchID, err)
	}
	return nil
}
