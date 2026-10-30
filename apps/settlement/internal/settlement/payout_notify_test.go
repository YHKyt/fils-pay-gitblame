package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// insertBatch inserts one settlement_batches row directly, so a test can
// place a batch in an exact (status, net_payout_fils) state without having
// to drive a whole RunDailyBatch pass to get there.
func insertBatch(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, batchDate time.Time, status string, netPayoutFils int64) uuid.UUID {
	t.Helper()
	var paidAt any
	if status == "paid" {
		paidAt = time.Now().UTC()
	}
	var id uuid.UUID
	err := pool.QueryRow(context.Background(), `
		INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, paid_at)
		VALUES ($1, $2, $3, $4, 0, $4, $5)
		RETURNING id
	`, merchantID, batchDate, status, netPayoutFils, paidAt).Scan(&id)
	if err != nil {
		t.Fatalf("insertBatch: %v", err)
	}
	return id
}

func countPaidEvents(t *testing.T, pool *pgxpool.Pool, batchID uuid.UUID) int {
	t.Helper()
	var n int
	err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM outbox_events
		 WHERE event_type = 'settlement.paid' AND aggregate_id = $1
	`, batchID).Scan(&n)
	if err != nil {
		t.Fatalf("countPaidEvents: %v", err)
	}
	return n
}

func TestEnqueuePayoutNotificationsEnqueuesOnePerPaidBatch(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()

	merchantID := insertActiveMerchant(t, pool, 250)
	base := time.Date(2026, 3, 2, 0, 0, 0, 0, time.UTC)
	paidBatch := insertBatch(t, pool, merchantID, base, "paid", 471_300)

	if _, err := EnqueuePayoutNotifications(ctx, pool); err != nil {
		t.Fatalf("EnqueuePayoutNotifications: %v", err)
	}
	if got := countPaidEvents(t, pool, paidBatch); got != 1 {
		t.Fatalf("expected exactly 1 settlement.paid event for the paid batch, got %d", got)
	}

	// The payload the webhook dispatcher's delivery-creation join depends on:
	// merchantId must be present at the top level, or the event matches zero
	// endpoints.
	var merchantIDInPayload uuid.UUID
	var batchDate string
	var netPayoutFils int64
	err := pool.QueryRow(ctx, `
		SELECT (payload->>'merchantId')::uuid, payload->>'batchDate', (payload->>'netPayoutFils')::bigint
		  FROM outbox_events
		 WHERE event_type = 'settlement.paid' AND aggregate_id = $1
	`, paidBatch).Scan(&merchantIDInPayload, &batchDate, &netPayoutFils)
	if err != nil {
		t.Fatalf("read settlement.paid payload: %v", err)
	}
	if merchantIDInPayload != merchantID {
		t.Fatalf("payload merchantId = %s, want %s", merchantIDInPayload, merchantID)
	}
	if batchDate != "2026-03-02" {
		t.Fatalf("payload batchDate = %q, want %q", batchDate, "2026-03-02")
	}
	if netPayoutFils != 471_300 {
		t.Fatalf("payload netPayoutFils = %d, want 471300", netPayoutFils)
	}
}

// FH: sequential re-run only, concurrent run not covered. todo
func TestEnqueuePayoutNotificationsIsIdempotent(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()

	merchantID := insertActiveMerchant(t, pool, 250)
	paidBatch := insertBatch(t, pool, merchantID, time.Date(2026, 3, 3, 0, 0, 0, 0, time.UTC), "paid", 12_500)

	if _, err := EnqueuePayoutNotifications(ctx, pool); err != nil {
		t.Fatalf("first EnqueuePayoutNotifications: %v", err)
	}
	if _, err := EnqueuePayoutNotifications(ctx, pool); err != nil {
		t.Fatalf("second EnqueuePayoutNotifications: %v", err)
	}

	if got := countPaidEvents(t, pool, paidBatch); got != 1 {
		t.Fatalf("a second scan must be a no-op; expected 1 settlement.paid event, got %d", got)
	}
}

func TestEnqueuePayoutNotificationsSkipsIneligibleBatches(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()

	// This test used to also require that a paid zero-payout batch get no
	// event. That pinned a bug (judgeprep JP5): settlement.paid is the only
	// way reporting learns a batch was paid, so such a batch stayed 'closed'
	// in the payout trends forever. Zero/negative net batches are now
	// notified (payout_notify_zero_test.go) and the webhook dispatcher skips
	// them, so only the not-yet-paid case remains here.
	merchantID := insertActiveMerchant(t, pool, 250)
	notPaid := insertBatch(t, pool, merchantID, time.Date(2026, 3, 5, 0, 0, 0, 0, time.UTC), "closed", 90_000)

	if _, err := EnqueuePayoutNotifications(ctx, pool); err != nil {
		t.Fatalf("EnqueuePayoutNotifications: %v", err)
	}

	if got := countPaidEvents(t, pool, notPaid); got != 0 {
		t.Fatalf("a batch that has not reached 'paid' must not be notified, got %d event(s)", got)
	}
}

// Regression: the daemon and `run-batch` (or two daemons) scanning at the same
// time both passed the scan's NOT EXISTS and each enqueued settlement.paid.
func TestEnqueuePayoutNotificationsConcurrentScansEnqueueOnce(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()

	merchantID := insertActiveMerchant(t, pool, 250)
	// Many batches widen the window between the scan and the inserts.
	batches := make([]uuid.UUID, 0, 40)
	for d := 0; d < 40; d++ {
		batches = append(batches, insertBatch(t, pool, merchantID, time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC).AddDate(0, 0, d), "paid", 9_000))
	}

	const scanners = 12
	errs := make(chan error, scanners)
	start := make(chan struct{})
	for i := 0; i < scanners; i++ {
		go func() {
			<-start
			_, err := EnqueuePayoutNotifications(ctx, pool)
			errs <- err
		}()
	}
	close(start)
	for i := 0; i < scanners; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("EnqueuePayoutNotifications: %v", err)
		}
	}

	for _, b := range batches {
		if got := countPaidEvents(t, pool, b); got != 1 {
			t.Fatalf("concurrent scans must enqueue exactly one settlement.paid event per batch, got %d for %s", got, b)
		}
	}
}
