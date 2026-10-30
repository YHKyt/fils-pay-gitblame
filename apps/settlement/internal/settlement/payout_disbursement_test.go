package settlement

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/disbursement"
	"github.com/filspay/settlement/internal/splits"
)

type disbursementRow struct {
	count     int
	amount    int64
	reference string
}

func disbursementsFor(t *testing.T, pool *pgxpool.Pool, batchID uuid.UUID) disbursementRow {
	t.Helper()
	var r disbursementRow
	err := pool.QueryRow(context.Background(), `
		SELECT count(*), COALESCE(MAX(amount_fils), 0), COALESCE(MAX(disbursement_reference), '')
		  FROM settlement_payout_disbursements WHERE settlement_batch_id = $1
	`, batchID).Scan(&r.count, &r.amount, &r.reference)
	if err != nil {
		t.Fatalf("disbursementsFor: %v", err)
	}
	return r
}

func requireNoWebhookEndpoints(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID) {
	t.Helper()
	if n := countRows(t, pool, `SELECT count(*) FROM webhook_endpoints WHERE merchant_id = $1`, merchantID); n != 0 {
		t.Fatalf("test merchant has %d webhook endpoints, want 0", n)
	}
}

// Regression: the disbursement row was written only by apps/api's webhook
// dispatcher, so a merchant with no webhook endpoint was marked paid, and
// its payout legs posted, with no disbursement record. PayoutBatch now
// writes it in the pay transaction, exactly once.
func TestPayoutBatch_RecordsOneDisbursementWithoutWebhookEndpoint(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	requireNoWebhookEndpoints(t, pool, merchantID)
	batchID := insertBatch(t, pool, merchantID, time.Date(2026, 4, 2, 0, 0, 0, 0, time.UTC), "closed", 97_500)

	if _, err := PayoutBatch(ctx, pool, batchID); err != nil {
		t.Fatalf("PayoutBatch: %v", err)
	}
	first := disbursementsFor(t, pool, batchID)
	if first.count != 1 || first.amount != 97_500 || !strings.HasPrefix(first.reference, "disb_") {
		t.Fatalf("after payout: %d disbursement rows (amount %d, ref %q), want 1 row of 97500 with a disb_ reference",
			first.count, first.amount, first.reference)
	}

	second, err := PayoutBatch(ctx, pool, batchID)
	if err != nil || !second.AlreadyPaid {
		t.Fatalf("second PayoutBatch: AlreadyPaid=%v err=%v, want an AlreadyPaid no-op", second.AlreadyPaid, err)
	}
	if again := disbursementsFor(t, pool, batchID); again != first {
		t.Fatalf("after re-pay: %+v, want the original row unchanged %+v", again, first)
	}
}

// The sub-merchant split path marks batches paid on its own, so it records
// the disbursement too: one row per batch, for what the split legs paid.
func TestPayoutSplitBatch_RecordsOneDisbursement(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	parentID := insertActiveMerchant(t, pool, 250)
	requireNoWebhookEndpoints(t, pool, parentID)
	for _, weight := range []int{6000, 4000} {
		childID := insertActiveMerchant(t, pool, 250)
		if _, err := pool.Exec(ctx, `
			INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps) VALUES ($1, $2, $3)
		`, parentID, childID, weight); err != nil {
			t.Fatalf("insert split child: %v", err)
		}
	}
	batchID := insertBatch(t, pool, parentID, time.Date(2026, 4, 3, 0, 0, 0, 0, time.UTC), "closed", 10_001)

	for i := 0; i < 2; i++ {
		if _, err := splits.PayoutSplitBatch(ctx, pool, batchID); err != nil {
			t.Fatalf("PayoutSplitBatch #%d: %v", i+1, err)
		}
	}
	if got := disbursementsFor(t, pool, batchID); got.count != 1 || got.amount != 10_001 {
		t.Fatalf("split batch: %d disbursement rows (amount %d), want 1 row of 10001", got.count, got.amount)
	}
}

// A zero-net batch pays nothing and gets no instruction (amount_fils > 0).
func TestPayoutBatch_ZeroNetRecordsNoDisbursement(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool, 250)
	batchID := insertBatch(t, pool, merchantID, time.Date(2026, 4, 4, 0, 0, 0, 0, time.UTC), "closed", 0)

	if _, err := PayoutBatch(context.Background(), pool, batchID); err != nil {
		t.Fatalf("PayoutBatch: %v", err)
	}
	if got := disbursementsFor(t, pool, batchID); got.count != 0 {
		t.Fatalf("zero-net batch has %d disbursement rows, want 0", got.count)
	}
}

// Record is idempotent per batch (UNIQUE + ON CONFLICT DO NOTHING, 0093), so a
// repeat inside or across transactions never adds a second instruction.
func TestRecordDisbursement_RepeatIsANoOp(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	batchID := insertBatch(t, pool, merchantID, time.Date(2026, 4, 5, 0, 0, 0, 0, time.UTC), "paid", 5_000)

	for i := 0; i < 2; i++ {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatalf("begin: %v", err)
		}
		for j := 0; j < 2; j++ {
			if err := disbursement.Record(ctx, tx, batchID, 5_000); err != nil {
				tx.Rollback(ctx) //nolint:errcheck
				t.Fatalf("Record (tx %d, call %d): %v", i+1, j+1, err)
			}
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("commit: %v", err)
		}
	}
	if got := disbursementsFor(t, pool, batchID); got.count != 1 {
		t.Fatalf("%d disbursement rows after four Record calls, want 1", got.count)
	}
}
