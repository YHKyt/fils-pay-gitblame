package settlement

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/balances"
	"github.com/filspay/settlement/internal/disbursement"
	"github.com/filspay/settlement/internal/money"
	"github.com/filspay/settlement/internal/splits"
)

// ErrMerchantNotEligible is returned by CloseBatch when the merchant is
// not active/non-test-mode at the time of the call — CloseBatch is not
// meant to be invoked directly for such a merchant; the batching pass
// (RunDailyBatch) already filters merchants before ever calling it.
var ErrMerchantNotEligible = errors.New("settlement: merchant not found or not eligible for settlement")

// BatchResult is CloseBatch's return value.
type BatchResult struct {
	BatchID       uuid.UUID
	MerchantID    uuid.UUID
	BatchDate     time.Time
	AlreadyClosed bool // true when this call found an existing 'closed'/'paid' batch and made no changes (idempotent no-op)
	GrossFils     money.Fils
	FeeFils       money.Fils
	NetPayoutFils money.Fils
	// RefundDeductionFils is what this batch's claimed refunds took off the
	// payout (sum of amount - fee reversed). Reported only; already in
	// NetPayoutFils.
	RefundDeductionFils money.Fils
	EventCount          int
	LineCount           int
}

// PayoutResult is PayoutBatch's return value.
type PayoutResult struct {
	BatchID       uuid.UUID
	MerchantID    uuid.UUID
	AlreadyPaid   bool // true when the batch was already 'paid' (idempotent no-op)
	NotClosed     bool // true when the batch is not 'closed' (e.g. still 'open') — also a no-op
	NetPayoutFils money.Fils
}

type eligibleEvent struct {
	id            int64
	transactionID uuid.UUID
	amountFils    money.Fils
	occurredAt    time.Time
	bookedFeeFils *int64 // the fee capture.ts journaled for this event, when the event records it
}

