# SQL layer audit (sqlhunt)

Scope: every `db/migrations/*.sql`, the seed, and raw SQL in `apps/**` and
`scripts/**` outside the areas other reviewers own. Every finding below was
reproduced against a freshly migrated and seeded database before it was fixed,
and each fix has a regression test that fails on the old schema and passes on
the fix.

The ledger append-only gap (0007's balance trigger lets a balanced edit or
delete of posted legs commit) was found here too, but is already fixed by
`0092_ledger_entries_append_only.sql` (see `ledgerint.md`), so it is not
repeated.

## Q1. Refund summary view is never refreshed, so it never shows a new refund — Low

**Where:** `db/migrations/0072_refund_merchant_summary.sql`, `db/migrations/0075_refund_merchant_summary_fix.sql`; fix in `db/migrations/0104_refund_merchant_summary_live_view.sql`.

**Evidence:** after a succeeded refund of 4,000 fils is inserted, `SELECT … FROM refund_merchant_summary WHERE merchant_id = …` returns `[]`. `grep -ri "refresh materialized"` over the repository finds nothing.

- **What:** the view is `MATERIALIZED`, and its header says it is "refreshed by the reporting worker after each settlement run". No code anywhere runs `REFRESH MATERIALIZED VIEW refund_merchant_summary`.
- **Why:** a materialized view is a snapshot taken when it is created. 0075 recreated it (fixing the join, R6) but the snapshot is still taken once, at migrate time.
- **Breaks:** the per-merchant, per-day refund totals hold whatever existed at deploy (nothing, on a fresh database) and never change. Anyone reading them for the refunds feature sees zero refunds.
- **Fix:** replace it with a plain view using exactly the 0075 query and columns. It is always current, needs no refresh job, and at this table's size costs nothing. That is smaller and safer than adding a refresh to a worker. Nothing else reads or indexes it.
- **Test:** `apps/api/src/db/refundMerchantSummary.test.ts` (two succeeded refunds and one failed refund on one Bahrain day, one of them at 01:30 Bahrain / 22:30 UTC the previous day). Before 0104: `actual []`. After: one row, `2026-10-30`, count 2, refunded 5000, fee reversed 125, captured 10000.

## Reported, not fixed (other lanes)

### Reporting consumer skips outbox events committed out of id order — High (reporting consumer)

**Where:** `apps/reporting/src/consumer/runConsumerPass.ts` (`WHERE id > $cursor ORDER BY id`), `db/migrations/0030_reporting_outbox_cursor.sql`.

**Evidence:** transaction A inserts a `transaction.captured` outbox row (id 13, 1,111 fils) and stays open; transaction B inserts id 14 (2,222 fils) and commits; a consumer pass processes 1 event and moves the cursor to 14; A commits; the next pass processes 0. `merchant_daily_volume` gained 2,222 fils, never the 1,111.

- `outbox_events.id` is a sequence value taken at INSERT, not at COMMIT, and the API, the settlement worker and every concurrent request write the outbox. A slower transaction that took a lower id becomes visible after the cursor has passed it, and is skipped forever. The "ids are monotonic" comment in the consumer is true of allocation, not of visibility.

### Admin "Rebuild analytics" is a second implementation that disagrees with the consumer — Medium (admin) — fixed in `6cb4837`

**Where:** `apps/api/src/admin/reportingRebuild.ts`, `apps/api/src/routes/admin.ts` (`POST /v1/admin/reporting/rebuild`).

**Evidence:** on the seeded database the live rollup holds 4 `merchant_daily_volume` rows / 5 captures / 1,236,975 fils and 4 payout-trend rows; the rebuild query produces 201 rows / 1,423 captures / 1,236,483,286 fils and 68 payout-trend rows.

- The route comment says the rebuild "replays the outbox from the start"; the code instead re-aggregates `transaction_events` and copies every `settlement_batches` row (open batches included) and does not touch `reporting_outbox_cursor`. Outbox events the consumer has not reached yet are counted once by the rebuild and again when the consumer applies them. The CLI `reporting rebuild` (truncate, reset cursor, replay) is the consistent one.
- **Fixed in `6cb4837`:** RP3 (`reporting.md`) had already stopped the double count: the rebuild moves the cursor and stores its snapshot. The seed now writes outbox events for its history (seeddemo SD2/SD3), so on a fresh seed the volume rollup agreed both ways (256 rows / 1,527 captures / 1,245,818,113 fils). But the rebuild still copied every `settlement_batches` row, giving 98 trend rows (3 of them open) against the consumer's 95. It now aggregates `outbox_events` the way `applyEvent.ts` applies them: the same event types and payload fields, the Asia/Bahrain day of the outbox row, and the last `settlement.batch_closed` per batch with the batch's current status and `paid_at`. It keeps the single statement and the cursor move. On the reseeded database the rebuild equals the live rollup, and it still does after another consumer pass. Test: `apps/api/src/admin/reportingRebuild.parity.test.ts`. It fails before the fix, because the open batch appears as a trend row, and passes after.

### Smaller items seen, not changed
- `db/seed/fixtures/production_seed.sql` (50k lines, "production-equivalent", referenced by nothing) cannot load on the current schema: `transaction_events_event_type_check` rejects its `refund.succeeded` rows. It also marks rows `refunded` with `captured_fils = 0`.
- Seed: the pre-baked 2026-08-31 closed batches roll a month of transactions into one business day and charge `fixture.mdrBps` even where a `fee_schedules` row is in force (Alpha Retail: 250 bps charged, 225 bps effective from 2026-08-01). Demo data only.
- `merchant_payable_position` (0054) sums scheme-export lines (gross, no fees, refunds or payouts) and `v_unbatched_capture_events` omits `partially_captured`. Neither is read by any code since M6; misleading if reused.
- A merchant created by signup is `status = 'active'`, `test_mode = false` with `kyc_passed = false`, and nothing in payments or settlement checks `kyc_passed`. Not changed: no document states that KYC must gate payments (onboarding lane).
