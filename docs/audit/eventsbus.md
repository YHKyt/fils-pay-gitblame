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

## Reported (another lane or a product decision); the first two are now fixed

### Webhooks for one transaction can arrive out of order — Medium (dispatcher) — fixed in `8088f46`
**Where:** `apps/api/src/webhooks/dispatcher.ts`: Step A inserts every new delivery with `next_attempt_at = now()` (one value for the whole pass), and Step B claims rows `ORDER BY next_attempt_at ASC` with no tie-breaker.
**Evidence:** a partial capture (6,000), the final capture (4,000), a partial refund (3,000) and a full refund (7,000) on one transaction, followed by one dispatch pass, were sent as: captured `partially_captured`, refund `refunded`, refund `partially_refunded`, captured `captured`. The last webhook the merchant received said `status: captured` for a transaction that is fully refunded.
- **Why it matters:** a merchant that keeps the latest `status` it was sent ends up with the wrong state.
- **Fixed in `8088f46`:** Step B (which claims one row at a time since b/h3) now orders by `next_attempt_at, outbox_event_id, id`, so deliveries that are due together go out in event order. Test: `apps/api/src/webhooks/dispatcherOrder.test.ts` puts four tied deliveries in reverse physical order; the old claim sent `refunded -> partially_refunded -> captured -> partially_captured`, the fix sends them in event order. A delivery that fails and backs off can still be overtaken by a later one; receivers should still order by the envelope's `createdAt`.

### Zero and negative payout batches never show "paid" in payout trends — Low (settlement notifier and dispatcher) — fixed in `9f86184`
**Where:** `apps/settlement/internal/settlement/payout_notify.go` (`AND sb.net_payout_fils > 0`), `apps/reporting/src/consumer/applyEvent.ts` (`applySettlementPaid`).
**Evidence:** a closed batch with net 0 had its `batch_closed` consumed, and was then marked paid. `settlement run-batch --date=2026-10-01 --merchant=<id>` reported `enqueued 0 settlement.paid event(s)`. After draining the consumer, the trend row still said `closed` with `paid_at` NULL, while `settlement_batches.status` was `paid`. The admin "Rebuild analytics" button copies `paid`, so the two read paths disagree.
- **Why:** reporting learns about a payout only from `settlement.paid`, and the notifier deliberately skips non-positive payouts. Its comment says that is because "the dispatcher rejects a payload with netPayoutFils = 0", which is not true: `recordPayoutDisbursementEffect` returns early for amounts of zero or less.
- **Fixed in `9f86184`:** `EnqueuePayoutNotifications` enqueues `settlement.paid` for every paid batch, and the dispatcher's Step A creates no webhook delivery for a `settlement.paid` with `netPayoutFils <= 0`, so merchants get no empty "payout" webhook. Reporting is unchanged (`applySettlementPaid` re-reads the batch). Batches already paid with a zero net get their event on the next notifier scan. Tests: `apps/settlement/internal/settlement/payout_notify_zero_test.go` (0 events before, 1 after) and `apps/api/src/webhooks/dispatcherZeroPayout.test.ts` (before, the 0 and -1,250 payouts were sent too). The zero-net half of `TestEnqueuePayoutNotificationsSkipsIneligibleBatches` pinned the bug and was removed with a comment. Rerunning the evidence above now gives `enqueued 1 settlement.paid event(s)` and, after `catch-up`, a trend row `paid` with `paid_at` set.

### Seed timeline gaps — Low (seed realism)
Seeded voided transactions have no `voided` timeline event, and the standard merchants' captured transactions have no capture timeline events. Reporting counts 4 voids from the outbox; the admin rebuild counts 0 from `transaction_events`. EV1 deliberately derives events only from rows that exist, so that both read paths agree on captures and batches.