// CloseBatch computes and freezes settlement figures for one merchant's
// one business day. Idempotent: re-running it against an already-closed
// or already-paid batch for the same (merchant, date) is a safe no-op.
// Every capture-type transaction_events row it selects is marked with this
// batch's id inside the same transaction that freezes the batch's totals,
// so a row can never be picked up by two batches. The same holds for the
// refunds it deducts (refunds.settlement_batch_id) and for an earlier
// negative batch whose shortfall it carries in.
//
// net_payout_fils = gross - fee - (refunded - fee reversed) + journaled
// corrections + carried-in shortfall. The scheme export stays one presentment line per captured
// transaction: refunds are not netted into it (see docs/audit/settlebatch.md).
func CloseBatch(ctx context.Context, db *pgxpool.Pool, merchantID uuid.UUID, businessDate time.Time) (BatchResult, error) {
	start, end := BusinessDayWindow(businessDate)
	batchDateOnly := time.Date(businessDate.Year(), businessDate.Month(), businessDate.Day(), 0, 0, 0, 0, time.UTC)

	tx, err := db.Begin(ctx)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Step 2: create the batch row if it doesn't already exist.
	_, err = tx.Exec(ctx, `
		INSERT INTO settlement_batches (merchant_id, batch_date, status)
		VALUES ($1, $2, 'open')
		ON CONFLICT (merchant_id, batch_date) DO NOTHING
	`, merchantID, batchDateOnly)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: insert batch: %w", err)
	}

	// Step 3: row-lock the batch. This is what actually serializes
	// concurrent CloseBatch calls for the same (merchant, date).
	var batchID uuid.UUID
	var status string
	err = tx.QueryRow(ctx, `
		SELECT id, status FROM settlement_batches
		 WHERE merchant_id = $1 AND batch_date = $2
		 FOR UPDATE
	`, merchantID, batchDateOnly).Scan(&batchID, &status)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: lock batch: %w", err)
	}

	// Step 4: merchant must be active and not in test mode. Checked before
	// the already-closed return below: RunDailyBatch pays out whatever batch
	// CloseBatch hands back, so a batch left 'closed' (payout failed or the
	// run died before it) must not be paid once the merchant is suspended.
	var mdrBps, discountBps int64
	err = tx.QueryRow(ctx, `
		SELECT mdr_bps, negotiated_discount_bps FROM merchants WHERE id = $1 AND status = 'active' AND test_mode = false
	`, merchantID).Scan(&mdrBps, &discountBps)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return BatchResult{}, ErrMerchantNotEligible
		}
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: read merchant: %w", err)
	}

	// Step 5: already closed/paid -> idempotent no-op, nothing to undo.
	if status != "open" {
		tx.Rollback(ctx) //nolint:errcheck
		var gross, fee, net, refundDeduction int64
		err = db.QueryRow(ctx, `
			SELECT sb.gross_fils, sb.fee_fils, sb.net_payout_fils,
			       (SELECT COALESCE(SUM(r.amount_fils - r.fee_reversed_fils), 0)
			          FROM refunds r WHERE r.settlement_batch_id = sb.id)
			  FROM settlement_batches sb WHERE sb.id = $1
		`, batchID).Scan(&gross, &fee, &net, &refundDeduction)
		if err != nil {
			return BatchResult{}, fmt.Errorf("settlement: CloseBatch: read already-closed batch: %w", err)
		}
		return BatchResult{
			BatchID:             batchID,
			MerchantID:          merchantID,
			BatchDate:           batchDateOnly,
			AlreadyClosed:       true,
			GrossFils:           money.Fils(gross),
			FeeFils:             money.Fils(fee),
			NetPayoutFils:       money.Fils(net),
			RefundDeductionFils: money.Fils(refundDeduction),
		}, nil
	}

	// Effective-dated fee resolution (apps/settlement/internal/settlement/fee_schedule.go) —
	// loaded once per batch; EffectiveMdrBpsAt is applied per event below so
	// a batch that happens to span a schedule's cutover still charges each
	// event the rate that was actually in effect when it happened, matching
	// apps/api/src/payments/capture.ts's own per-event resolution exactly.
	schedules, err := LoadFeeSchedules(ctx, tx, merchantID)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: load fee schedules: %w", err)
	}

	// Platform-wide volume-tier bonus — read and locked once per batch.
	platformProcessedFils, err := ReadAndLockPlatformProcessedFils(ctx, tx)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: read platform volume: %w", err)
	}
	tierBonusBps := VolumeTierMdrBonusBps(platformProcessedFils)

	// Step 6: select and lock eligible events for the whole window. The
	// join is transaction_events (many) -> transactions (one) — the safe
	// direction. Every amount is read from te.amount_fils — the exact
	// incremental delta capture.ts already recorded for that one real
	// event — never from transactions.captured_fils (a running total).
	// A transaction made while the merchant was in test mode never settles,
	// even when the merchant has gone live since (migration 0091).
	// booked_fee_fils is the fee capture.ts journaled for the event: since the
	// discount moved into captureTransaction, the event's metadata carries
	// feeFils (the same value as its 'capture: MDR fee' legs, discount
	// included) together with discountBps. Older events recorded a
	// pre-discount fee with a separate adjustment, so they get NULL here.
	rows, err := tx.Query(ctx, `
		SELECT te.id, te.transaction_id, te.amount_fils, te.occurred_at,
		       CASE WHEN te.metadata ? 'discountBps' THEN (te.metadata->>'feeFils')::bigint END AS booked_fee_fils
		  FROM transaction_events te
		  JOIN transactions t ON t.id = te.transaction_id
		 WHERE t.merchant_id = $1
		   AND NOT t.test_mode
		   AND te.event_type IN ('captured', 'partially_captured')
		   AND te.settlement_batch_id IS NULL
		   AND te.occurred_at >= $2 AND te.occurred_at < $3
		 ORDER BY te.transaction_id, te.occurred_at
		 FOR UPDATE OF te
	`, merchantID, start, end)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: select eligible events: %w", err)
	}

	var events []eligibleEvent
	var orderedTxnIDs []uuid.UUID
	seenTxn := make(map[uuid.UUID]bool)
	for rows.Next() {
		var e eligibleEvent
		var amountFils int64
		if err := rows.Scan(&e.id, &e.transactionID, &amountFils, &e.occurredAt, &e.bookedFeeFils); err != nil {
			rows.Close()
			return BatchResult{}, fmt.Errorf("settlement: CloseBatch: scan eligible event: %w", err)
		}
		e.amountFils = money.Fils(amountFils)
		events = append(events, e)
		if !seenTxn[e.transactionID] {
			seenTxn[e.transactionID] = true
			orderedTxnIDs = append(orderedTxnIDs, e.transactionID)
		}
	}
	if err := rows.Err(); err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: iterate eligible events: %w", err)
	}
	rows.Close()

	// Step 7: group the locked rows in Go, by transaction_id. Zero rows is
	// valid and proceeds with all totals at zero.
	grouped := make(map[uuid.UUID][]eligibleEvent, len(orderedTxnIDs))
	for _, e := range events {
		grouped[e.transactionID] = append(grouped[e.transactionID], e)
	}

	// Step 8: for each transaction group, and for the batch as a whole.
	// Fee is taken PER EVENT, then summed — never ApplyRateFils applied once
	// to the pre-summed total. An event that records the fee its capture
	// journaled settles exactly that fee: recomputing it here with today's
	// rate paid out any rate change since capture without journaling it, and
	// left merchant_payable off by the difference. Only events without a
	// recorded fee fall back to the recomputation.
	type txnLine struct {
		transactionID uuid.UUID
		grossFils     money.Fils
		feeFils       money.Fils
	}
	var lines []txnLine
	var batchGross, batchFee money.Fils
	var eventIDs []int64

	for _, txnID := range orderedTxnIDs {
		var grossForTxn, feeForTxn money.Fils
		for _, e := range grouped[txnID] {
			grossForTxn += e.amountFils
			eventIDs = append(eventIDs, e.id)
			if e.bookedFeeFils != nil {
				feeForTxn += money.Fils(*e.bookedFeeFils)
				continue
			}
			effectiveMdrBps := EffectiveMdrBpsAt(schedules, e.occurredAt, mdrBps)
			if effectiveMdrBps -= tierBonusBps; effectiveMdrBps < 0 {
				effectiveMdrBps = 0
			}
			feeForTxn += ComputeSettlementFee(e.amountFils, effectiveMdrBps, discountBps)
		}
		lines = append(lines, txnLine{txnID, grossForTxn, feeForTxn})
		batchGross += grossForTxn
		batchFee += feeForTxn
	}

	// Step 9: refunds come off the payout. Each one was journaled by
	// processRefund as a merchant_payable debit of its gross and a credit of
	// its fee reversal, so the batch deducts exactly amount - fee reversed;
	// without this the merchant was paid for money already returned to the
	// cardholder and merchant_payable went negative by that much.
	refunds, err := claimBatchRefunds(ctx, tx, merchantID, batchID, end)
	if err != nil {
		return BatchResult{}, err
	}
	// Journaled credits and adjustments are paid (or collected) the same way.
	corrections, err := claimBatchCorrections(ctx, tx, merchantID, batchID, end)
	if err != nil {
		return BatchResult{}, err
	}
	ownNet := NetPayableFils(batchGross, batchFee) - refunds.netDeductionFils() + corrections
	// A shortfall from an earlier negative batch is recovered here.
	carriedIn, err := claimCarriedShortfall(ctx, tx, merchantID, batchID)
	if err != nil {
		return BatchResult{}, err
	}
	netPayout := ownNet + carriedIn

	// Record this batch's contribution to the platform-wide lifetime
	// processed-volume counter, in the same transaction that freezes this
	// batch's own totals — so the counter and the batch it describes
	// commit or roll back together.
	if err := RecordPlatformProcessedVolume(ctx, tx, platformProcessedFils, int64(batchGross)); err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: record platform volume: %w", err)
	}

	// Step 10: freeze the batch totals.
	_, err = tx.Exec(ctx, `
		UPDATE settlement_batches
		   SET status = 'closed', gross_fils = $2, fee_fils = $3, net_payout_fils = $4, closed_at = now()
		 WHERE id = $1
	`, batchID, int64(batchGross), int64(batchFee), int64(netPayout))
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: freeze batch totals: %w", err)
	}

	// Step 11: mark every included event as batched — permanently
	// ineligible for any future batch.
	if len(eventIDs) > 0 {
		_, err = tx.Exec(ctx, `
			UPDATE transaction_events SET settlement_batch_id = $2 WHERE id = ANY($1)
		`, eventIDs, batchID)
		if err != nil {
			return BatchResult{}, fmt.Errorf("settlement: CloseBatch: mark events batched: %w", err)
		}
	}

	for i, line := range lines {
		truncated := TruncateToSchemeAmount(line.grossFils)
		// `amount` is the 2-decimal BD value the scheme file sends. ADR-0002:
		// it must be exactly amount_fils / 1000. It used to be the untruncated
		// gross as a float64 (SchemeAmountBD), which Postgres rounded half-up
		// into numeric(10,2) — 4747 fils went out as 4.75 while we booked
		// 4740. Rounded >= truncated on every line, so the scheme statement
		// was always a few fils over ours, never under (Finance, Evidence 02).
		_, err = tx.Exec(ctx, `
			INSERT INTO scheme_export_lines (settlement_batch_id, transaction_id, amount_fils, amount, line_sequence)
			VALUES ($1, $2, $3, $4::text::numeric(10,2), $5)
		`, batchID, line.transactionID, int64(truncated), formatFilsAsTwoDecimalString(truncated), i+1)
		if err != nil {
			return BatchResult{}, fmt.Errorf("settlement: CloseBatch: insert scheme export line: %w", err)
		}

		// ADR-0002 option A: journal the 0-9 fils truncated off this line,
		// which the scheme will never pay, out of card_scheme_clearing into
		// the scheme_rounding_residue suspense account. The ADR is marked
		// implemented but nothing posted it, so the residue sat unexplained
		// in clearing and the ledger could not tie to the scheme statement.
		if residue := line.grossFils - truncated; residue > 0 {
			_, err = tx.Exec(ctx, `
				INSERT INTO ledger_entries
				  (entry_group_id, merchant_id, transaction_id, settlement_batch_id, account_id, direction, amount_fils, occurred_at, description)
				VALUES
				  ($1, $2, $3, $4, 'card_scheme_clearing',    'credit', $5, now(), 'scheme export: rounding residue'),
				  ($1, $2, $3, $4, 'scheme_rounding_residue', 'debit',  $5, now(), 'scheme export: rounding residue')
			`, uuid.New(), merchantID, line.transactionID, batchID, int64(residue))
			if err != nil {
				return BatchResult{}, fmt.Errorf("settlement: CloseBatch: post scheme rounding residue: %w", err)
			}
		}
	}

	// Step 13: enqueue settlement.batch_closed onto the shared outbox, in
	// the same transaction as the frozen totals.
	payload, err := buildBatchClosedPayload(merchantID, batchID, batchDateOnly, batchGross, batchFee, netPayout)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: build outbox payload: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
		VALUES ('settlement.batch_closed', 'settlement_batch', $1, $2)
	`, batchID, payload)
	if err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: enqueue outbox event: %w", err)
	}

	// Step 14: incrementally update the merchant_balances cache by this
	// batch's own activity. A carried-in shortfall is already in the cache:
	// it was added when its own batch closed and never paid out. So are the
	// claimed corrections: credits.ts and ledgerAdjustments.ts callers move
	// the cache when they post.
	if err := balances.ApplyBatchClose(ctx, tx, merchantID, batchID, ownNet-corrections); err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: apply balance cache delta: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return BatchResult{}, fmt.Errorf("settlement: CloseBatch: commit: %w", err)
	}

	return BatchResult{
		BatchID:             batchID,
		MerchantID:          merchantID,
		BatchDate:           batchDateOnly,
		AlreadyClosed:       false,
		GrossFils:           batchGross,
		FeeFils:             batchFee,
		NetPayoutFils:       netPayout,
		RefundDeductionFils: refunds.netDeductionFils(),
		EventCount:          len(eventIDs),
		LineCount:           len(lines),
	}, nil
}

// PayoutBatch posts the ledger legs representing an actual payout for an
// already-closed batch and transitions it 'closed' -> 'paid'. Idempotent:
// a batch that is not 'closed' (already 'paid', or somehow still 'open')
// is a safe no-op.
func PayoutBatch(ctx context.Context, db *pgxpool.Pool, batchID uuid.UUID) (PayoutResult, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return PayoutResult{}, fmt.Errorf("settlement: PayoutBatch: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var merchantID uuid.UUID
	var status string
	var netPayout int64
	err = tx.QueryRow(ctx, `
		SELECT merchant_id, status, net_payout_fils FROM settlement_batches WHERE id = $1 FOR UPDATE
	`, batchID).Scan(&merchantID, &status, &netPayout)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PayoutResult{}, fmt.Errorf("settlement: PayoutBatch: batch %s not found", batchID)
		}
		return PayoutResult{}, fmt.Errorf("settlement: PayoutBatch: lock batch: %w", err)
	}

	if status == "paid" {
		tx.Rollback(ctx) //nolint:errcheck
		return PayoutResult{BatchID: batchID, MerchantID: merchantID, AlreadyPaid: true, NetPayoutFils: money.Fils(netPayout)}, nil
	}
	if status != "closed" {
		tx.Rollback(ctx) //nolint:errcheck
		return PayoutResult{BatchID: batchID, MerchantID: merchantID, NotClosed: true, NetPayoutFils: money.Fils(netPayout)}, nil
	}

	// Post the payout leg pair only when net_payout_fils > 0 — omitted
	// entirely for an empty or fee-only batch (ledger_entries has a CHECK
	// (amount_fils > 0)). card_scheme_clearing isn't touched here; scheme
	// clearing is its own process.
	if netPayout > 0 {
		groupID := uuid.New()
		_, err = tx.Exec(ctx, `
			INSERT INTO ledger_entries
			  (entry_group_id, merchant_id, settlement_batch_id, account_id, direction, amount_fils, occurred_at, description)
			VALUES
			  ($1, $2, $3, 'merchant_payable', 'debit',  $4, now(), 'settlement payout: batch paid'),
			  ($1, $2, $3, 'platform_cash',    'credit', $4, now(), 'settlement payout: batch paid')
		`, groupID, merchantID, batchID, netPayout)
		if err != nil {
			return PayoutResult{}, fmt.Errorf("settlement: PayoutBatch: post payout legs: %w", err)
		}
	}

	// What actually leaves: nothing for a zero or negative net. A negative
	// net (refunds above the day's captures) stays owed in merchant_payable
	// and the cache, and the next CloseBatch deducts it.
	paid := paidOutFils(money.Fils(netPayout))

	// Runs unconditionally, including for a zero-payout batch: adding zero
	// is a no-op, and keeping the running total's every update in lockstep
	// with every processed batch — rather than skipping zero-value ones —
	// keeps its own bookkeeping simple.
	if err := UpdateLifetimePayoutMonitoringEstimate(ctx, tx, merchantID, paid); err != nil {
		return PayoutResult{}, fmt.Errorf("settlement: PayoutBatch: update lifetime payout monitoring estimate: %w", err)
	}

	_, err = tx.Exec(ctx, `
		UPDATE settlement_batches SET status = 'paid', paid_at = now() WHERE id = $1
	`, batchID)
	if err != nil {
		return PayoutResult{}, fmt.Errorf("settlement: PayoutBatch: update batch status: %w", err)
	}

	if err := balances.ApplyPayout(ctx, tx, merchantID, batchID, paid); err != nil {
		return PayoutResult{}, fmt.Errorf("settlement: PayoutBatch: apply balance cache delta: %w", err)
	}

	if err := disbursement.Record(ctx, tx, batchID, money.Fils(netPayout)); err != nil {
		return PayoutResult{}, fmt.Errorf("settlement: PayoutBatch: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return PayoutResult{}, fmt.Errorf("settlement: PayoutBatch: commit: %w", err)
	}

	return PayoutResult{BatchID: batchID, MerchantID: merchantID, NetPayoutFils: money.Fils(netPayout)}, nil
}

// DailyBatchReport summarizes one RunDailyBatch pass.
type DailyBatchReport struct {
	BusinessDate    time.Time
	MerchantResults []MerchantBatchOutcome
}

// MerchantBatchOutcome is one merchant's CloseBatch+PayoutBatch outcome
// within a daily pass.
type MerchantBatchOutcome struct {
	MerchantID    uuid.UUID
	BatchID       uuid.UUID
	AlreadyClosed bool
	AlreadyPaid   bool
	GrossFils     money.Fils
	FeeFils       money.Fils
	NetPayoutFils money.Fils
	// RefundDeductionFils is CloseBatch's figure: refunds netted off the payout.
	RefundDeductionFils money.Fils
}

// RunDailyBatch closes and pays out every eligible merchant's batch for
// one business date. Called by `run-batch` directly, and by `daemon` once
// per scheduled wake-up for the business day that just completed.
//
// Sequential processing (one merchant at a time, never concurrently) is a
// deliberate simplicity choice: each merchant's batch is its own pair of
// short transactions, so there is no cross-merchant lock contention to
// parallelize away, and this removes any question of lock-ordering
// between concurrent goroutines each trying to FOR UPDATE a
// settlement_batches row.
func RunDailyBatch(ctx context.Context, db *pgxpool.Pool, businessDate time.Time, onlyMerchant *uuid.UUID) (DailyBatchReport, error) {
	var merchantIDs []uuid.UUID
	if onlyMerchant != nil {
		merchantIDs = []uuid.UUID{*onlyMerchant}
	} else {
		rows, err := db.Query(ctx, `
			SELECT id FROM merchants WHERE status = 'active' AND test_mode = false ORDER BY id
		`)
		if err != nil {
			return DailyBatchReport{}, fmt.Errorf("settlement: RunDailyBatch: select merchants: %w", err)
		}
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return DailyBatchReport{}, fmt.Errorf("settlement: RunDailyBatch: scan merchant id: %w", err)
			}
			merchantIDs = append(merchantIDs, id)
		}
		if err := rows.Err(); err != nil {
			return DailyBatchReport{}, fmt.Errorf("settlement: RunDailyBatch: iterate merchants: %w", err)
		}
		rows.Close()
	}

	sort.Slice(merchantIDs, func(i, j int) bool { return merchantIDs[i].String() < merchantIDs[j].String() })

	report := DailyBatchReport{BusinessDate: businessDate}
	// One merchant's failure must not stop the others being settled: the
	// daemon only ever retries the most recent business day, so a merchant
	// skipped here would otherwise go unpaid until an operator backfills.
	// Each failure is recorded and the loop moves on; the caller gets every
	// failure joined into one error alongside the merchants that did settle.
	var failures []error
	for _, merchantID := range merchantIDs {
		if err := ctx.Err(); err != nil {
			failures = append(failures, fmt.Errorf("settlement: RunDailyBatch: %w", err))
			break
		}
		closeResult, err := CloseBatch(ctx, db, merchantID, businessDate)
		if err != nil {
			if errors.Is(err, ErrMerchantNotEligible) {
				// A caller passed an explicit --merchant that isn't
				// active/non-test-mode. Skip it, same as the default
				// merchant scan already would have.
				continue
			}
			failures = append(failures, fmt.Errorf("settlement: RunDailyBatch: CloseBatch(%s): %w", merchantID, err))
			continue
		}

		// A merchant with configured sub-merchant split children is paid
		// out across those children rather than as a single lump sum to
		// itself. CloseBatch above is identical either way — only the
		// payout leg differs.
		isSplitParent, err := splits.IsSplitParent(ctx, db, merchantID)
		if err != nil {
			failures = append(failures, fmt.Errorf("settlement: RunDailyBatch: IsSplitParent(%s): %w", merchantID, err))
			continue
		}

		var alreadyPaid bool
		if isSplitParent {
			splitResult, err := splits.PayoutSplitBatch(ctx, db, closeResult.BatchID)
			if err != nil {
				failures = append(failures, fmt.Errorf("settlement: RunDailyBatch: PayoutSplitBatch(%s): %w", closeResult.BatchID, err))
				continue
			}
			alreadyPaid = splitResult.AlreadyPaid
		} else {
			payoutResult, err := PayoutBatch(ctx, db, closeResult.BatchID)
			if err != nil {
				failures = append(failures, fmt.Errorf("settlement: RunDailyBatch: PayoutBatch(%s): %w", closeResult.BatchID, err))
				continue
			}
			alreadyPaid = payoutResult.AlreadyPaid
		}

		report.MerchantResults = append(report.MerchantResults, MerchantBatchOutcome{
			MerchantID:          merchantID,
			BatchID:             closeResult.BatchID,
			AlreadyClosed:       closeResult.AlreadyClosed,
			AlreadyPaid:         alreadyPaid,
			GrossFils:           closeResult.GrossFils,
			FeeFils:             closeResult.FeeFils,
			NetPayoutFils:       closeResult.NetPayoutFils,
			RefundDeductionFils: closeResult.RefundDeductionFils,
		})
	}

	return report, errors.Join(failures...)
}
