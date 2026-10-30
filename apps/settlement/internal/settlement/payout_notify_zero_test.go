package settlement

import (
	"context"
	"testing"
	"time"
)

// Regression (judgeprep JP5, eventsbus.md): a paid batch with nothing to pay
// out got no settlement.paid event, and that event is the only way the
// reporting read model learns a batch was paid, so its payout trend stayed
// 'closed' forever. Every paid batch is now notified; the webhook dispatcher
// is what keeps merchants from getting a "payout" webhook for a zero or
// negative net (dispatcherZeroPayout.test.ts in apps/api).
func TestEnqueuePayoutNotificationsNotifiesZeroAndNegativeNetBatches(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()

	merchantID := insertActiveMerchant(t, pool, 250)
	zeroNet := insertBatch(t, pool, merchantID, time.Date(2026, 5, 4, 0, 0, 0, 0, time.UTC), "paid", 0)
	negativeNet := insertBatch(t, pool, merchantID, time.Date(2026, 5, 5, 0, 0, 0, 0, time.UTC), "paid", -1_250)

	if _, err := EnqueuePayoutNotifications(ctx, pool); err != nil {
		t.Fatalf("EnqueuePayoutNotifications: %v", err)
	}
	if got := countPaidEvents(t, pool, zeroNet); got != 1 {
		t.Fatalf("a paid zero-net batch must get one settlement.paid event, got %d", got)
	}
	if got := countPaidEvents(t, pool, negativeNet); got != 1 {
		t.Fatalf("a paid negative-net batch must get one settlement.paid event, got %d", got)
	}

	var netPayoutFils int64
	if err := pool.QueryRow(ctx, `
		SELECT (payload->>'netPayoutFils')::bigint FROM outbox_events
		 WHERE event_type = 'settlement.paid' AND aggregate_id = $1
	`, negativeNet).Scan(&netPayoutFils); err != nil {
		t.Fatalf("read payload: %v", err)
	}
	if netPayoutFils != -1_250 {
		t.Fatalf("payload netPayoutFils = %d, want -1250", netPayoutFils)
	}
}
