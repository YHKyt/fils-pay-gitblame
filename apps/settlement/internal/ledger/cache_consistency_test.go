package ledger

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
	"github.com/filspay/settlement/internal/settlement"
)

// captureLikeAPI writes what apps/api's captureTransaction writes for one
// full capture: the transaction and its capture event, the gross and MDR fee
// legs on merchant_payable, and the same net move on merchant_balances.
// Returns the net it credited.
func captureLikeAPI(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, amountFils money.Fils, occurredAt time.Time) money.Fils {
	t.Helper()
	ctx := context.Background()
	feeFils := settlement.ComputeSettlementFee(amountFils, 250, 0)
	net := amountFils - feeFils

	var txnID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
		VALUES ($1, 'captured', $2, $2, $3, $4)
		RETURNING id
	`, merchantID, int64(amountFils), "acq-ref-"+uuid.New().String(), occurredAt).Scan(&txnID); err != nil {
		t.Fatalf("captureLikeAPI: insert transaction: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at)
		VALUES ($1, 'captured', $2, 'system', $3)
	`, txnID, int64(amountFils), occurredAt); err != nil {
		t.Fatalf("captureLikeAPI: insert event: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO ledger_entries
		  (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES
		  ($1, $2, $3, 'card_scheme_clearing', 'debit',  $4, $6, 'capture: gross'),
		  ($1, $2, $3, 'merchant_payable',     'credit', $4, $6, 'capture: gross'),
		  ($1, $2, $3, 'merchant_payable',     'debit',  $5, $6, 'capture: MDR fee'),
		  ($1, $2, $3, 'platform_fee_revenue', 'credit', $5, $6, 'capture: MDR fee')
	`, uuid.New(), merchantID, txnID, int64(amountFils), int64(feeFils), occurredAt); err != nil {
		t.Fatalf("captureLikeAPI: insert ledger legs: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
		VALUES ($1, $2, now())
		ON CONFLICT (merchant_id) DO UPDATE
		  SET cached_payable_fils = merchant_balances.cached_payable_fils + EXCLUDED.cached_payable_fils
	`, merchantID, int64(net)); err != nil {
		t.Fatalf("captureLikeAPI: move cache: %v", err)
	}
	return net
}

func cachedPayable(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID) money.Fils {
	t.Helper()
	var fils int64
	if err := pool.QueryRow(context.Background(),
		`SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&fils); err != nil {
		t.Fatalf("read merchant_balances: %v", err)
	}
	return money.Fils(fils)
}

// The cache must equal the ledger walk at every step of capture, rebuild,
// close and payout, whichever rebuild (if any) runs before the batch closes.
// CloseBatch used to add the batch's net on top of a cache that a rebuild had
// already set from the ledger, so the capture was counted twice and the paid
// merchant kept 97.500 BD in the cache while the ledger (and the CLI) said 0.
func TestBalanceCache_MatchesLedgerThroughCaptureRebuildCloseAndPayout(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()

	rebuilds := map[string]func() error{
		"no rebuild": func() error { return nil },
		"console button": func() error {
			_, err := RefreshBalanceCache(ctx, pool)
			return err
		},
		"CLI": func() error {
			_, err := RebuildAllBalances(ctx, pool)
			return err
		},
	}
	for name, rebuild := range rebuilds {
		t.Run(name, func(t *testing.T) {
			merchantID := insertActiveMerchant(t, pool)
			businessDate := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
			start, _ := settlement.BusinessDayWindow(businessDate)

			assertMatchesLedger := func(step string) money.Fils {
				t.Helper()
				cli, err := RebuildMerchantBalance(ctx, pool, merchantID)
				if err != nil {
					t.Fatalf("RebuildMerchantBalance: %v", err)
				}
				if got := cachedPayable(t, pool, merchantID); got != cli {
					t.Fatalf("after %s: cached_payable_fils = %d, ledger walk = %d", step, got, cli)
				}
				return cli
			}

			captureNet := captureLikeAPI(t, pool, merchantID, 100_000, start.Add(time.Hour)) // 100 BD at 2.5%
			assertMatchesLedger("capture")

			if err := rebuild(); err != nil {
				t.Fatalf("rebuild: %v", err)
			}
			assertMatchesLedger("rebuild")

			closed, err := settlement.CloseBatch(ctx, pool, merchantID, businessDate)
			if err != nil {
				t.Fatalf("CloseBatch: %v", err)
			}
			assertMatchesLedger("close")

			if _, err := settlement.PayoutBatch(ctx, pool, closed.BatchID); err != nil {
				t.Fatalf("PayoutBatch: %v", err)
			}
			final := assertMatchesLedger("payout")
			if final != 0 {
				t.Fatalf("after payout: ledger walk = %d, want 0 (captured net %d, paid %d)", final, captureNet, closed.NetPayoutFils)
			}
		})
	}
}
