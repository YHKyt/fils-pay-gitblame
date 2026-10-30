# Reporting consumer and read model

Branch `agent/reporting`, migration `0096_outbox_commit_order_cursor.sql`. Each test below failed on the old code and passes on the fix (these tests need `DATABASE_URL`).

## RP1. The consumer lost events and applied others twice — High
**Where:** `apps/reporting/src/consumer/runConsumerPass.ts`, `cursor.ts`, `db/migrations/0096`
**Evidence:** `runConsumerPass.ordering.test.ts`:
- A late-committing event was applied 0 times (expected 1).
- Two concurrent passes applied one event twice (expected once).

- **What:** the consumer read `WHERE id > cursor ORDER BY id`, and read the cursor with a plain SELECT.
- **Why:**
  - Ids are drawn at INSERT, not at COMMIT. If id 13 commits after id 14, the cursor has already moved past 13, so 13 sits below it forever.
  - Because the cursor read takes no lock, two passes can apply the same events. That happens with catch-up running beside the worker (which the RUNBOOK calls safe), or with a second replica.
- **Breaks:** under concurrency, the volumes silently lose captures and voids; when consumers overlap, they double-count.
- **Fix:**
  - Add `outbox_events.xact_id xid8 DEFAULT pg_current_xact_id()`. Existing rows get `'0'`, so there is no table rewrite. Add a `(xact_id, id)` index.
  - The cursor becomes a `(xact_id, id)` position, locked `FOR UPDATE` on each pass, and it only moves forward.
  - Each pass reads only events from transactions older than the snapshot's xmin. Those transactions have all finished, so nothing can later appear behind the cursor.
  - This is the approach described in HANDOVER.md. The cost is a little lag, never lost events.
- **Test:** `runConsumerPass.ordering.test.ts`.

## RP2. Deploy overlap: the old worker's watermark stays a floor — Medium
- **What:** during a deploy, an old id-only worker can still run between the migration and the restart. It may apply an event with a high id but a low transaction id, which the new consumer would then apply again.
- **Fix:** `id_floor` keeps the last id watermark. Events at or below it are never applied again.
- **Test:** "an event the id-only consumer applied is not applied again": 2 applications before the fix, 1 after.

## RP3. Admin "Rebuild analytics" double-counted events not yet consumed — Medium
**Where:** `apps/api/src/admin/reportingRebuild.ts`, `runConsumerPass.ts`, `0096` (`rebuilt_snapshot`)
**Evidence:** `reportingRebuild.test.ts`: one pending 4,250-fils capture showed as 2 captures / 8,500 fils after a rebuild.

- **What / why:** the rebuild recomputes the rollups from the source tables but leaves the consumer cursor where it was, so the next pass applies everything not yet consumed a second time.
- **Fix:**
  - Take `LOCK TABLE reporting_outbox_cursor IN EXCLUSIVE MODE`, and fill both rollups in one statement, so they come from one snapshot.
  - Move the cursor to the last event below that snapshot's xmin, and store the snapshot.
  - The consumer skips events already visible in the stored snapshot (`pg_visible_in_snapshot`). Transactions still in flight during the rebuild are applied once.
  - Payments are never blocked.
- **Credit:** the analytics worker found this independently. Its version moved an id watermark under a SHARE lock on `outbox_events`, which doesn't fit the commit-order cursor and blocks payment writes, so it was re-implemented here.

## RP4. Refunds never reached the reports — High (FP-300)
**Where:** `REPORTING_EVENT_TYPES`, `applyEvent.ts`, `reportingRebuild.ts`, `analytics/query.ts` (`getVolumes`), `0096`

- **What:** `refund.succeeded` was never consumed. The function meant to roll refunds up, `applyDailySummaryRollup`, was dead code: it wrote to columns that don't exist and used a UTC date.
- **Breaks:** the case file's FP-300 "done when" includes "shows up right in the timeline, the reports and reconciliation". Refunds never showed in the reports.
- **Fix:**
  - Add `refund_count` / `refund_gross_fils` columns, with an exact backfill of the refund events the cursor has already passed.
  - The applier uses `payload.amountFils` and buckets by the Asia/Bahrain date of the outbox row.
  - The admin rebuild fills the columns from `refunds` (succeeded only). Since `6cb4837` it reads the `refund.succeeded` outbox events instead, as the consumer does (see `sqlhunt.md`).
  - `getVolumes` returns `refundCount` / `refundGrossFils` as new fields; existing fields are unchanged.
- **Test:** `applyEvent.refund.test.ts`: a refund at 22:30 UTC on 1 Mar lands on 2026-03-02 as 1 refund / 1,250 fils. `reportingRebuild.test.ts` has a refund case.

## RP5. Payout trends never showed "paid" — Medium
- **What:** a `batch_closed` event copies the batch status as `closed`. The `settlement.paid` event, enqueued after the payout, was never consumed, so trends stayed `closed`.
- **Fix:** the consumer now handles `settlement.paid` and copies the batch's status and `paid_at`. `0096` fixes existing trend rows once.
- **Test:** `applyEvent.settlementPaid.test.ts` (`closed` before the fix, `paid` after).
- **Credit:** the analytics worker found a read-side variant of this.

**Deploy note:** stop the old reporting worker before applying 0096 and restart it on the new code.
