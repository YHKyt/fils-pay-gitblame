# Recalculate MDR (`settlement.RecalculateMDR`)

Scope: `apps/settlement/internal/settlement/recalculate_mdr.go`, reached from
the console's **Recalculate MDR** button (`POST /v1/admin/merchants/:id/mdr-recalculation`
→ settlement `/internal/recalculate-mdr`). Builds on M7 in
[money-and-settlement.md](money-and-settlement.md) (paid batches are no longer
rewritten). No API, migration or `batch.go` change was needed; the fixes reuse
`LoadFeeSchedules`, `EffectiveMdrBpsAt`, `VolumeTierMdrBonusBps`,
`ComputeSettlementFee`, `BusinessDayWindow` and `buildBatchClosedPayload`.

All tests below are DB-backed, in `apps/settlement/internal/settlement/`, and
were shown to fail on the previous code and pass on the fix.

## R1. Recalculation ignores fee schedules and the volume tier — High

**Where:** `recalculate_mdr.go`, `RecalculateMDR` / `recomputeBatchFee`.
**Evidence:** the merchant read was `SELECT mdr_bps, negotiated_discount_bps FROM merchants`
and every event was rated at that `mdr_bps`. `CloseBatch` (`batch.go` step 8)
rates each event at `EffectiveMdrBpsAt(fee_schedules, occurred_at, mdr_bps)`
minus `VolumeTierMdrBonusBps` (15 bps once the platform passes 2,000,000 BD).
The seed has merchants on schedules below their default (Alpha Retail 225 vs
250, Beta Digital 165 vs 180).

- **What:** a recalculation with no rate change re-rates every scheduled or
  tier-discounted batch at the merchant's plain default.
- **Why:** the recalculation resolved the rate its own way instead of the way
  `CloseBatch` and capture do (ARCHITECTURE "Settlement": rates come from
  `fee_schedules`, falling back to `merchants.mdr_bps`).
- **Breaks:** a 1,000 BD batch closed at 22.500 BD on a 225 bps schedule went
  to 25.000 BD (+2.500 BD charged to the merchant). With the tier active,
  every merchant's 1,000 BD batch went from 23.500 BD to 25.000 BD
  (+1.500 BD). A real rate change on a scheduled merchant landed on the wrong
  figure (back-dated 200 bps row: 25.000 BD instead of 20.000 BD).
- **Fix:** `recomputeBatchFee` now does exactly what `CloseBatch` step 8 does
  for each event: the schedule row in force at the event's `occurred_at`
  (`mdr_bps` as fallback), less the tier bonus, through `ComputeSettlementFee`.
  That function applies the negotiated discount to the amount first, the same
  discount-first rule capture has used since b068fdf. It is the smallest
  change because it reuses the exported helpers `CloseBatch` already calls,
  so the two cannot drift apart. The tier is read when the recalculation runs.
  It is platform-wide and not stored per batch, so it counts as part of the
  "current terms" the recalculation applies (`ADMIN.md`).
- **Test:** `recalculate_mdr_rate_test.go`. These cases cover a no-change run
  on a schedule (22,500 stays), on the tier (23,500 stays), and on schedule +
  tier + 10% discount (18,900 stays), plus a back-dated schedule change
  (22,500 → 20,000). Before the fix the no-change runs moved the fees to
  25,000, 25,000 and 22,500, and the schedule change moved it to 25,000.

## R2. Recalculated figures never reach reporting — Medium

**Where:** `recalculate_mdr.go`, after `UPDATE settlement_batches`.
**Evidence:** `CloseBatch` enqueues `settlement.batch_closed` with gross, fee
and net. `RecalculateMDR` rewrote `fee_fils`/`net_payout_fils` and enqueued
nothing. `apps/reporting` reads only the outbox (`REPORTING_EVENT_TYPES`) and
builds `merchant_payout_trends` from that payload.

- **What:** after a recalculation, the merchant's payout trends still show
  the old fee and net.
- **Why:** ARCHITECTURE says reporting is "fed from the outbox" and that an
  outbox row is inserted in the same transaction as the write that produced
  it. The recalculation's write produced no outbox row.
- **Breaks:** dashboards and finance views built on reporting disagree with
  `settlement_batches` permanently. **Rebuild analytics** replays the same
  outbox, so it brings back the same stale figures.
- **Fix:** each adjusted batch gets a `settlement.batch_closed` row with its
  corrected figures, built by `buildBatchClosedPayload` in the same
  transaction. No consumer change is needed. Reporting's `applyBatchClosed`
  upserts per batch (`ON CONFLICT … DO UPDATE`) and both the live pass and
  rebuild apply events in id order, so the newest figures win. The webhook
  dispatcher stopped delivering `settlement.batch_closed` in February, so
  merchants get no extra webhook. A new event type would have needed changes
  in `packages/events` and in reporting, and the reporting consumer silently
  skips any type it does not list.
