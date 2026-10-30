package main

import (
	"context"
	"math/rand"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Regression: RunDailyBatch keeps settling the other merchants when one
// fails and returns the report together with the joined error, but
// `run-batch` called log.Fatalf on that error straight away. The merchants
// that were paid were never printed and their settlement.paid
// notifications were never enqueued, so the operator saw only the failure
// and could not tell that the rest of the day had been paid. The command
// must still exit non-zero, after reporting and notifying what was paid.
func TestRunBatchCLI_PartialFailureStillReportsAndNotifiesPaidMerchants(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping DB-backed test (run against a real, migrated Postgres)")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)

	newMerchant := func(name string) uuid.UUID {
		var id uuid.UUID
		if err := pool.QueryRow(ctx, `
			INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
			VALUES ($1, 250, 'active', false) RETURNING id
		`, name+"-"+uuid.NewString()).Scan(&id); err != nil {
			t.Fatalf("insert merchant: %v", err)
		}
		return id
	}
	// A past business date no other test uses, so the run only has these
	// merchants' captures to settle.
	day := time.Date(2001, 1, 1, 0, 0, 0, 0, time.UTC).AddDate(0, 0, rand.Intn(3000))
	capture := func(merchantID uuid.UUID) {
		occurredAt := day.Add(2 * time.Hour) // inside the Bahrain business day
		var txnID uuid.UUID
		if err := pool.QueryRow(ctx, `
			INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
			VALUES ($1, 'captured', 10000, 10000, $2, $3) RETURNING id
		`, merchantID, "acq-ref-"+uuid.NewString(), occurredAt).Scan(&txnID); err != nil {
			t.Fatalf("insert transaction: %v", err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at)
			VALUES ($1, 'captured', 10000, 'system', $2)
		`, txnID, occurredAt); err != nil {
			t.Fatalf("insert event: %v", err)
		}
	}

	good := newMerchant("cli-partial-good")
	capture(good)
	// A split parent whose weights do not total 10000 fails its payout (G2).
	broken := newMerchant("cli-partial-broken")
	capture(broken)
	if _, err := pool.Exec(ctx, `
		INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps)
		VALUES ($1, $2, 5000)
	`, broken, newMerchant("cli-partial-child")); err != nil {
		t.Fatalf("insert split child: %v", err)
	}

	out, code := runCLI(t, "run-batch", "--date="+day.Format("2006-01-02"))
	if code == 0 {
		t.Errorf("run-batch exited 0 although one merchant failed; output:\n%s", out)
	}

	var goodBatch uuid.UUID
	var status string
	if err := pool.QueryRow(ctx, `SELECT id, status FROM settlement_batches WHERE merchant_id = $1 AND batch_date = $2`,
		good, day).Scan(&goodBatch, &status); err != nil || status != "paid" {
		t.Fatalf("good merchant's batch: status %q, err %v; want paid", status, err)
	}
	if !strings.Contains(out, "merchant="+good.String()) {
		t.Errorf("output does not report the merchant that was paid (%s):\n%s", good, out)
	}
	var notified int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM outbox_events WHERE event_type = 'settlement.paid' AND aggregate_id = $1
	`, goodBatch).Scan(&notified); err != nil {
		t.Fatalf("count settlement.paid: %v", err)
	}
	if notified != 1 {
		t.Errorf("settlement.paid events for the paid batch = %d, want 1", notified)
	}
}
