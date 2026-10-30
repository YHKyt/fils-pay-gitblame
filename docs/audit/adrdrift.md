# ADR and architecture drift (adrdrift)

Scope: every decision in `docs/adr/*` and every concrete statement in
`docs/ARCHITECTURE.md` and `docs/HANDOVER.md`, checked against the code on
`fix/money-parsing`. Statements already covered by another write-up in this
folder were skipped. Each finding below was reproduced with a run before it
was fixed.

## AD1. Journaled credits and adjustments were never paid out or collected — High

**Where:** `apps/settlement/internal/settlement/batch.go` (`CloseBatch`), new
`batch_corrections.go`, new `db/migrations/0113_settlement_batch_corrections.sql`.
The postings come from `apps/api/src/admin/credits.ts:157-176` (admin credit) and
`apps/api/src/admin/ledgerAdjustments.ts:17-31` (CSV adjustment import and
`adjustMerchantBalanceJournaled`).

**Evidence:** merchant with a 100,000 fils capture (net 97,500 at 250 bps), a
20,000 fils admin credit with a 500 fils MDR reversal, and a -5,000 fils CSV
adjustment, all on 10 June. Old code: day-1 net payout 97,500, day-2 net 0, and
after both payouts `merchant_payable` is still 16,500 fils
(`batch_corrections_test.go:86` "day 1 net payout = 97500, want 113000",
`:97` "merchant_payable after both payouts = 16500, want 0"). New code: day 1
pays 113,000, `merchant_payable` and the cache end at 0.

- **What:** an admin credit or a journaled balance adjustment credits or debits
  `merchant_payable`, but no settlement batch ever picked it up. The merchant
  was never paid the credit, and a negative adjustment was never collected.
  The amount sat in `merchant_payable` (and in the cached balance) for good.
- **Why:** ADR-0006 separates two kinds of correction. A display correction
  touches only the cache and is "not money". The journaled variant is for "a
  real money correction" that finance approved, and ARCHITECTURE "The ledger"
  makes `ledger_entries` the record of money movements. `CloseBatch` computes
  the payout only from capture events, refunds and carried shortfalls, so a
  journaled correction was treated like a display correction: booked, shown on
  the console, never settled. The console help (`ADMIN.md` "Money") and our own
  `adminmoney.md` both assume a credit reaches the next settlement.
- **Breaks:** every goodwill or dispute credit issued through the console, and
  every CSV import row, is owed but never paid (or never collected). The
  merchant's balance grows by each one, reconciliation shows each one as an
  unexplained gap, and finance believes the money went out.
- **Fix:** `CloseBatch` claims the merchant's unsettled correction groups and
  adds their signed `merchant_payable` total to the batch net, exactly the way
  it already claims refunds. A correction group is one that moves
  `merchant_payable` with no transaction and no batch and is funded by one of
  the two correction contra accounts (`merchant_credit_contra`,
  `manual_balance_adjustment_contra`). That keeps every other unbatched posting
  out, notably groups from the pre-fix March sweep (M13), which charged
  merchants against `scheme_rounding_residue` and must not now be collected.
  There is no lower date bound, as for refunds, so a backdated credit is
  settled by the next close instead of never.
  - `ledger_entries` is append-only (0092), so the claim cannot be stamped on
    the legs. Migration 0113 adds `settlement_batch_corrections`, one row per
    claimed entry group with the group as primary key, written in the
    close's own transaction (`INSERT ... ON CONFLICT DO NOTHING`), so a group
    settles exactly once even under concurrent closes. New table only, safe on
    a populated database.
  - The callers already move the cache when they post, so the close adds
    `ownNet - corrections` to the cache and the payout subtracts the full net:
    the cache ends equal to the ledger.
  - Smallest change: one claim query beside the refund claim, one term in the
    net, one in the cache delta. No API change, nothing in the TypeScript
    callers.
  - Existing unsettled corrections are still owed, so on first deploy each
    merchant's next close pays them. Finance should expect that one-off.
  - If `agent/settlebal` (cache moves with every `merchant_payable` posting) is
    merged later, the cache term here must follow its rule; the ledger and
    payout figures do not change.
- **Test:** `apps/settlement/internal/settlement/batch_corrections_test.go`
  - `TestCloseBatch_PaysJournaledCreditsAndCollectsDebits`: day 1 net 113,000
    (97,500 + 20,500 - 5,000) and payout legs 113,000; a credit dated day 2 is
    paid by day 2 only; day 3 pays nothing (no double claim);
    `merchant_payable` and the cache end at 0.
  - `TestCloseBatch_BackdatedCreditSettlesOnNextClose`: a credit issued after
    its effective day closed is paid by the next close.
  - `TestCloseBatch_IgnoresOtherUnbatchedPayablePostings`: a March-sweep style
    `merchant_payable` / `scheme_rounding_residue` group is not deducted.
  - Before (old `batch.go`): the first two fail with the lines quoted above
    (backdated: "day 2 net payout = 0, want 7000", "merchant_payable = 7000,
    want 0"). After: all pass.

## Checked, not changed

- **Two roundings for a discounted fee** (ADR-0001 item 4, "one rounding").
  `ComputeSettlementFee` (Go) and `capture.ts` round the discount and then the
  MDR, each half-to-even. A single rounding of `amount x (10000 - discount) x
  mdr / 10^8` differs by 1 fil on about 1% of amounts (50 bps discount at
  250 bps: 2,500 of 1..200,000 fils, first at 60 fils: 2 vs 1). Capture and
  settlement agree with each other, and the booked fee is what settles, so
  this is a pricing-policy question for finance, not a ledger break.
- **Reconciliation and backdated credits.** With AD1 a credit is settled by the
  batch that claims it. A credit backdated into an earlier, already closed day
  shows as +gap on that day and -gap on the claiming day; a range covering
  both explains to zero. Same-day credits now explain.
- **Migration numbers 0054-0056** are reused although ADR-0005 reserves them.
  `db/migrate.ts` tracks applied files by full filename, so a database that
  ran an abandoned 0054 still applies `0054_views.sql`. Renaming applied
  migrations would be the riskier change.
- **`FEATURE_ASYNC_CLOSE`** (ARCHITECTURE "Operations") is not read anywhere.
  Documentation only.
- **Dead float helpers** against ADR-0001: `apps/api/src/fees/estimate.ts`
  (float rates, `Math.round`), `apps/api/src/lib/decimal.ts` (truncates extra
  decimals instead of rejecting), `EstimateMonthlyPayout` (float32). None has
  a caller, so nothing produces a wrong figure today.
- **Batch detail progress bar** (`apps/web/src/pages/settlement/SettlementBatchDetailPage.tsx:84`)
  converts `grossFils / 10000` through `toFixed(2)` / `parseFloat`. It only
  sets a bar width (full at 1,000 BD); no amount is shown from it.
