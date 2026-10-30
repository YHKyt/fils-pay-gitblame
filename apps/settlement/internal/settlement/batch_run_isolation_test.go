package settlement

import (
	"context"
	"errors"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/filspay/settlement/internal/splits"
)

// Regression: RunDailyBatch returned on the first merchant error, so every
// merchant after the failing one (in id order) was not settled that day. The
// daemon only ever retries the most recent business day, so those merchants
// stayed unpaid until an operator backfilled by hand.
//
// Three merchants capture on the same day; the middle one in id order is a
// split parent whose weights do not sum to 10000, so its payout is refused.
// The full daily pass must still pay the other two and report the failure.
func TestRunDailyBatch_OneMerchantFailureDoesNotBlockOthers(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	date := time.Date(2026, 2, 17, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(date)

	ids := []uuid.UUID{
		insertActiveMerchant(t, pool, mdrBps),
		insertActiveMerchant(t, pool, mdrBps),
		insertActiveMerchant(t, pool, mdrBps),
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i].String() < ids[j].String() })
	for _, id := range ids {
		headCapture(t, pool, id, mdrBps, 0, 100_000, start.Add(time.Hour))
	}

	bad := ids[1]
	child := insertActiveMerchant(t, pool, mdrBps)
	if _, err := pool.Exec(ctx, `
		INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps) VALUES ($1, $2, 5000)
	`, bad, child); err != nil {
		t.Fatalf("insert split child: %v", err)
	}
	// Keep the broken split parent out of every later full run in this DB.
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `UPDATE merchants SET status = 'suspended' WHERE id = $1`, bad)
	})

	report, err := RunDailyBatch(ctx, pool, date, nil)
	if err == nil {
		t.Fatalf("RunDailyBatch: want an error for merchant %s, got nil", bad)
	}
	if !errors.Is(err, splits.ErrSplitWeightsNotWhole) || !strings.Contains(err.Error(), bad.String()) {
		t.Errorf("RunDailyBatch error = %v, want the split-weights failure naming %s", err, bad)
	}

	paid := map[uuid.UUID]MerchantBatchOutcome{}
	for _, r := range report.MerchantResults {
		paid[r.MerchantID] = r
	}
	for _, id := range []uuid.UUID{ids[0], ids[2]} {
		out, ok := paid[id]
		if !ok {
			t.Errorf("merchant %s missing from the report: a failure earlier in the run blocked it", id)
			continue
		}
		if out.NetPayoutFils != 97_500 {
			t.Errorf("merchant %s net = %d, want 97500", id, out.NetPayoutFils)
		}
		if legs := payoutLegFils(t, pool, out.BatchID); legs != 97_500 {
			t.Errorf("merchant %s payout legs = %d fils, want 97500", id, legs)
		}
		if p := merchantPayable(t, pool, id); p != 0 {
			t.Errorf("merchant %s merchant_payable = %d, want 0 after payout", id, p)
		}
	}
	if _, ok := paid[bad]; ok {
		t.Errorf("failing merchant %s reported as settled", bad)
	}

	// The failing merchant's batch stays closed and unpaid for a re-run.
	var status string
	if err := pool.QueryRow(ctx, `
		SELECT status FROM settlement_batches WHERE merchant_id = $1 AND batch_date = $2
	`, bad, date).Scan(&status); err != nil {
		t.Fatalf("read failing merchant's batch: %v", err)
	}
	if status != "closed" {
		t.Errorf("failing merchant's batch status = %q, want closed", status)
	}
}
