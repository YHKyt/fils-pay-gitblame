package internalapi

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
)

// Regression: RecalculateMDR refuses, with nothing committed, a closed batch
// whose linked capture events do not add up to its gross
// (ErrBatchEventsIncomplete). That is a refusal of this request against
// this data, not a server fault, but the handler answered it like any other
// failure: 500 `recalculate_mdr_failed`, which the API turned into a 500
// for the admin. It must be a 409 with a stable code and the reason.
func TestRecalculateMDR_IncompleteBatchIsConflictNotServerError(t *testing.T) {
	pool := mustPool(t)
	server := newTestServer(t, pool)
	ctx := context.Background()

	merchantID := insertActiveMerchant(t, pool)
	businessDate := time.Date(2026, 4, 27, 0, 0, 0, 0, time.UTC)
	// Written directly with its figures and no linked events, as the seed's
	// fixture batches were.
	var batchID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
		VALUES ($1, $2, 'closed', 1000000, 25000, 975000, now())
		RETURNING id
	`, merchantID, businessDate).Scan(&batchID); err != nil {
		t.Fatalf("insert fixture batch: %v", err)
	}

	body := `{"merchantId":"` + merchantID.String() + `","from":"2026-04-27","to":"2026-04-28"}`
	resp := post(t, server, "/internal/recalculate-mdr", "Bearer "+testToken, body)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want 409", resp.StatusCode)
	}
	var got errorResponse
	decodeJSON(t, resp, &got)
	if got.Error != "batch_events_incomplete" {
		t.Errorf("error = %q, want batch_events_incomplete", got.Error)
	}
	if !strings.Contains(got.Message, batchID) {
		t.Errorf("message %q does not name the refused batch %s", got.Message, batchID)
	}

	var fee int64
	if err := pool.QueryRow(ctx, `SELECT fee_fils FROM settlement_batches WHERE id = $1`, batchID).Scan(&fee); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	if fee != 25000 {
		t.Errorf("batch fee = %d, want 25000 unchanged", fee)
	}
}
