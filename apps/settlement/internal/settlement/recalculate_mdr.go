package settlement

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/balances"
	"github.com/filspay/settlement/internal/money"
)

// ErrBatchEventsIncomplete is returned by RecalculateMDR, with nothing
// committed, when a batch's linked capture events do not add up to the
// gross it froze, so its fee cannot be re-derived event by event.
var ErrBatchEventsIncomplete = errors.New("settlement: RecalculateMDR: batch's linked events do not add up to its gross")

// BatchAdjustment is one batch's before/after fee, as changed by a
// recalculation pass.
//
// DiffFils is NewFeeFils - OldFeeFils. A positive diff means the merchant was
// undercharged at close. The batch's fee/net are rewritten and the
// correcting ledger group is posted against that batch, dated in its own
// business day (only 'closed' batches are recalculated, never 'paid').
type BatchAdjustment struct {
	BatchID    uuid.UUID
	BatchDate  time.Time
	Status     string
	OldFeeFils money.Fils
	NewFeeFils money.Fils
	DiffFils   money.Fils
}

// RecalcResult summarizes one RecalculateMDR pass.
type RecalcResult struct {
	BatchesConsidered int
	Adjusted          []BatchAdjustment
}

// batchRow is one settlement_batches row as read by the recalculation scan.
type batchRow struct {
	id            uuid.UUID
	batchDate     time.Time
	status        string
	grossFils     money.Fils
	feeFils       money.Fils
	netPayoutFils money.Fils
}

