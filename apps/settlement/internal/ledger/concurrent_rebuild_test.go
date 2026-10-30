package ledger

import (
	"context"
	"sync"
	"testing"
)

// Regression: RefreshBalanceCache upserted merchant_balances rows while
// ranging over a Go map, whose order is randomised on every call, so two
// rebuilds running at once (two console clicks, the button and the
// rebuild-balances CLI, or two packages under `go test ./...`) locked the
// same rows in different orders and Postgres aborted one of them with
// "deadlock detected" (40P01). Both full rebuilds now write in merchant_id
// order, so a concurrent one waits instead of deadlocking.
func TestBalanceRebuilds_ConcurrentCallsDoNotDeadlock(t *testing.T) {
	pool := mustPool(t)
	for i := 0; i < 20; i++ {
		postLedgerLeg(t, pool, insertActiveMerchant(t, pool), "credit", 1000)
	}

	ctx := context.Background()
	const workers, rounds = 4, 2
	errs := make(chan error, workers*rounds)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < rounds; i++ {
				var err error
				if w == workers-1 {
					_, err = RebuildAllBalances(ctx, pool)
				} else {
					_, err = RefreshBalanceCache(ctx, pool)
				}
				errs <- err
			}
		}(w)
	}
	wg.Wait()
	close(errs)

	for err := range errs {
		if err != nil {
			t.Errorf("concurrent balance rebuild failed: %v", err)
		}
	}
}
