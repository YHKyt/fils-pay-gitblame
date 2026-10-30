package settlement

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// EnqueuePayoutNotifications scans for settlement_batches that have reached
// 'paid' and have no settlement.paid outbox event yet, and enqueues one per
// batch, whatever its net payout. The event is how the reporting read model
// learns a batch was paid (applySettlementPaid), so a zero or negative net
// batch needs it too, or its payout trend stays 'closed' forever. Merchants
// still get no "payout" webhook for such a batch: the webhook dispatcher
// creates no delivery for a settlement.paid with netPayoutFils <= 0. Deliberately outside CloseBatch/
// PayoutBatch's own transactions: this scan also has to see batches paid
// out through the sub-merchant split path (internal/splits.PayoutSplitBatch),
// a second, independent function that reaches 'paid' its own way — reading
// settlement_batches.status here, rather than hooking both payout functions
// individually, is the one place this logic needs to exist regardless of
// which of the two paid the batch.
//
// Idempotent by construction: the NOT EXISTS guard means re-running this
// scan — on every daemon tick, or a second time after a crash before this
// function's own commit landed — never enqueues a second outbox event for
// the same batch.
// There is NO unique index on outbox_events (event_type, aggregate_id): the
// scan's NOT EXISTS alone let the daemon and `run-batch` (or two daemons)
// both enqueue settlement.paid for one batch = duplicate payout webhooks.
// Each insert re-checks under a per-batch advisory lock, in one transaction.
func EnqueuePayoutNotifications(ctx context.Context, db *pgxpool.Pool) (int, error) {
	// Pages of payoutNotifyPageSize, drained in one call. Every idle merchant
	// gets a zero-net paid batch each day, so one page per call (the old
	// "LIMIT 500, the next tick picks up the rest") would let a day's empty
	// batches push real payout notifications back by a tick or more. Every
	// row a page returns ends up with an event (inserted here or by a
	// concurrent scanner), so the NOT EXISTS shrinks the set and the loop ends.
	count := 0
	for {
		batches, err := selectUnnotifiedPaidBatches(ctx, db)
		if err != nil {
			return count, err
		}
		for _, b := range batches {
			// merchantId at the top level is required, not decorative: the webhook
			// dispatcher's delivery-creation step joins webhook_endpoints on
			// (outbox_events.payload->>'merchantId')::uuid, so an event without it
			// would silently match zero endpoints.
			payload, err := json.Marshal(map[string]any{
				"merchantId":    b.merchantID,
				"batchId":       b.id,
				"batchDate":     b.batchDate,
				"netPayoutFils": b.netPayoutFils,
			})
			if err != nil {
				return count, fmt.Errorf("settlement: EnqueuePayoutNotifications: marshal payload: %w", err)
			}
			inserted, err := enqueuePaidOnce(ctx, db, b.id, payload)
			if err != nil {
				return count, fmt.Errorf("settlement: EnqueuePayoutNotifications: insert batch %s: %w", b.id, err)
			}
			if inserted {
				count++
			}
		}
		if len(batches) < payoutNotifyPageSize {
			return count, nil
		}
	}
}

const payoutNotifyPageSize = 500

type paidBatch struct {
	id            uuid.UUID
	merchantID    uuid.UUID
	batchDate     string
	netPayoutFils int64
}

// selectUnnotifiedPaidBatches returns up to payoutNotifyPageSize paid batches
// with no settlement.paid event yet, ordered by paid_at so notifications go
// out in payout order.
func selectUnnotifiedPaidBatches(ctx context.Context, db *pgxpool.Pool) ([]paidBatch, error) {
	rows, err := db.Query(ctx, `
		SELECT sb.id, sb.merchant_id, sb.batch_date, sb.net_payout_fils
		  FROM settlement_batches sb
		 WHERE sb.status = 'paid'
		   AND NOT EXISTS (
		     SELECT 1 FROM outbox_events oe
		      WHERE oe.event_type = 'settlement.paid' AND oe.aggregate_id = sb.id
		   )
		 ORDER BY sb.paid_at ASC, sb.id ASC
		 LIMIT $1
	`, payoutNotifyPageSize)
	if err != nil {
		return nil, fmt.Errorf("settlement: EnqueuePayoutNotifications: select: %w", err)
	}
	defer rows.Close()

	var batches []paidBatch
	for rows.Next() {
		var b paidBatch
		var batchDate time.Time
		if err := rows.Scan(&b.id, &b.merchantID, &batchDate, &b.netPayoutFils); err != nil {
			return nil, fmt.Errorf("settlement: EnqueuePayoutNotifications: scan: %w", err)
		}
		b.batchDate = batchDate.Format("2006-01-02")
		batches = append(batches, b)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("settlement: EnqueuePayoutNotifications: iterate: %w", err)
	}
	return batches, nil
}

// enqueuePaidOnce inserts the settlement.paid event for one batch unless one
// already exists. The advisory lock serializes concurrent enqueuers for the
// same batch, so the NOT EXISTS re-check cannot race.
func enqueuePaidOnce(ctx context.Context, db *pgxpool.Pool, batchID uuid.UUID, payload []byte) (bool, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after Commit

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('settlement.paid:' || $1::text))`, batchID); err != nil {
		return false, err
	}
	tag, err := tx.Exec(ctx, `
		INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
		SELECT 'settlement.paid', 'settlement_batch', $1, $2
		 WHERE NOT EXISTS (
		   SELECT 1 FROM outbox_events WHERE event_type = 'settlement.paid' AND aggregate_id = $1
		 )
	`, batchID, payload)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}