// RecalculateMDR re-derives the fee on a merchant's closed batches in
// [from, to) at the merchant's current terms and posts the difference.
// "Current terms" are resolved the way CloseBatch resolves them: each
// event's rate is the fee_schedules row in force at that event's time
// (merchants.mdr_bps when none is), less the platform volume-tier bonus,
// with the merchant's negotiated discount — so a run with no rate change
// adjusts nothing.
func RecalculateMDR(ctx context.Context, db *pgxpool.Pool, merchantID uuid.UUID, from, to time.Time) (RecalcResult, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var mdrBps, discountBps int64
	err = tx.QueryRow(ctx, `SELECT mdr_bps, negotiated_discount_bps FROM merchants WHERE id = $1`, merchantID).
		Scan(&mdrBps, &discountBps)
	if err != nil {
		return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: load merchant: %w", err)
	}

	rows, err := tx.Query(ctx, `
		SELECT id, batch_date, status, gross_fils, fee_fils, net_payout_fils
		  FROM settlement_batches
		 WHERE merchant_id = $1 AND batch_date >= $2 AND batch_date < $3
		   AND status = 'closed' -- never 'paid': a paid batch's fee/net were disbursed and must not change (was status <> 'open', which rewrote paid batches)
		 ORDER BY batch_date
		 FOR UPDATE
	`, merchantID, from, to)
	if err != nil {
		return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: select batches: %w", err)
	}
	var batches []batchRow
	for rows.Next() {
		var b batchRow
		var gross, fee, net int64
		if err := rows.Scan(&b.id, &b.batchDate, &b.status, &gross, &fee, &net); err != nil {
			rows.Close()
			return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: scan batch: %w", err)
		}
		b.grossFils = money.Fils(gross)
		b.feeFils = money.Fils(fee)
		b.netPayoutFils = money.Fils(net)
		batches = append(batches, b)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: iterate batches: %w", err)
	}
	rows.Close()

	// Resolve the rate exactly as CloseBatch does: the fee_schedules row in
	// force at each event's time (merchants.mdr_bps only as the fallback),
	// less the platform volume-tier bonus. Reading merchants.mdr_bps alone
	// re-rated every scheduled or tier-discounted batch on a run with no
	// rate change at all.
	schedules, err := LoadFeeSchedules(ctx, tx, merchantID)
	if err != nil {
		return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: load fee schedules: %w", err)
	}
	platformProcessedFils, err := ReadAndLockPlatformProcessedFils(ctx, tx)
	if err != nil {
		return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: read platform volume: %w", err)
	}
	tierBonusBps := VolumeTierMdrBonusBps(platformProcessedFils)

	var adjusted []BatchAdjustment
	for _, b := range batches {
		newFee, eventGross, err := recomputeBatchFee(ctx, tx, b.id, schedules, mdrBps, tierBonusBps, discountBps)
		if err != nil {
			return RecalcResult{}, err
		}
		// CloseBatch freezes gross as the sum of the events it links, so the
		// two always agree for a batch it closed. A batch whose linked events
		// fall short of its gross (one written directly, like the seed's
		// fixture batches) cannot be re-rated per event: the missing activity
		// would be priced at zero and the merchant refunded fees they owe.
		if eventGross != b.grossFils {
			return RecalcResult{}, fmt.Errorf("%w: batch %s (%s) gross %d fils, linked events %d fils",
				ErrBatchEventsIncomplete, b.id, b.batchDate.Format("2006-01-02"), b.grossFils, eventGross)
		}
		diff := newFee - b.feeFils
		if diff == 0 {
			continue
		}
		// Only the fee changed, so the net moves by exactly the fee difference.
		// Rebuilding it as gross - new fee dropped the refund deduction and
		// any carried-in shortfall CloseBatch nets into the payout, paying
		// refunded money out a second time.
		newNetPayout := b.netPayoutFils - diff
		// am: posts against the OLD batch id so it never lands in a new payout?? fixed in FP-244 i think
		// The correction is dated in the period it corrects: Asia/Bahrain
		// midnight of the batch's business day, the anchor admin credits use.
		periodStart, _ := BusinessDayWindow(b.batchDate)
		if err := postMdrAdjustment(ctx, tx, merchantID, b.id, diff, periodStart); err != nil {
			return RecalcResult{}, err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE settlement_batches SET fee_fils = $2, net_payout_fils = $3 WHERE id = $1
		`, b.id, int64(newFee), int64(newNetPayout)); err != nil {
			return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: update batch %s: %w", b.id, err)
		}
		// Re-announce the batch's corrected figures on the outbox in the same
		// transaction (ARCHITECTURE "Events"). Reporting is fed only from the
		// outbox and upserts merchant_payout_trends per batch from this
		// payload, so without it the trends (and any rebuild) kept the old
		// fee/net. Webhooks do not deliver settlement.batch_closed.
		payload, err := buildBatchClosedPayload(merchantID, b.id, b.batchDate, b.grossFils, newFee, newNetPayout)
		if err != nil {
			return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: build outbox payload for %s: %w", b.id, err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
			VALUES ('settlement.batch_closed', 'settlement_batch', $1, $2)
		`, b.id, payload); err != nil {
			return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: enqueue outbox event for %s: %w", b.id, err)
		}
		// A fee increase (diff > 0) reduces net payout owed, so the cache
		// moves by -diff, the same amount postMdrAdjustment just moved
		// merchant_payable by.
		if err := balances.ApplyLedgerDelta(ctx, tx, merchantID, -diff); err != nil {
			return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: apply cache delta for %s: %w", b.id, err)
		}
		adjusted = append(adjusted, BatchAdjustment{
			BatchID:    b.id,
			BatchDate:  b.batchDate,
			Status:     b.status,
			OldFeeFils: b.feeFils,
			NewFeeFils: newFee,
			DiffFils:   diff,
		})
	}

	if err := tx.Commit(ctx); err != nil {
		return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: commit: %w", err)
	}
	return RecalcResult{BatchesConsidered: len(batches), Adjusted: adjusted}, nil
}