- **Test:** `recalculate_mdr_outbox_test.go`. After closing at 250 bps and
  recalculating at 300 bps, there are two events for the batch and the newest
  carries 30,000 / 970,000. A second, no-change run adds none. Before the fix
  there was still one event, carrying 25,000 / 975,000.

## R3. Correction legs dated today instead of the corrected period — Medium

**Where:** `recalculate_mdr.go`, `postMdrAdjustment`.
**Evidence:** both legs were inserted with `occurred_at = now()`. ARCHITECTURE
"The ledger": "Corrections are new entries posted with the effective date of
the period they correct."

- **What:** recalculating an April batch in October booked the difference in
  October, while the April batch's `fee_fils` was rewritten.
- **Why:** the code comment chose `now()` so that no closed period would be
  "reopened". No period lock exists on `ledger_entries`, and the result
  contradicts the documented rule.
- **Breaks:** April's fee revenue no longer ties to April's batch, and
  October carries an adjustment with no October batch behind it.
- **Fix:** the legs are dated at Asia/Bahrain midnight of the batch's
  business day (`BusinessDayWindow(batch_date)` start). Admin credits use the
  same anchor for their effective date (`credits.ts`). The balance rebuild and
  refresh do not filter by `occurred_at`, so their totals are unchanged.
- **Test:** `recalculate_mdr_period_test.go`. Both legs are dated at the start
  of the batch's business day, and fee revenue booked in that day equals the
  rewritten `fee_fils` (30,000). Before the fix the legs were dated at
  run time and the day's revenue stayed at 25,000.

## R4. A batch whose events do not add up is re-rated to a zero fee — Medium

**Where:** `recalculate_mdr.go`, `recomputeBatchFee`.
**Evidence:** on a freshly seeded database, a no-change recalculation of
2026-08-31 on the base code gave these adjustments: Alpha Retail −183.174 BD,
Beta −89.888, Gamma −196.543 and Delta Wholesale −185.234. The seed writes
those closed batches directly and never links their `transaction_events`.
Delta Wholesale's 60 batches that are linked recalculated with no adjustment.

- **What:** the fee is re-derived only from events that carry the batch's id.
  If none (or only some) do, the missing activity is priced at zero.
- **Why:** nothing checked that the linked events still account for the
  batch's frozen gross.
- **Breaks:** each such run refunds the merchant's whole fee (credits
  `merchant_payable`, rewrites the batch). In this environment, recalculating
  any of the four seeded merchants over 31 August hits it.
- **Fix:** `recomputeBatchFee` also returns the linked events' gross. If that
  differs from `gross_fils`, `RecalculateMDR` returns
  `ErrBatchEventsIncomplete` and commits nothing. `CloseBatch` freezes gross
  as exactly that sum, so every batch it closed still recalculates.
- **Test:** `recalculate_mdr_unlinked_test.go`. A closed 1,000 BD batch with an
  unlinked capture now returns the error and leaves the batch, the ledger and
  the outbox untouched. Before the fix its fee moved from 25,000 to 0.

## R5. `merchant_balances.last_settlement_batch_id` rewound — Low (fixed by the settlebal merge)

**Update:** fixed by `agent/settlebal` (merged `4847022`): `RecalculateMDR` now moves the cache with `balances.ApplyLedgerDelta`, which does not touch the pointer. Regression test `recalculate_mdr_pointer_test.go` fails on `57d78d3` (pointer = the older batch) and passes now. The original write-up follows.

**Where:** `recalculate_mdr.go` calls `balances.ApplyBatchClose(…, b.id, -diff)`.
**Evidence:** `ApplyBatchClose` sets `last_settlement_batch_id = $3`. After
`TestRecalculateMDR_OutOfRangeBatchUntouched`, the merchant's pointer is the
2026-04-05 batch although 2026-04-09 is newer (checked in the test database).

- **What:** a recalculation points the cache's "last settlement batch" back to
  the older batch it corrected.
- **Why:** `ApplyBatchClose` is written for batch close ("called once, inside
  CloseBatch's own transaction") and is reused here only for its delta.
- **Breaks:** only the console's merchant view (`admin/merchants.ts`) reads
  the column, so the effect is a wrong display. The cached balance itself
  moves correctly.
- **Fix:** not applied. No ADR or ARCHITECTURE text defines this column, so
  it falls outside the "fix where the docs specify" rule. Suggested fix: apply
  the delta with a cache update that does not touch `last_settlement_batch_id`.
- **Test:** none added.
