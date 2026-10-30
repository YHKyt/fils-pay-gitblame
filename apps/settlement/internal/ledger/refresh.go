package ledger

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
)

// RefreshBalanceCache recomputes every merchant's cached balance from the
// ledger and overwrites merchant_balances in one transaction. It backs the
// console's "Rebuild cached balances" button.
//
// merchant_balances.cached_payable_fils caches the merchant_payable ledger
// account (captures, minus fees, refunds and payouts, plus adjustments —
// settled or not). The button used to rebuild it from merchant_payable_position,
// a view summing scheme_export_lines: the truncated card-scheme gross of
// settled batches only, a different quantity entirely. That is how Alpha
// Retail's balance went from 135K to 7K on a click while the CLI (which walks
// the ledger) gave the right figure (FP-203). ARCHITECTURE.md says the button
// "triggers the same refresh" as `settlement rebuild-balances`; it now reads
// the same source as RebuildAllBalances.
//
// ADR-0004 moved the button off the ledger because the CLI's per-merchant
// walk was too slow for a 30 s request. The fix keeps the source correct and
// stays fast: one set-based aggregate over ledger_entries instead of one query
// per merchant.
func RefreshBalanceCache(ctx context.Context, db *pgxpool.Pool) (map[uuid.UUID]RebuildDiff, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("ledger: RefreshBalanceCache: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Wait for in-flight cache moves (capture, refund, payout, credit) to
	// commit before reading the ledger, and hold new ones until this rebuild
	// commits, so they add on top of it. Without the lock, the aggregate below
	// missed a move still in flight and the write replaced it with the older
	// figure. Plain reads of merchant_balances are not blocked.
	if _, err := tx.Exec(ctx, `LOCK TABLE merchant_balances IN SHARE ROW EXCLUSIVE MODE`); err != nil {
		return nil, fmt.Errorf("ledger: RefreshBalanceCache: lock merchant_balances: %w", err)
	}

	rows, err := tx.Query(ctx, `
		WITH payable AS (
			SELECT merchant_id,
			       SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END) AS fils
			  FROM ledger_entries
			 WHERE account_id = 'merchant_payable'
			 GROUP BY merchant_id
		), merchants AS (
			SELECT merchant_id FROM payable
			UNION
			SELECT merchant_id FROM merchant_balances
		)
		SELECT m.merchant_id,
		       COALESCE(mb.cached_payable_fils, 0) AS cached_before,
		       COALESCE(p.fils, 0)                 AS rebuilt
		  FROM merchants m
		  LEFT JOIN merchant_balances mb ON mb.merchant_id = m.merchant_id
		  LEFT JOIN payable p            ON p.merchant_id  = m.merchant_id
	`)
	if err != nil {
		return nil, fmt.Errorf("ledger: RefreshBalanceCache: aggregate ledger: %w", err)
	}

	diffs := make(map[uuid.UUID]RebuildDiff)
	for rows.Next() {
		var id uuid.UUID
		var before, rebuilt int64
		if err := rows.Scan(&id, &before, &rebuilt); err != nil {
			rows.Close()
			return nil, fmt.Errorf("ledger: RefreshBalanceCache: scan: %w", err)
		}
		diffs[id] = RebuildDiff{MerchantID: id, CachedBefore: money.Fils(before), Rebuilt: money.Fils(rebuilt)}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ledger: RefreshBalanceCache: iterate: %w", err)
	}
	rows.Close()

	for id, d := range diffs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
			VALUES ($1, $2, now())
			ON CONFLICT (merchant_id) DO UPDATE
			  SET cached_payable_fils = $2, updated_at = now()
		`, id, int64(d.Rebuilt)); err != nil {
			return nil, fmt.Errorf("ledger: RefreshBalanceCache: write rebuilt balance for %s: %w", id, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("ledger: RefreshBalanceCache: commit: %w", err)
	}
	return diffs, nil
}
