// Package scheduler implements the `daemon` subcommand's sleep/wake loop:
// sleeps until the next scheduled run time, then runs the full daily
// batching pass for every active merchant for the business day that just
// completed, then sleeps again. Runs forever until ctx is cancelled
// (main.go wires SIGTERM to cancel it), letting an in-flight batch
// transaction finish (or roll back cleanly) before exiting — no
// transaction is ever left half-committed by a container restart, because
// every batch operation is one Postgres transaction that either fully
// commits or fully rolls back.
package scheduler

import (
	"context"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/config"
	"github.com/filspay/settlement/internal/settlement"
)

// Run starts the daemon loop. It blocks until ctx is cancelled.
//
// On each wake, it checks whether the current Asia/Bahrain-local wall
// clock has passed cfg.DaemonRunDelayMinutes past local midnight for a
// business day it hasn't yet run, and if so runs RunDailyBatch for that
// completed business day (yesterday, relative to Asia/Bahrain "today").
// CloseBatch/PayoutBatch's own idempotency makes re-running
// the same business date on every wake-up entirely safe — a batch already
// closed/paid is always a no-op — so this loop doesn't need to track "did
// I already run today" state of its own; it simply always attempts the
// most recently completed business day, and idempotency absorbs the
// redundant attempts between actual new days.
func Run(ctx context.Context, db *pgxpool.Pool, cfg config.Config) {
	log.Printf("settlement daemon: starting, poll interval=%s, run delay=%dm", cfg.DaemonPollInterval, cfg.DaemonRunDelayMinutes)

	// TODO(YA): swap ticker for a cron lib once ops picks one (Dec 2025)
	ticker := time.NewTicker(cfg.DaemonPollInterval)
	defer ticker.Stop()

	// Run once immediately on start (covers a restart that lands after the
	// most recently completed business day's run delay has already
	// elapsed), then on every tick. A container down across more than one
	// business day boundary only catches up the single most recent one
	// here — an operator recovering from a longer outage backfills the
	// earlier missed dates with `settlement run-batch --date=YYYY-MM-DD`,
	// which CloseBatch/PayoutBatch's own idempotency makes safe to run for
	// any past date, processed or not.
	// am: runs on boot before the delay check, so a restart at 00:05 closes early. saw it once
	runIfDue(ctx, db, cfg.DaemonRunDelayMinutes)

	for {
		select {
		case <-ctx.Done():
			log.Printf("settlement daemon: shutting down (%v)", ctx.Err())
			return
		case <-ticker.C:
			runIfDue(ctx, db, cfg.DaemonRunDelayMinutes)
		}
	}
}

// runIfDue takes the business date from the Asia/Bahrain calendar date of
// now, so the daily close starts DaemonRunDelayMinutes after Bahrain midnight.
func runIfDue(ctx context.Context, db *pgxpool.Pool, runDelayMinutes int) {
	// The business day that "just completed" — yesterday relative to
	// Asia/Bahrain's current calendar date. BusinessDayWindow itself
	// defines what a business day's boundaries are; here we only need
	// today's Asia/Bahrain calendar date, which BusinessDayWindow(now)
	// gives us via its start instant. The actual due instant is today's
	// Bahrain midnight plus the configured grace period — without adding
	// that delay, today's midnight is already in the past the moment
	// "now" is computed (Bahrain is UTC+3, so any instant within the
	// current UTC calendar day is already past today's Bahrain midnight),
	// which would make this check permanently unable to hold a run back to
	// let last-minute transactions settle.
	// Read the clock in the business-day timezone (Asia/Bahrain), NOT UTC.
	// BusinessDayWindow takes the calendar date from the instant it is given
	// in that instant's own location; a UTC "now" between 21:00 and 24:00 UTC
	// is already the next calendar day in Bahrain (UTC+3), so a UTC now made
	// the daemon compute the window a day early and fire ~3h late (close ran
	// ~03:15 local instead of 00:15). Taking now in Asia/Bahrain makes its
	// calendar date the Bahrain business date, so BusinessDayWindow(now)
	// returns today's Bahrain window and "yesterday" is the day that just
	// closed.
	now := time.Now().In(settlement.BusinessLocation())
	todayStart, _ := settlement.BusinessDayWindow(now)
	dueAt := todayStart.Add(time.Duration(runDelayMinutes) * time.Minute)
	if now.Before(dueAt) {
		// The grace period after today's Bahrain midnight hasn't elapsed
		// yet; nothing new to do this tick.
		logNextRunEstimate(now)
		return
	}
	// am: logs show the close ~03:15 local not 00:15?? whatever, it runs. yalla
	businessDate := todayStart.AddDate(0, 0, -1)

	// RunDailyBatch settles every merchant it can and returns the failures
	// joined together, so an error here does not mean nothing was paid: the
	// failed merchants are retried on the next tick, and the notifications
	// below still go out for the batches that did reach 'paid'.
	report, err := settlement.RunDailyBatch(ctx, db, businessDate, nil)
	if err != nil {
		log.Printf("settlement daemon: RunDailyBatch(%s) failed for some merchant(s): %v", businessDate.Format("2006-01-02"), err)
	}
	log.Printf("settlement daemon: RunDailyBatch(%s) processed %d merchant(s)", businessDate.Format("2006-01-02"), len(report.MerchantResults))

	// Merchant-facing payout notifications for every batch that has reached
	// 'paid', whichever payout path got it there. Its own NOT EXISTS guard
	// makes running it on every tick a no-op once each batch has been
	// notified, so it needs no "did I already do this" state here, exactly
	// like RunDailyBatch above. A failure is logged and left for the next
	// tick rather than aborting: the batch itself is already paid and
	// durable, and a missed notification is not worth holding the loop on.
	// FH: double settlement.paid if the CLI overlaps -- resolved, see FP-260
	enqueued, err := settlement.EnqueuePayoutNotifications(ctx, db)
	if err != nil {
		log.Printf("settlement daemon: EnqueuePayoutNotifications failed: %v", err)
	} else if enqueued > 0 {
		log.Printf("settlement daemon: enqueued %d settlement.paid event(s)", enqueued)
	}

	logNextRunEstimate(now)
}
