package internalapi

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/filspay/settlement/internal/settlement"
)

// bahrainToday is today's business date: the Asia/Bahrain calendar date of
// now, as the UTC-midnight time.Time the run-batch handler parses dates into.
func bahrainToday() time.Time {
	y, m, d := time.Now().In(settlement.BusinessLocation()).Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// Regression: run-batch accepted today (and future dates). CloseBatch only
// selects that one day's window and a closed batch is never scanned again,
// so a 13:00 re-run closed the day and every later capture that day was
// stranded for good. A day that has not ended must be refused with nothing
// written.
func TestRunBatch_RefusesBusinessDayThatHasNotEnded(t *testing.T) {
	pool := mustPool(t)
	server := newTestServer(t, pool)

	merchantID := insertActiveMerchant(t, pool)
	today := bahrainToday()
	todayStart, _ := settlement.BusinessDayWindow(today)
	// A capture already made today, before finance clicks the button.
	insertCaptureEvent(t, pool, merchantID, 10000, todayStart)

	for _, date := range []time.Time{today, today.AddDate(0, 0, 1)} {
		day := date.Format(businessDateLayout)
		body := `{"date":"` + day + `","merchantId":"` + merchantID.String() + `"}`
		resp := post(t, server, "/internal/run-batch", "Bearer "+testToken, body)
		if resp.StatusCode != http.StatusUnprocessableEntity {
			t.Fatalf("run-batch %s: status = %d, want 422", day, resp.StatusCode)
		}
		var got errorResponse
		decodeJSON(t, resp, &got)
		if got.Error != "business_day_not_over" {
			t.Errorf("run-batch %s: error = %q, want business_day_not_over", day, got.Error)
		}
	}

	var batches, batchedEvents int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM settlement_batches WHERE merchant_id = $1`, merchantID).Scan(&batches); err != nil {
		t.Fatalf("count batches: %v", err)
	}
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM transaction_events te JOIN transactions t ON t.id = te.transaction_id
		 WHERE t.merchant_id = $1 AND te.settlement_batch_id IS NOT NULL`, merchantID).Scan(&batchedEvents); err != nil {
		t.Fatalf("count batched events: %v", err)
	}
	if batches != 0 || batchedEvents != 0 {
		t.Errorf("refused run wrote %d batch(es) and batched %d event(s), want 0 and 0", batches, batchedEvents)
	}
}

// Yesterday's business day has ended, so it still closes and pays out.
func TestRunBatch_YesterdayStillRuns(t *testing.T) {
	pool := mustPool(t)
	server := newTestServer(t, pool)

	merchantID := insertActiveMerchant(t, pool)
	yesterday := bahrainToday().AddDate(0, 0, -1)
	start, _ := settlement.BusinessDayWindow(yesterday)
	insertCaptureEvent(t, pool, merchantID, 10000, start.Add(time.Hour))

	body := `{"date":"` + yesterday.Format(businessDateLayout) + `","merchantId":"` + merchantID.String() + `"}`
	resp := post(t, server, "/internal/run-batch", "Bearer "+testToken, body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var report runBatchResponse
	decodeJSON(t, resp, &report)
	if len(report.MerchantResults) != 1 || report.MerchantResults[0].GrossFils != 10000 {
		t.Fatalf("merchantResults = %+v, want one result with grossFils 10000", report.MerchantResults)
	}
	var status string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM settlement_batches WHERE id = $1`, report.MerchantResults[0].BatchID).Scan(&status); err != nil {
		t.Fatalf("query batch status: %v", err)
	}
	if status != "paid" {
		t.Errorf("settlement_batches.status = %q, want paid", status)
	}
}
