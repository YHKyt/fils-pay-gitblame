package internalapi

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/filspay/settlement/internal/config"
	"github.com/filspay/settlement/internal/settlement"
)

// Regression: every request context derived from the daemon's ctx, so a
// SIGTERM cancelled an in-flight run-batch at once, despite the 30 s
// graceful shutdown. A run stopped between CloseBatch and PayoutBatch left
// the batch closed but unpaid. The request must be allowed to finish.
func TestServe_ShutdownLetsInFlightRunBatchFinish(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()

	merchantID := insertActiveMerchant(t, pool)
	yesterday := bahrainToday().AddDate(0, 0, -1)
	start, _ := settlement.BusinessDayWindow(yesterday)
	insertCaptureEvent(t, pool, merchantID, 10000, start.Add(time.Hour))

	// Hold the merchant row so the payout step, which updates it, waits
	// after CloseBatch has committed. FOR NO KEY UPDATE still lets the
	// batch's foreign-key checks through.
	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin blocker: %v", err)
	}
	defer blocker.Rollback(ctx) //nolint:errcheck
	if _, err := blocker.Exec(ctx, `SELECT 1 FROM merchants WHERE id = $1 FOR NO KEY UPDATE`, merchantID); err != nil {
		t.Fatalf("lock merchant: %v", err)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("pick a port: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()

	daemonCtx, sigterm := context.WithCancel(ctx)
	defer sigterm()
	served := make(chan error, 1)
	go func() {
		served <- Serve(daemonCtx, pool, config.Config{InternalPort: port, InternalToken: testToken})
	}()
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	waitUntil(t, "the server listens", func() bool {
		conn, err := net.Dial("tcp", addr)
		if err == nil {
			conn.Close()
		}
		return err == nil
	})

	type result struct {
		status int
		err    error
	}
	done := make(chan result, 1)
	go func() {
		body := `{"date":"` + yesterday.Format(businessDateLayout) + `","merchantId":"` + merchantID.String() + `"}`
		req, _ := http.NewRequest(http.MethodPost, "http://"+addr+"/internal/run-batch", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+testToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			done <- result{err: err}
			return
		}
		resp.Body.Close()
		done <- result{status: resp.StatusCode}
	}()

	batchStatus := func() string {
		var status string
		if err := pool.QueryRow(ctx, `SELECT status FROM settlement_batches WHERE merchant_id = $1`, merchantID).Scan(&status); err != nil {
			return "none"
		}
		return status
	}
	waitUntil(t, "the batch is closed", func() bool { return batchStatus() == "closed" })

	sigterm()
	time.Sleep(300 * time.Millisecond)
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatalf("release lock: %v", err)
	}

	select {
	case r := <-done:
		if r.err != nil || r.status != http.StatusOK {
			t.Errorf("in-flight run-batch: status=%d err=%v, want 200", r.status, r.err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("in-flight run-batch did not finish within 10s of the shutdown signal")
	}
	if got := batchStatus(); got != "paid" {
		t.Errorf("batch status after shutdown = %q, want paid (closed means it was stopped before payout)", got)
	}
	select {
	case err := <-served:
		if err != nil {
			t.Errorf("Serve returned %v, want nil", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Serve did not return after the in-flight request finished")
	}
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting until %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
