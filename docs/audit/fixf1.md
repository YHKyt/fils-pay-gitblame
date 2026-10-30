# Fix round F1: amounts, currency, MDR rate, split shares

Items reported but not fixed in `apitxn.md`, `judgeprep.md` / `apihygiene.md`,
`moneyhunt.md` and `adminmoney.md`. Each fixed finding has a regression test that
fails on the code before the fix and passes after it. Items that were already
fixed, or that the documentation settles the other way, are listed at the end.

## FA1. Go ChildShares overflows int64 on large net payouts — Low

**Where:** `apps/settlement/internal/splits/shares.go` (`ChildShares`), called by `allocate.go` for split payouts.
**Evidence:** `go test ./internal/splits/ -run LargeNet` on the old code: `net 2000000000000001: shares [666600000000000fils 666600000000000fils 666800000000000fils] sum to 2000000000000000`.

- **What:** `net * sumW` and `net * c.WeightBps` were plain `int64` products. With weights summing to 10,000, `net * sumW` wraps once the net payout passes about 9.22e14 fils, so the target the shares must add up to was wrong.
- **Why:** this is the same class as `moneyhunt.md` N2 (`ApplyRateFils`). The API accepted any safe integer of fils (up to 9.007e15) before FA3, so such a net payout was reachable.
- **Breaks:** the children's shares no longer add up to the parent's net payout: a fil is lost at 2e15, and larger nets give garbage, even negative, shares.
- **Fix:** split the net into whole ten-thousands `q` and a remainder `r`. Then `net*w/10000 = q*w + r*w/10000`, where `q*w <= net` (weights are at most 10,000, CHECK in 0045) and `r*w < 1e8`. The floor and remainder per child, and the target, are the same numbers as before for every net that did not overflow. This is smaller than a `math/big` path and needs no new import.
- **Test:** `apps/settlement/internal/splits/shares_overflow_test.go` `TestChildShares_LargeNetDoesNotOverflow` (nets 1e15, 2e15+1 and 9,007,199,254,740,991; each share is its exact `math/big` floor or one more, and the shares sum to the net). Before: the failure above. After: `ok github.com/filspay/settlement/internal/splits`. The existing exactness tests still pass.

## FA2. A negative merchants.mdr_bps is accepted — Low

**Where:** `db/migrations/0002_merchants.sql` (`mdr_bps INTEGER NOT NULL DEFAULT 250`, no CHECK); fixed in `db/migrations/0119_merchants_mdr_bps_nonnegative.sql`.
**Evidence:** on the old schema `INSERT INTO merchants (display_name, mdr_bps) VALUES (..., -250)` succeeds. A throwaway probe then issued a 10.000 BD credit with `reverseFee: true` for that merchant: `"feeReversalFils":0` (no error, no reversal).

- **What:** `fee_schedules.mdr_bps` has `CHECK (mdr_bps >= 0)` (0048), but the merchant's own default rate has none, so a negative rate is stored as is.
- **Why:** every fee path guards it with `Math.max(0, ...)` (`capture.ts`, `credits.ts`) or `if < 0 { 0 }` (`batch.go`). The `moneyhunt.md` concern of a negative fee reversal therefore does not happen, but a mistyped `-250` silently means "charge no MDR" everywhere, and the admin console shows the negative rate.
- **Breaks:** platform fee revenue for that merchant, with no error to show anything is wrong.
- **Fix:** migration 0119 adds `CHECK (mdr_bps >= 0)` as `NOT VALID`, so every new INSERT or UPDATE is checked, and then validates it only when no row is negative. A database that already holds a negative rate still deploys; no rate is changed, and finance can correct the row and run `VALIDATE CONSTRAINT` later. Checked on a database with 3 negative rows: migration applied, constraint left unvalidated.
- **Test:** `apps/api/src/admin/merchantMdrBpsCheck.test.ts`. Before: `not ok 1 - merchants.mdr_bps rejects a negative rate`, `not ok 2 - ... rejects an UPDATE to a negative rate`. After: 3 of 3 pass (zero and the default are still accepted).

## FA3. No upper bound on amountFils — Low

**Where:** `apps/api/src/lib/requestParams.ts` (`parsePositiveAmountFils`, new `MAX_AMOUNT_FILS` and `isAcceptedAmountFils`), used by authorize and capture (`routes/transactions.ts`); also `paymentLinks/create.ts`, `routes/refunds.ts`, `admin/creditRequestValidation.ts`.
**Evidence:** old code, one merchant: authorize and capture 9,007,199,254,740,991 fils and 2 fils (both `201`/`200`), then `GET /v1/settlement/summary?from=2026-10-01&to=2026-10-31` returned `"totalCapturedFils":9007199254740992`, one fil short. `merchant_balances.cached_payable_fils` reached 17,564,038,546,748,832 with two such captures.

