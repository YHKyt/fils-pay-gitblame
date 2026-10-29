package main

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestMain lets a test run the real CLI: runCLI re-executes this test binary
// with SETTLEMENT_CLI_ARGS set, and it then behaves as `settlement <args>`.
func TestMain(m *testing.M) {
	if args, ok := os.LookupEnv("SETTLEMENT_CLI_ARGS"); ok {
		os.Args = append([]string{"settlement"}, strings.Fields(args)...)
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func runCLI(t *testing.T, args string) string {
	t.Helper()
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), "SETTLEMENT_CLI_ARGS="+args)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("settlement %s: %v\n%s", args, err, out)
	}
	return string(out)
}

// RUNBOOK.md tells ops to run `settlement rebuild-balances --merchant=<uuid>`
// when one merchant's balance looks wrong. That path only read the ledger: it
// printed "rebuilt=5000" and left the cache at 123.
func TestRebuildBalancesMerchantFlag_WritesTheCache(t *testing.T) {
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
		VALUES ($1, 250, 'active', false)
		RETURNING id
	`, "cli-rebuild-"+uuid.New().String()).Scan(&merchantID); err != nil {
		t.Fatalf("insert merchant: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES
		  ($1, $2, 'merchant_payable',     'credit', 5000, now(), 'test leg'),
		  ($1, $2, 'card_scheme_clearing', 'debit',  5000, now(), 'test leg (other side)')
	`, uuid.New(), merchantID); err != nil {
		t.Fatalf("insert ledger legs: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils) VALUES ($1, 123)
	`, merchantID); err != nil {
		t.Fatalf("seed drifted cache: %v", err)
	}

	out := runCLI(t, "rebuild-balances --merchant="+merchantID.String())

	var cached int64
	if err := pool.QueryRow(ctx, `
		SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1
	`, merchantID).Scan(&cached); err != nil {
		t.Fatalf("read merchant_balances: %v", err)
	}
	if cached != 5000 {
		t.Fatalf("cached_payable_fils after rebuild-balances --merchant = %d, want 5000 (the ledger)\nCLI output: %s", cached, out)
	}
	if want := "before=123 after=5000 (CHANGED)"; !strings.Contains(out, want) {
		t.Errorf("CLI output %q does not report %q", out, want)
	}
}
