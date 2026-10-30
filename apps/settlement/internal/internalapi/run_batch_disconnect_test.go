package internalapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/config"
	"github.com/filspay/settlement/internal/settlement"
)

// observedServer serves the real Handler and reports when a request's
// context has been cancelled while the handler is still running (the
// caller hung up) and when the handler has returned.
type observedServer struct {
	*httptest.Server
	cancelled chan struct{}
	done      chan struct{}
}

func newObservedServer(t *testing.T, pool *pgxpool.Pool) *observedServer {
	t.Helper()
	s := &observedServer{cancelled: make(chan struct{}), done: make(chan struct{})}
	h := Handler(pool, config.Config{InternalToken: testToken})
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(s.done)
		returned := make(chan struct{})
		defer close(returned)
		go func() {
			select {
			case <-r.Context().Done():
				close(s.cancelled)
			case <-returned:
			}
		}()
		h.ServeHTTP(w, r)
	}))
	t.Cleanup(s.Close)
	return s
}

// postAndHangUp sends the request and returns a function that makes the
// client give up on it, as apps/api does after
// SETTLEMENT_INTERNAL_REQUEST_TIMEOUT_MS. The function waits until the
// server has seen the disconnect.
func (s *observedServer) postAndHangUp(t *testing.T, path, body string) (hangUp func()) {
	t.Helper()
	clientCtx, giveUp := context.WithCancel(context.Background())
	t.Cleanup(giveUp)
	sent := make(chan error, 1)
	go func() {
		req, err := http.NewRequestWithContext(clientCtx, http.MethodPost, s.URL+path, strings.NewReader(body))
		if err != nil {
			sent <- err
			return
		}
		req.Header.Set("Authorization", "Bearer "+testToken)
		resp, err := s.Client().Do(req)
		if err == nil {
			resp.Body.Close()
		}
		sent <- err
	}()
	return func() {
		giveUp()
		if err := <-sent; err == nil {
			t.Fatal("the request completed before the client gave up; the test needs it still running")
		}
		select {
		case <-s.cancelled:
		case <-time.After(5 * time.Second):
			t.Fatal("the server never saw the client disconnect")
		}
		// Let a cancelled query notice before its lock is released.
		time.Sleep(300 * time.Millisecond)
	}
}

func (s *observedServer) waitHandlerReturned(t *testing.T) {
	t.Helper()
	select {
	case <-s.done:
	case <-time.After(10 * time.Second):
		t.Fatal("handler did not return within 10s of the lock being released")
	}
}

// Regression: run-batch ran under r.Context(). apps/api gives up after
// SETTLEMENT_INTERNAL_REQUEST_TIMEOUT_MS (30 s) and closes the connection,
// which cancelled the run partway: the batch it was working on stayed
// closed but unpaid, and later merchants were never reached. A run that has
// started must finish.
func TestRunBatch_ClientHangUpDoesNotStopTheRun(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()

	merchantID := insertActiveMerchant(t, pool)
	yesterday := bahrainToday().AddDate(0, 0, -1)
	start, _ := settlement.BusinessDayWindow(yesterday)
	insertCaptureEvent(t, pool, merchantID, 10000, start.Add(time.Hour))

	// Hold the merchant row so the payout step, which updates it, waits
	// after CloseBatch has committed (as in serve_drain_test.go).
	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin blocker: %v", err)
	}
	defer blocker.Rollback(ctx) //nolint:errcheck
	if _, err := blocker.Exec(ctx, `SELECT 1 FROM merchants WHERE id = $1 FOR NO KEY UPDATE`, merchantID); err != nil {
		t.Fatalf("lock merchant: %v", err)
	}

	server := newObservedServer(t, pool)
	hangUp := server.postAndHangUp(t, "/internal/run-batch",
		`{"date":"`+yesterday.Format(businessDateLayout)+`","merchantId":"`+merchantID.String()+`"}`)

	batchStatus := func() string {
		var status string
		if err := pool.QueryRow(ctx, `SELECT status FROM settlement_batches WHERE merchant_id = $1`, merchantID).Scan(&status); err != nil {
			return "none"
		}
		return status
	}
	waitUntil(t, "the batch is closed", func() bool { return batchStatus() == "closed" })

	hangUp()
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatalf("release lock: %v", err)
	}
	server.waitHandlerReturned(t)

	if got := batchStatus(); got != "paid" {
		t.Errorf("batch status after the caller hung up = %q, want paid (closed means the run stopped before the payout)", got)
	}
}

// Same for recalculate-mdr: one transaction, so a hang-up rolled the whole
// recalculation back although the admin was never told it had not happened.
func TestRecalculateMDR_ClientHangUpDoesNotStopTheRun(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()

	merchantID := insertActiveMerchant(t, pool)
	day := bahrainToday().AddDate(0, 0, -2)
	start, _ := settlement.BusinessDayWindow(day)
	insertCaptureEvent(t, pool, merchantID, 100_000, start.Add(time.Hour))
	closed, err := settlement.CloseBatch(ctx, pool, merchantID, day)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 300 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("change rate: %v", err)
	}

	// Hold the batch row so the recalculation waits on its FOR UPDATE.
	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin blocker: %v", err)
	}
	defer blocker.Rollback(ctx) //nolint:errcheck
	if _, err := blocker.Exec(ctx, `SELECT 1 FROM settlement_batches WHERE id = $1 FOR UPDATE`, closed.BatchID); err != nil {
		t.Fatalf("lock batch: %v", err)
	}

	server := newObservedServer(t, pool)
	hangUp := server.postAndHangUp(t, "/internal/recalculate-mdr",
		`{"merchantId":"`+merchantID.String()+`","from":"`+day.Format(businessDateLayout)+`","to":"`+day.AddDate(0, 0, 1).Format(businessDateLayout)+`"}`)
	waitUntil(t, "the recalculation waits on the batch row", func() bool {
		var waiting int
		_ = pool.QueryRow(ctx, `
			SELECT count(*) FROM pg_stat_activity
			 WHERE datname = current_database() AND wait_event_type = 'Lock'
			   AND query LIKE '%FROM settlement_batches%FOR UPDATE%'
		`).Scan(&waiting)
		return waiting > 0
	})

	hangUp()
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatalf("release lock: %v", err)
	}
	server.waitHandlerReturned(t)

	var fee int64
	if err := pool.QueryRow(ctx, `SELECT fee_fils FROM settlement_batches WHERE id = $1`, closed.BatchID).Scan(&fee); err != nil {
		t.Fatalf("read batch fee: %v", err)
	}
	if fee == int64(closed.FeeFils) {
		t.Errorf("batch fee = %d fils, unchanged after the caller hung up; want the 300 bps fee", fee)
	}
	var adjustments int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM ledger_entries WHERE settlement_batch_id = $1 AND description = 'MDR recalculation adjustment'
	`, closed.BatchID).Scan(&adjustments); err != nil {
		t.Fatalf("count adjustment legs: %v", err)
	}
	if adjustments == 0 {
		t.Errorf("no MDR adjustment legs for batch %s; want the recalculation committed", closed.BatchID)
	}
}