- **What:** every amount was accepted up to `Number.MAX_SAFE_INTEGER`, the minimum bound the code already enforced. Nothing stopped a merchant's sums from passing it.
- **Why:** each figure is a safe integer, but totals of a few of them are not. Postgres sums them exactly as BIGINT, and the API then turns the text into a JSON number, which above 2^53 can only hold even values (and coarser further up).
- **Breaks:** summaries, reconciliation and balances report wrong fil amounts, so the money totals a merchant sees stop adding up.
- **Product decision (no document defines a limit; `docs/API.md` is not in the repository):** one amount is at most `MAX_AMOUNT_FILS` = 10,000,000,000 fils (10,000,000.000 BD). It takes 900,000 maximum-size payments to reach the unsafe range. Each endpoint keeps its existing 400 code: `invalid_amount` for authorize, capture, payment links and credits, and `invalid_request` for refunds, with the limit in the message. Below the cap nothing changes.
- **Fix:** one shared predicate, used by the five checks that already rejected unsafe integers. No schema change.
- **Test:** `apps/api/src/routes/amountUpperBound.test.ts` (authorize, capture, payment-link create, refund, support credit; the cap itself is still accepted). Before: 4 of 4 fail (`expected: 400 actual: 201` for authorize and payment links, `actual: 404` for the refund, `Missing expected exception.` for the credit). After: 4 of 4 pass.

## FA4. The currency field is ignored — Medium

**Where:** `apps/api/src/routes/transactions.ts` (authorize, capture), `routes/paymentLinks.ts` (create), `routes/refunds.ts`; new `assertBhdCurrency` in `lib/requestParams.ts`.
**Evidence:** old code: `POST /v1/transactions {"amountFils":1500,"currency":"USD",...}` returns `201`, and the transaction is stored as 1,500 fils of BHD. A payment link with `"currency":"USD"` is also created (`201`).

- **What:** request bodies may carry `currency`, but no route read it. The platform is BHD-only (`transactions.currency CHECK (currency = 'BHD')`), so whatever was sent was settled as BHD.
- **Why:** an integration that sends its own currency (for example USD 15.00 as 1500 minor units) is charged in a different currency without any warning. 1 BHD is about 2.65 USD, so the cardholder pays about 2.65 times the intended price.
- **Breaks:** wrong charges for any multi-currency client, and refunds that seem to be in one currency but run in another.
- **Fix:** if `currency` is present it must be exactly `"BHD"`; otherwise `400 {"error":"unsupported_currency","message":"currency must be BHD"}`, raised before the acquirer is called. Leaving the field out works as before, so existing clients are unaffected.
- **Test:** `apps/api/src/routes/currencyBhdOnly.test.ts` (USD, lowercase, empty, null, number and object currencies on authorize, with zero acquirer calls; "BHD" and no currency still `201`; capture, payment link and refund reject USD/EUR). Before: `expected: 400 actual: 201` (2 of 2 fail). After: 2 of 2 pass.

## Checked, not changed

- **Split-capture fee avoidance (`apitxn.md`).** Reproduced: `applyRateFils(20, 250)` is 0, so 500 captures of 20 fils book 0 fils of MDR against 250 for one capture of 10,000. Not changed, because `docs/ARCHITECTURE.md` sets the rule: "Fees are computed per capture event, not per batch total." Settlement closes batches on the fee booked per event (`batch.go`), and the MDR recalculation (`recalculate_mdr.go` `recomputeBatchFee`) recomputes it per event, so a cumulative fee in `capture.ts` would be reversed as a "correction" at the next recalculation. The loss is under 0.5 fil per capture event, and each capture is a separate acquirer call. Closing it needs a finance decision on the fee model (a cumulative fee, or a minimum partial capture).
- **Refund validation error shape (`judgeprep.md` JP4, `apihygiene.md`).** Already fixed in `878cb70`: `processRefund.ts` `refundErrorBody` returns `{ error: code, message, ...details }`, and `processRefund.test.ts` asserts `body.error === "transaction_not_refundable"`. The other refund bodies (`refund_declined`, `acquirer_unavailable`, `transaction_not_found`) already use `error`, and `message` is optional in the shape (`lib/errors.ts`). `docs/API.md` is not in the repository, so the uniform `{ error, message? }` shape in `lib/errors.ts` is the reference.
- **Support credits have no daily cap (`adminmoney.md`).** No document defines one: `docs/ADMIN.md` sets only the 50.000 BD per-credit second-approver limit (principal only), and neither `ARCHITECTURE.md` nor any ADR mentions a daily or cumulative cap. Per the brief, it stays a finance/product decision. FA3 now bounds a single credit at 10,000,000.000 BD.
