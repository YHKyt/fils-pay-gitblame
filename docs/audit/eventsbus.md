# Outbox events: producers, payloads and consumers

Branch `agent/eventsbus`. Scope: `packages/events`, every place that writes `outbox_events` (capture, void, refund, the Go settlement close/notify/MDR recalculation, the seed), and whether each consumer (reporting, the webhook envelope, the settlement notifier) gets the events and payload fields it reads.

Checked and found consistent, with a real capture, partial capture, two refunds and a void run through the API and then through the dispatcher and the reporting consumer: every producer enqueues in the same transaction as its business write; payload keys match what `applyEvent.ts` and `envelope.ts` read; the type lists in `EventType`, `REPORTING_EVENT_TYPES` and the dispatcher's eligible list agree; failure paths (declined capture or refund, idempotent replays, a second void) enqueue nothing.

## EV1. A freshly seeded deployment reports almost none of its own history — Medium
**Where:** `db/seed/generate.ts` (the per-merchant outbox block). Test: `db/seed/outboxParity.test.ts`.
**Evidence:** `SEED_RESET=1 npx tsx --test db/seed/outboxParity.test.ts` on the old seed, after draining the reporting consumer:
`+ captures: '4', gross: '1234753'` / `- captures: '1423', gross: '1236483286'` (read model vs seeded `transaction_events`), and 4 payout trends for 64 closed batches. On the fix: `ok 1`.

- **What:** the seed wrote 1,423 capture events and 64 closed batches, but enqueued only one hand-picked `transaction.captured` and one `settlement.batch_closed` per merchant (4 of each).
- **Why:** the merchant analytics (`merchant_daily_volume`, `merchant_payout_trends`) are built only from the outbox, by the live consumer and by its `rebuild` replay. Events that were never enqueued can never reach them. The admin "Rebuild analytics" button reads the source tables instead, so the two read paths disagreed on the same data.
- **Breaks:** on the hosted demo (compose seeds an empty database), every merchant dashboard shows 4 captures worth 1,234.753 BD in total instead of 1,236,483.286 BD, and 4 payout trend points instead of 64. The consumer also logs a "rollup lags ground truth" warning for each seeded batch.
- **Fix:** drop the hand-picked capture and batch events. At the end of the seed transaction, derive one `transaction.captured` per seeded capture event and one `settlement.batch_closed` per closed batch with two `INSERT ... SELECT` statements, using the exact payload shapes `capture.ts` and `CloseBatch` enqueue. `created_at` is set to when the capture or close happened, so:
  - reporting buckets each one on its own Asia/Bahrain day, and
  - the dispatcher, which only delivers events newer than an endpoint, never treats seed history as new webhook traffic.

  The voided example event is unchanged. This is the smallest change because it touches only the seed and needs no change to reporting or to any producer.
- **Test:** `outboxParity.test.ts` seeds, drains the consumer, and checks that total captures and gross, every merchant/day bucket, and every payout trend (gross, fee, net) match the seeded tables. It is destructive (it truncates every seed table), so it runs only with `SEED_RESET=1`, the same opt-in the seed CLI uses. `npm run seed` still passes all its assertions, including `seed-deterministic`.

## Reported, not fixed (another lane or a product decision)

### Webhooks for one transaction can arrive out of order — Medium (dispatcher, Claude B's lane)
**Where:** `apps/api/src/webhooks/dispatcher.ts`: Step A inserts every new delivery with `next_attempt_at = now()` (one value for the whole pass), and Step B claims rows `ORDER BY next_attempt_at ASC` with no tie-breaker.
**Evidence:** a partial capture (6,000), the final capture (4,000), a partial refund (3,000) and a full refund (7,000) on one transaction, followed by one dispatch pass, were sent as: captured `partially_captured`, refund `refunded`, refund `partially_refunded`, captured `captured`. The last webhook the merchant received said `status: captured` for a transaction that is fully refunded.
- **Why it matters:** a merchant that keeps the latest `status` it was sent ends up with the wrong state.
- **Suggested fix:** add `id ASC` (or `outbox_event_id ASC`) as a tie-breaker in Step B's ORDER BY.

### Zero and negative payout batches never show "paid" in payout trends — Low (settlement notifier and dispatcher)
**Where:** `apps/settlement/internal/settlement/payout_notify.go` (`AND sb.net_payout_fils > 0`), `apps/reporting/src/consumer/applyEvent.ts` (`applySettlementPaid`).
**Evidence:** a closed batch with net 0 had its `batch_closed` consumed, and was then marked paid. `settlement run-batch --date=2026-10-01 --merchant=<id>` reported `enqueued 0 settlement.paid event(s)`. After draining the consumer, the trend row still said `closed` with `paid_at` NULL, while `settlement_batches.status` was `paid`. The admin "Rebuild analytics" button copies `paid`, so the two read paths disagree.
- **Why:** reporting learns about a payout only from `settlement.paid`, and the notifier deliberately skips non-positive payouts. Its comment says that is because "the dispatcher rejects a payload with netPayoutFils = 0", which is not true: `recordPayoutDisbursementEffect` returns early for amounts of zero or less.
- **Not fixed here:** emitting the event for every paid batch would also send merchants a "payout" webhook for every empty day, unless the dispatcher learns to skip `settlement.paid` with `netPayoutFils <= 0`. That is a dispatcher change, so it was left for the lane owner.

### Seed timeline gaps — Low (seed realism)
Seeded voided transactions have no `voided` timeline event, and the standard merchants' captured transactions have no capture timeline events. Reporting counts 4 voids from the outbox; the admin rebuild counts 0 from `transaction_events`. EV1 deliberately derives events only from rows that exist, so that both read paths agree on captures and batches.
