package settlement

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/filspay/settlement/internal/money"
)

// claimBatchCorrections claims every unsettled journaled money correction of
// the merchant posted before windowEnd for batchID, and returns their signed
// merchant_payable total (credits - debits).
//
// A journaled correction is an entry group that moves merchant_payable with
// no transaction and no settlement batch and is funded by one of the two
// correction contra accounts: an admin credit (merchant_credit_contra, plus
// its MDR reversal legs in the same group) or a journaled balance adjustment
// (manual_balance_adjustment_contra: CSV import, adjustMerchantBalanceJournaled).
// ADR-0006 keeps cache-only display corrections out of the ledger and out of
// settlement; these are the journaled, real-money ones, so they are paid (or
// collected) by the next close like a refund is. Restricting to the two
// contra accounts keeps any other unbatched merchant_payable posting (for
// example a group from the pre-fix March sweep, which used
// scheme_rounding_residue) out of payouts.
//
// No lower bound, as for refunds: a correction dated into a business day
// whose batch already closed (a backdated credit) is still owed and is
// settled by the next close instead of never. The claim row's primary key
// makes a group settle exactly once, even under concurrent closes.
func claimBatchCorrections(ctx context.Context, tx pgx.Tx, merchantID, batchID uuid.UUID, windowEnd time.Time) (money.Fils, error) {
	var net int64
	err := tx.QueryRow(ctx, `
		WITH candidates AS (
			SELECT le.entry_group_id,
			       SUM(CASE WHEN le.direction = 'credit' THEN le.amount_fils ELSE -le.amount_fils END) AS net_fils
			  FROM ledger_entries le
			 WHERE le.merchant_id = $1
			   AND le.account_id = 'merchant_payable'
			   AND le.transaction_id IS NULL
			   AND le.settlement_batch_id IS NULL
			   AND le.occurred_at < $3
			   AND EXISTS (
			     SELECT 1 FROM ledger_entries c
			      WHERE c.entry_group_id = le.entry_group_id
			        AND c.account_id IN ('merchant_credit_contra', 'manual_balance_adjustment_contra')
			   )
			   AND NOT EXISTS (
			     SELECT 1 FROM settlement_batch_corrections s WHERE s.entry_group_id = le.entry_group_id
			   )
			 GROUP BY le.entry_group_id
		), claimed AS (
			INSERT INTO settlement_batch_corrections (entry_group_id, settlement_batch_id, merchant_id, net_fils)
			SELECT entry_group_id, $2, $1, net_fils FROM candidates
			ON CONFLICT (entry_group_id) DO NOTHING
			RETURNING net_fils
		)
		SELECT COALESCE(SUM(net_fils), 0) FROM claimed
	`, merchantID, batchID, windowEnd).Scan(&net)
	if err != nil {
		return 0, fmt.Errorf("settlement: CloseBatch: claim journaled corrections: %w", err)
	}
	return money.Fils(net), nil
}