// recomputeBatchFee sums ComputeSettlementFee over every transaction_events
// row carrying this batch's id — the same per-event-then-sum discipline
// CloseBatch step 8 uses, never ApplyRateFils applied once to a pre-summed
// total, so this recomputation can never itself diverge from what a fresh
// CloseBatch would have produced at today's rate.
// It also returns the events' gross, so the caller can check it against the
// batch's frozen gross_fils.
func recomputeBatchFee(ctx context.Context, tx pgx.Tx, batchID uuid.UUID, schedules []FeeScheduleRow, fallbackMdrBps, tierBonusBps, discountBps int64) (fee, gross money.Fils, err error) {
	rows, err := tx.Query(ctx, `
		SELECT amount_fils, occurred_at FROM transaction_events WHERE settlement_batch_id = $1 ORDER BY id
	`, batchID)
	if err != nil {
		return 0, 0, fmt.Errorf("settlement: RecalculateMDR: select batch events for %s: %w", batchID, err)
	}
	defer rows.Close()

	for rows.Next() {
		var amountFils int64
		var occurredAt time.Time
		if err := rows.Scan(&amountFils, &occurredAt); err != nil {
			return 0, 0, fmt.Errorf("settlement: RecalculateMDR: scan batch event for %s: %w", batchID, err)
		}
		gross += money.Fils(amountFils)
		// FH: sums every event with this batch id -- incl. refund events once FP-212 lands? need an event_type filter?
		// MK: refunds won't carry settlement_batch_id on transaction_events, they live in their own table. non-issue
		// Same per-event rate as CloseBatch step 8.
		effectiveMdrBps := EffectiveMdrBpsAt(schedules, occurredAt, fallbackMdrBps)
		if effectiveMdrBps -= tierBonusBps; effectiveMdrBps < 0 {
			effectiveMdrBps = 0
		}
		fee += ComputeSettlementFee(money.Fils(amountFils), effectiveMdrBps, discountBps)
	}
	if err := rows.Err(); err != nil {
		return 0, 0, fmt.Errorf("settlement: RecalculateMDR: iterate batch events for %s: %w", batchID, err)
	}
	return fee, gross, nil
}

// postMdrAdjustment posts the two-leg, entry_group_id-balanced pair for one
// batch's fee difference. A fee increase moves money from the merchant to
// platform fee revenue; a decrease reverses both legs. ledger_entries has a
// CHECK (amount_fils > 0), so the magnitude is always posted positive and
// the sign is carried by which account is debited.
//
// Both legs are dated effectiveAt, inside the batch's own business day:
// ARCHITECTURE "The ledger" says corrections are posted with the effective
// date of the period they correct. They used to be dated now(), so the
// batch's period no longer tied to its rewritten fee_fils and the
// difference surfaced, unexplained, in whatever period finance ran this.
func postMdrAdjustment(ctx context.Context, tx pgx.Tx, merchantID, batchID uuid.UUID, diff money.Fils, effectiveAt time.Time) error {
	if diff == 0 {
		return nil
	}
	magnitude := diff
	if magnitude < 0 {
		magnitude = -magnitude
	}

	// YA 2026-01-20: a fee decrease still debits merchant_payable here, same as an increase, the sign is in the amount
	debitAccount, creditAccount := "merchant_payable", "platform_fee_revenue"
	if diff < 0 {
		debitAccount, creditAccount = "platform_fee_revenue", "merchant_payable"
	}

	_, err := tx.Exec(ctx, `
		INSERT INTO ledger_entries
		  (entry_group_id, merchant_id, settlement_batch_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES
		  ($1, $2, $3, $4, 'debit',  $6, $7, 'MDR recalculation adjustment'),
		  ($1, $2, $3, $5, 'credit', $6, $7, 'MDR recalculation adjustment')
	`, uuid.New(), merchantID, batchID, debitAccount, creditAccount, int64(magnitude), effectiveAt)
	if err != nil {
		return fmt.Errorf("settlement: RecalculateMDR: post adjustment for batch %s: %w", batchID, err)
	}
	return nil
}
