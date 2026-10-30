package internalapi

import (
	"context"
	"math/rand"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/filspay/settlement/internal/settlement"
)

// Regression: RunDailyBatch keeps settling the other merchants when one
// fails and returns the report together with the joined error, but the
// run-batch handler answered a bare 500 `run_batch_failed` and dropped the
// report. The admin who clicked "run batch" could not see that the rest of
// the day had been closed and paid. The answer is still a 5xx (part of the
// run failed), and its body now carries the merchants that were settled.
func TestRunBatch_PartialFailureStillReturnsTheReport(t *testing.T) {
	pool := mustPool(t)
	server := newTestServer(t, pool)
	ctx := context.Background()

	// A past business date no other test uses, so the run only settles
	// this test's merchants.
	day := time.Date(2001, 1, 1, 0, 0, 0, 0, time.UTC).AddDate(0, 0, rand.Intn(3000))
	start, _ := settlement.BusinessDayWindow(day)

	good := insertActiveMerchant(t, pool)
	insertCaptureEvent(t, pool, good, 10000, start.Add(time.Hour))

	// A split parent whose weights do not total 10000 fails its payout.
	broken := insertActiveMerchant(t, pool)
	insertCaptureEvent(t, pool, broken, 10000, start.Add(time.Hour))
	if _, err := pool.Exec(ctx, `
		INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps)
		VALUES ($1, $2, 5000)
	`, broken, insertActiveMerchant(t, pool)); err != nil {
		t.Fatalf("insert split child: %v", err)
	}

	resp := post(t, server, "/internal/run-batch", "Bearer "+testToken, `{"date":"`+day.Format("2006-01-02")+`"}`)
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (one merchant failed)", resp.StatusCode)
	}

	var body struct {
		Error           string                         `json:"error"`
		Message         string                         `json:"message"`
		BusinessDate    string                         `json:"businessDate"`
		MerchantResults []merchantBatchOutcomeResponse `json:"merchantResults"`
	}
	decodeJSON(t, resp, &body)

	if body.Error != "run_batch_failed" {
		t.Errorf("error = %q, want run_batch_failed", body.Error)
	}
	if body.Message == "" {
		t.Errorf("message is empty; want the failure that stopped the broken merchant")
	}
	if body.BusinessDate != day.Format("2006-01-02") {
		t.Errorf("businessDate = %q, want %q", body.BusinessDate, day.Format("2006-01-02"))
	}

	var goodBatch uuid.UUID
	var status string
	if err := pool.QueryRow(ctx, `SELECT id, status FROM settlement_batches WHERE merchant_id = $1 AND batch_date = $2`,
		good, day).Scan(&goodBatch, &status); err != nil || status != "paid" {
		t.Fatalf("good merchant's batch: status %q, err %v; want paid", status, err)
	}

	var found *merchantBatchOutcomeResponse
	for i := range body.MerchantResults {
		if body.MerchantResults[i].MerchantID == broken.String() {
			t.Errorf("merchantResults lists the merchant that failed (%s)", broken)
		}
		if body.MerchantResults[i].MerchantID == good.String() {
			found = &body.MerchantResults[i]
		}
	}
	if found == nil {
		t.Fatalf("merchantResults %+v does not list the merchant that was paid (%s)", body.MerchantResults, good)
	}
	if found.BatchID != goodBatch.String() || found.GrossFils != 10000 || found.FeeFils != 250 || found.NetPayoutFils != 9750 {
		t.Errorf("paid merchant's outcome = %+v, want batch %s gross 10000 fee 250 net 9750", *found, goodBatch)
	}
}
