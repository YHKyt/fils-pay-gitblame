package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/settlement"
)

const cliHelperEnv = "SETTLEMENT_CLI_TEST_ARGS"

// runCLI runs this binary's main() in a child process (the standard os/exec
// helper-process pattern) with the given settlement arguments, so a
// log.Fatalf exit code can be observed.
func runCLI(t *testing.T, args ...string) (string, int) {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestRunBatchCLI_RefusesBusinessDayThatHasNotEnded$")
	cmd.Env = append(os.Environ(), cliHelperEnv+"="+strings.Join(args, " "))
	out, err := cmd.CombinedOutput()
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return string(out), exitErr.ExitCode()
	}
	if err != nil {
		t.Fatalf("run CLI %v: %v", args, err)
	}
	return string(out), 0
}

// Regression: `settlement run-batch --date=<today>` closed a business day
// that was still running. CloseBatch only selects that day's window and a
// closed batch is never scanned again, so every capture later that day was
// stranded for good. The CLI must exit non-zero and write nothing for today
// or any later date; yesterday still closes and pays.
func TestRunBatchCLI_RefusesBusinessDayThatHasNotEnded(t *testing.T) {
	if args := os.Getenv(cliHelperEnv); args != "" {
		os.Args = append([]string{"settlement"}, strings.Fields(args)...)
		main()
		os.Exit(0)
	}

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

	var merchantID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
		VALUES ($1, 250, 'active', false) RETURNING id
	`, "cli-guard-"+uuid.NewString()).Scan(&merchantID); err != nil {
		t.Fatalf("insert merchant: %v", err)
	}
	y, m, d := time.Now().In(settlement.BusinessLocation()).Date()
	today := time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
	yesterday := today.AddDate(0, 0, -1)
	// One capture yesterday and one already made today.
	for _, day := range []time.Time{yesterday, today} {
		start, _ := settlement.BusinessDayWindow(day)
		var txnID uuid.UUID
		if err := pool.QueryRow(ctx, `
			INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
			VALUES ($1, 'captured', 10000, 10000, $2, $3) RETURNING id
		`, merchantID, "acq-ref-"+uuid.NewString(), start).Scan(&txnID); err != nil {
			t.Fatalf("insert transaction: %v", err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at)
			VALUES ($1, 'captured', 10000, 'system', $2)
		`, txnID, start); err != nil {
			t.Fatalf("insert event: %v", err)
		}
	}

	batchStatus := func(day time.Time) string {
		var status string
		err := pool.QueryRow(ctx, `SELECT status FROM settlement_batches WHERE merchant_id = $1 AND batch_date = $2`,
			merchantID, day).Scan(&status)
		if err != nil {
			return "none"
		}
		return status
	}

	for _, day := range []time.Time{today, today.AddDate(0, 0, 1)} {
		date := day.Format("2006-01-02")
		out, code := runCLI(t, "run-batch", "--date="+date, "--merchant="+merchantID.String())
		if code == 0 {
			t.Errorf("run-batch --date=%s exited 0, want non-zero; output:\n%s", date, out)
		}
		if !strings.Contains(out, "business day has not ended") {
			t.Errorf("run-batch --date=%s output does not explain the refusal:\n%s", date, out)
		}
		if got := batchStatus(day); got != "none" {
			t.Errorf("run-batch --date=%s left a %q batch, want none", date, got)
		}
	}

	out, code := runCLI(t, "run-batch", "--date="+yesterday.Format("2006-01-02"), "--merchant="+merchantID.String())
	if code != 0 {
		t.Fatalf("run-batch for yesterday exited %d, want 0; output:\n%s", code, out)
	}
	if got := batchStatus(yesterday); got != "paid" {
		t.Errorf("yesterday's batch status = %q, want paid", got)
	}
}
