package settlement

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// MissedBusinessDay is one merchant's ended business day that the nightly
// run never closed.
type MissedBusinessDay struct {
	MerchantID   uuid.UUID
	BusinessDate time.Time
}

// FindMissedBusinessDays returns, oldest first, every business date in
// [from, to) on which a merchant that is now eligible (active, not in test
// mode) has live capture events that no batch has claimed, and for which
// the merchant has no closed or paid batch.
//
// That is a day the nightly run skipped because the merchant was suspended
// (or the daemon was down): CloseBatch only ever selects one day's window,
// so nothing else would pick those captures up. A day that already has a
// closed or paid batch is left out: CloseBatch would be a no-op for it.
//
// It also returns every day in [from, to) on which such a merchant has a
// batch that is 'closed' but not 'paid', so the run pays it out.
func FindMissedBusinessDays(ctx context.Context, db *pgxpool.Pool, from, to time.Time) ([]MissedBusinessDay, error) {
	start, _ := BusinessDayWindow(from)
	end, _ := BusinessDayWindow(to)
	rows, err := db.Query(ctx, `
		SELECT DISTINCT t.merchant_id, (te.occurred_at AT TIME ZONE $3)::date AS business_date
		  FROM transaction_events te
		  JOIN transactions t ON t.id = te.transaction_id
		  JOIN merchants m ON m.id = t.merchant_id
		 WHERE te.settlement_batch_id IS NULL
		   AND te.event_type IN ('captured', 'partially_captured')
		   AND te.occurred_at >= $1 AND te.occurred_at < $2
		   AND NOT t.test_mode
		   AND m.status = 'active' AND m.test_mode = false
		   AND NOT EXISTS (
		     SELECT 1 FROM settlement_batches sb
		      WHERE sb.merchant_id = t.merchant_id
		        AND sb.batch_date = (te.occurred_at AT TIME ZONE $3)::date
		        AND sb.status <> 'open'
		   )
		UNION
		-- A batch that closed but was never paid (the run stopped between
		-- CloseBatch and PayoutBatch and the day then passed): RunDailyBatch
		-- pays an already-closed batch, but only yesterday is ever re-run.
		SELECT sb.merchant_id, sb.batch_date
		  FROM settlement_batches sb
		  JOIN merchants m ON m.id = sb.merchant_id
		 WHERE sb.status = 'closed'
		   AND sb.batch_date >= ($1 AT TIME ZONE $3)::date
		   AND sb.batch_date <  ($2 AT TIME ZONE $3)::date
		   AND m.status = 'active' AND m.test_mode = false
		 ORDER BY business_date, merchant_id
	`, start, end, businessDayLocation.String())
	if err != nil {
		return nil, fmt.Errorf("settlement: FindMissedBusinessDays: %w", err)
	}
	defer rows.Close()

	var missed []MissedBusinessDay
	for rows.Next() {
		var m MissedBusinessDay
		if err := rows.Scan(&m.MerchantID, &m.BusinessDate); err != nil {
			return nil, fmt.Errorf("settlement: FindMissedBusinessDays: scan: %w", err)
		}
		missed = append(missed, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("settlement: FindMissedBusinessDays: iterate: %w", err)
	}
	return missed, nil
}
