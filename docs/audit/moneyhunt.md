# Money package and its Go mirror — findings (N1–N2)

Scope: every export of `packages/money` (`toFils`, `addFils`/`subtractFils`/`negateFils`/`compareFils`,
`bankersRoundDiv`, `applyRateFils`, `allocateRemainder`, `formatBhd`, `parseBhdToFils`,
`calculateRefundFee`), the Go mirror `apps/settlement/internal/money`, and their callers in `apps/**`
and `scripts/**`.

What was checked and found correct (with a run):

- Rounding mode matches ADR-0001 ("one rounding, half-to-even") on both sides. The "legacy" and
  "drift" tests that call half-even a "known gap vs finance sheet" assert the correct behaviour; they
  were left as they are.
- A table of 20,256 inputs (13 rates x 19 amounts up to `Number.MAX_SAFE_INTEGER`, 20,000 random
  `bankersRoundDiv` cases including negative numerators and denominators, and hand-picked ties) was run
  through the TypeScript functions with `tsx` and through the Go functions with a scratch `go test` in a
  copy outside the repo. The only disagreements were the 7 overflows described in N2; after the fix,
  0 mismatches.
- `parseBhdToFils` rejects "4.7550", "1e3", "4,75", "", ".5", "5.", "+4.75" and Arabic-Indic digits;
  accepts "-0.001" (-1) and signed values for adjustments; rejects values above the safe-integer range.
- `addFils` / `subtractFils` throw instead of returning an unsafe integer.
- Callers: the remaining manual conversions (`calculateMdrFeeV1`, `estimateFeeFils`,
  `parseDecimalMinor`) have no live importers; web and admin amount inputs are integer fils, matching
  the API; CSV and discount parsing already use `parseBhdToFils` (M3).

---

## N1. allocateRemainder misreads weights and is not proportional — Low
**Where:** `packages/money/src/fils.ts` (`allocateRemainder`)
**Evidence:** run before the fix:
`allocateRemainder(1_000_000_000_000, [1, 1.0000000004])` → `[500000000000, 500000000000]`;
`allocateRemainder(10, [1e-7, 0])` → `RangeError: weights must not all be zero`;
`allocateRemainder(10, [1e21, 1])` → `SyntaxError: Cannot convert 1e+21 to a BigInt`.

- **What:** the shares were not proportional to the weights the caller passed, and some valid weights
  made the call throw.
- **Why:** the function counted a weight's decimals from `w.toString()` by looking for a `"."`, capped
  that at 9, and scaled each weight with `toFixed(decimals)`. JavaScript prints numbers below 1e-6 and
  from 1e21 upward in exponent form ("1e-7", "1e+21"), which has no `"."`, so those were scaled with 0
  decimals: tiny weights became 0, and `toFixed` on 1e21 returns "1e+21", which `BigInt` cannot read.
  The 9-decimal cap rounded away every later digit, so `1` and `1.0000000004` became equal weights.
- **Breaks:** any pro-rata split built on the package's documented promise ("shares proportional to
  weights"). The sum still equalled the total, so the error was invisible to a sum check. No live app
  code calls this function today (no live callers, so this is a defensive fix), hence Low; settlement splits use their own Go `ChildShares` (M5).
- **Fix:** read each weight exactly from its shortest decimal form, including the exponent, as
  `digits x 10^exponent`, then bring all weights to the smallest exponent. Every digit is kept, no
  float arithmetic is introduced, and ordinary weights give the same results as before. This replaces
  one helper and five lines; the allocation algorithm itself is unchanged.
- **Test:** `packages/money/src/allocate_weights_exact.test.ts`. Before the fix: 3 of 4 tests fail
  (`AssertionError`, `RangeError`, `SyntaxError`). After: 4/4 pass, and the existing
  `allocate_drift_known.test.ts` cases still pass.

## N2. Go ApplyRateFils wraps on int64 overflow and returns a negative fee — Low
**Where:** `apps/settlement/internal/money/fils.go` (`ApplyRateFils`)
**Evidence:** TypeScript vs Go table (see above), 7 mismatches before the fix, for example
`ApplyRateFils(1_000_000_000_000_000, 10000)`: TS `1000000000000000`, Go `-844674407370955`;
`ApplyRateFils(9_007_199_254_740_991, 5000)`: TS `4503599627370496`, Go `814250812628585`.

- **What:** the Go fee function and the TypeScript one disagree on large inputs, and the Go result is
  garbage (often negative).
- **Why:** the Go port computes `amount * rateBasisPoints` in `int64`. The TypeScript original uses
  `bigint` for exactly this product and throws if the result is out of range. Go does not trap integer
  overflow, so once the product passes 9.2e18 it silently wraps. The file's comment ("int64 covers
  amount*rateBasisPoints at any realistic scale, so there are no bigint intermediates here") is the
  assumption that failed. With a 10,000 bps rate (the maximum `negotiated_discount_bps`, applied to the
  amount in `ComputeSettlementFee`) the limit is about 922 billion BD.
- **Breaks:** fee and discount figures for any batch line above that size: a negative fee would raise
  the payout. Not reachable at today's volumes, hence Low; it is the one place where the "Go mirrors TS
  exactly" contract does not hold.
- **Fix:** when the product would overflow, do the same half-even division in `math/big`; if the
  result itself does not fit `int64`, panic rather than wrap (the TypeScript side throws). The normal
  `int64` path is unchanged, so no existing result moves.
- **Test:** `apps/settlement/internal/money/overflow_test.go` (expected values are the TypeScript
  results, plus ordinary half-even cases). Before the fix: 7 failures, e.g.
  `ApplyRateFils(1000000000000000, 10000) = -844674407370955, want 1000000000000000`. After: pass; the
  20,256-row comparison reports `mismatches=0`.

---

## Reported, not fixed (other lanes)

- `apps/settlement/internal/splits/shares.go` `ChildShares`: `net * c.WeightBps` and `net * sumW` use
  the same unchecked `int64` product as N2 (overflow above about 922 billion BD of net payout). Same
  class, same Low severity; left to the splits owner.
- `apps/api/src/admin/creditThreshold.ts`: `applyRateFils(baseAmountFils, mdrBps)` with
  `merchants.mdr_bps`, which has no CHECK (0002) unlike `fee_schedules.mdr_bps >= 0` (0048). A negative
  `mdr_bps` would give a negative fee reversal. Not reproduced end to end (admin lane).
