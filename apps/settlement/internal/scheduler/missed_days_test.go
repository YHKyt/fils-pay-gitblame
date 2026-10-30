package scheduler

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/settlement"
)

// insertCapture writes the transactions + transaction_events + ledger rows a
// real capture produces, so a batch run has something to settle.
func insertCapture(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, amountFils int64, occurredAt time.Time) {
	t.Helper()
	ctx := context.Background()
	var txnID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
		VALUES ($1, 'captured', $2, $2, $3, $4)
		RETURNING id
	`, merchantID, amountFils, "acq-ref-"+uuid.New().String(), occurredAt).Scan(&txnID); err != nil {
		t.Fatalf("insert transaction: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at)
		VALUES ($1, 'captured', $2, 'system', $3)
	`, txnID, amountFils, occurredAt); err != nil {
		t.Fatalf("insert transaction_events: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO ledger_entries
		  (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES
		  ($1, $2, $3, 'card_scheme_clearing', 'debit',  $4, $5, 'capture: gross'),
		  ($1, $2, $3, 'merchant_payable',     'credit', $4, $5, 'capture: gross')
	`, uuid.New(), merchantID, txnID, amountFils, occurredAt); err != nil {
		t.Fatalf("insert capture ledger legs: %v", err)
	}
}

type dayState struct {
	batches         int
	status          string
	payoutFils      int64
	paidEvents      int
	unbatchedEvents int
}

func readDay(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, day time.Time) dayState {
	t.Helper()
	ctx := context.Background()
	date := day.Format("2006-01-02")
	var s dayState
	if err := pool.QueryRow(ctx, `
		SELECT count(*), COALESCE(max(status), 'none') FROM settlement_batches WHERE merchant_id = $1 AND batch_date = $2::date
	`, merchantID, date).Scan(&s.batches, &s.status); err != nil {
		t.Fatalf("read batches: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(le.amount_fils), 0)
		  FROM ledger_entries le JOIN settlement_batches sb ON sb.id = le.settlement_batch_id
		 WHERE sb.merchant_id = $1 AND sb.batch_date = $2::date
		   AND le.account_id = 'merchant_payable' AND le.direction = 'debit'
		   AND le.description = 'settlement payout: batch paid'
	`, merchantID, date).Scan(&s.payoutFils); err != nil {
		t.Fatalf("read payout legs: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM outbox_events oe JOIN settlement_batches sb ON sb.id = oe.aggregate_id
		 WHERE sb.merchant_id = $1 AND sb.batch_date = $2::date AND oe.event_type = 'settlement.paid'
	`, merchantID, date).Scan(&s.paidEvents); err != nil {
		t.Fatalf("read settlement.paid events: %v", err)
	}
	start, end := settlement.BusinessDayWindow(day)
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM transaction_events te JOIN transactions t ON t.id = te.transaction_id
		 WHERE t.merchant_id = $1 AND te.settlement_batch_id IS NULL
		   AND te.occurred_at >= $2 AND te.occurred_at < $3
	`, merchantID, start, end).Scan(&s.unbatchedEvents); err != nil {
		t.Fatalf("read unbatched events: %v", err)
	}
	return s
}

// Regression: a merchant not eligible at the nightly run (suspended) gets no
// batch for that day, and the daemon only ever ran yesterday. After the
// merchant was reactivated, the captures of the days it missed were never
// closed or paid unless someone ran `run-batch --date` for each of them.
// The daemon now closes such days (up to 31 days back) once the merchant is
// eligible again, exactly once.
func TestRunIfDue_ClosesDaysMissedWhileSuspended(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()

	var merchantID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
		VALUES ($1, 250, 'suspended', false) RETURNING id
	`, "scheduler-missed-day-test-"+uuid.New().String()).Scan(&merchantID); err != nil {
		t.Fatalf("insert merchant: %v", err)
	}

	todayStart, _ := settlement.BusinessDayWindow(time.Now().In(settlement.BusinessLocation()))
	missedDay := todayStart.AddDate(0, 0, -3)
	tooOld := todayStart.AddDate(0, 0, -40) // beyond the 31-day lookback
	missedStart, _ := settlement.BusinessDayWindow(missedDay)
	tooOldStart, _ := settlement.BusinessDayWindow(tooOld)
	insertCapture(t, pool, merchantID, 100_000, missedStart.Add(10*time.Hour))
	insertCapture(t, pool, merchantID, 50_000, tooOldStart.Add(10*time.Hour))

	// While suspended, nothing is closed for the merchant.
	runIfDue(ctx, pool, 0)
	if s := readDay(t, pool, merchantID, missedDay); s.batches != 0 || s.unbatchedEvents != 1 {
		t.Fatalf("while suspended: %+v, want no batch and the capture unbatched", s)
	}

	if _, err := pool.Exec(ctx, `UPDATE merchants SET status = 'active' WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("reactivate merchant: %v", err)
	}

	// Two runs after reactivation: the missed day is closed and paid once.
	for run := 1; run <= 2; run++ {
		runIfDue(ctx, pool, 0)
		s := readDay(t, pool, merchantID, missedDay)
		want := dayState{batches: 1, status: "paid", payoutFils: 97_500, paidEvents: 1, unbatchedEvents: 0}
		if s != want {
			t.Errorf("run %d after reactivation, %s: %+v, want %+v", run, missedDay.Format("2006-01-02"), s, want)
		}
	}

	// A day beyond the lookback is left to `run-batch --date`.
	if s := readDay(t, pool, merchantID, tooOld); s.batches != 0 || s.unbatchedEvents != 1 {
		t.Errorf("%s (beyond the lookback): %+v, want no batch and the capture unbatched", tooOld.Format("2006-01-02"), s)
	}
}
