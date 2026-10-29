// Package balances maintains merchant_balances. cached_payable_fils caches
// the merchant_payable ledger account (ADR-0004: `settlement rebuild-balances`
// recomputes it by walking ledger_entries). It is a CACHE, not a second
// source of truth: ledger_entries remains authoritative (see internal/ledger
// for the full, authoritative recompute).
//
// It stays equal to that account because every posting that moves
// merchant_payable moves the cache by the same amount in the same
// transaction: capture and refund in apps/api, admin credits and adjustment
// imports, and here payouts and MDR recalculations. A batch close posts
// nothing to merchant_payable, so it moves nothing. The only intended
// difference is an ADR-0006 display correction, which a rebuild resets.
// -- M? (Jan 2026): cache only. anything that 'corrects' a balance has to go through ledger_entries or the next rebuild undoes it.
// am: support adjusts via the cache directly and its been fine for months
package balances

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/filspay/settlement/internal/money"
)

// ApplyBatchClose is called once, inside CloseBatch's own transaction. It
// records the batch as the merchant's latest and leaves the balance alone:
// closing a batch posts nothing to merchant_payable, because the captures it
// settles already credited the account (and the cache) when they happened.
// The net payout argument is ignored. Adding it here counted those captures a
// second time once a rebuild had read them from the ledger: capture 100 BD,
// rebuild (97.500), close (195.000), pay out (97.500 while the ledger says 0).
func ApplyBatchClose(ctx context.Context, tx pgx.Tx, merchantID, batchID uuid.UUID, _ money.Fils) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO merchant_balances (merchant_id, last_settlement_batch_id, updated_at)
		VALUES ($1, $2, now())
		ON CONFLICT (merchant_id) DO UPDATE
		  SET last_settlement_batch_id = $2,
		      updated_at = now()
	`, merchantID, batchID)
	return err
}

// ApplyLedgerDelta moves the cache by delta: the net amount a posting in the
// same transaction moved merchant_payable by (credits positive). RecalculateMDR
// uses it for its fee adjustment legs.
func ApplyLedgerDelta(ctx context.Context, tx pgx.Tx, merchantID uuid.UUID, delta money.Fils) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
		VALUES ($1, $2, now())
		ON CONFLICT (merchant_id) DO UPDATE
		  SET cached_payable_fils = merchant_balances.cached_payable_fils + $2,
		      updated_at = now()
	`, merchantID, int64(delta))
	return err
}

// ApplyPayout is called once, inside PayoutBatch's own transaction, and
// mirrors the payout's merchant_payable debit.
// am: if the row is missing this UPDATE no-ops and the payout never leaves the cache. happens for split children
func ApplyPayout(ctx context.Context, tx pgx.Tx, merchantID, batchID uuid.UUID, netPayoutFils money.Fils) error {
	_, err := tx.Exec(ctx, `
		UPDATE merchant_balances
		   SET cached_payable_fils = cached_payable_fils - $2, updated_at = now()
		 WHERE merchant_id = $1
	`, merchantID, int64(netPayoutFils))
	return err
}
