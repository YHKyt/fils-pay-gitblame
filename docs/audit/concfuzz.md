# Concurrency fuzzing of the money operations (concfuzz)

A throwaway harness (not committed) drove the real API in-process through
`app.inject` against a migrated Postgres: random concurrent mixes of
authorize, partial and full capture, void, partial and full refund (same and
different Idempotency-Keys, both refund routes), payment-link create, pay
(1 to 4 concurrent payers, same and different keys, approving, declining and
erroring cards) and cancel. The acquirer simulator ran with a 15-20% failure
rate, and a wrapper made a share of acquirer capture and refund calls throw
after the acquirer had processed them (a timeout with an unknown outcome).
It recorded every distinct acquirer key the simulator acted on, so the
acquirer's own view of captured and refunded money could be compared with the
database.

After every round it asserted: every ledger entry group balances;
`captured_fils <= amount_fils`; `refunded_fils <= captured_fils`;
`refunded_fils` equals the succeeded refunds plus the reservations of refunds
whose acquirer outcome is unknown; merchant_payable capture, fee, refund and
fee-reversal legs equal the transaction, event and refund rows; the status
equals `nextStatusAfterRefund` of the money columns; no active hold on a
voided or fully captured transaction; the acquirer captured exactly what the
database captured; at most one captured transaction per payment link; and an
idempotent replay returns the same status and body (compared as canonical
JSON, since `jsonb` reorders keys). Roughly 20,000 API operations ran in total
(single runs of 2,400 to 3,200 operations, seeds 1, 2, 3, 31, 99, 777, 4242).

Settlement was exercised with a throwaway Go test: 15 merchants, three
consecutive business days of captures and refunds each (refunds dated the
same or a later day), and twelve concurrent `RunDailyBatch` calls per
merchant over those days. Every capture event and refund was settled exactly
once, three batches per merchant, all paid, no duplicate payout legs, and the
payout legs plus the remaining merchant_payable equalled gross - fee -
refunds + fee reversals exactly. Concurrent same-key credit creation and
concurrent approve/reject of one credit request (360 operations) also held:
one request, one winner, one ledger group.

## CF1. Capturing the rest while a refund is in flight reports a refund that never happened — Medium

**Where:** `apps/api/src/payments/capture.ts` (status derivation after capture)
**Evidence:** `apps/api/src/payments/capturePendingRefund.test.ts`: capture 4,000 of 10,000, start a 4,000 refund and hold it at the acquirer, capture the remaining 6,000, decline the refund. Before the fix the row read `partially_refunded` with `refunded_fils = 0` and no refund row (`actual: 'partially_refunded'`, expected `captured`).

- **What:** capture computed the new status from `transactions.refunded_fils`.
- **Why:** `processRefund` reserves its amount in `refunded_fils` before calling the acquirer and releases it on a decline or error. A capture landing in that window treats the reservation as a refund that already happened. The journal step of `processRefund` already avoids exactly this by counting only succeeded refunds; capture did not.
- **Breaks:** a fully captured transaction with nothing refunded reads `partially_refunded` in the dashboard, list filters, exports and the `transaction.captured` webhook payload, until some later refund recomputes it.
- **Fix:** derive the refunded total from `SUM(refunds.amount_fils) WHERE status = 'succeeded'`, read under the capture's row lock. One query, the same rule the refund path uses.
- **Test:** `capturePendingRefund.test.ts` fails before (status `partially_refunded`) and passes after.

## CF2. A payment link leaves an earlier customer's authorization open after someone else pays — Medium

**Where:** `apps/api/src/paymentLinks/pay.ts` (success path), `apps/api/src/paymentLinks/cancel.ts`
**Evidence:** fuzz rounds left links `paid` (and `canceled`) next to a second transaction still `authorized` with an active hold. `pay.orphanAuth.test.ts` tests 1 and 2: customer A's capture meets an acquirer error (502), customer B pays the link (200), A's retry is 409; before the fix A's transaction stayed `['authorized', 1 active hold]` (same after a merchant cancel).

- **What:** on a capture 502 the link is reopened and the authorization is kept so the same Idempotency-Key can retry. Nothing released it when that retry could no longer happen.
- **Why:** the only code that voids a pay attempt's authorization runs on that attempt's own request. Once another attempt pays the link, or the merchant cancels it, the kept authorization has no owner.
- **Breaks:** the first customer's funds stay held for the 7-day authorization window for a purchase they did not get, and the merchant sees a capturable authorized transaction for an already paid link (capturing it charges two customers; see CF3).
- **Fix:** after a successful pay, and after a cancel, void the link's other authorizations. They are found through their authorize idempotency keys (`paylink:<link id>:<key>:authorize`, `resource_id` = transaction); `voidTransaction` leaves anything no longer `authorized` alone. On the pay path it is best effort, since the payment itself has already succeeded.
- **Test:** `pay.orphanAuth.test.ts` tests 1 and 2 fail before, pass after.

## CF3. A link whose kept authorization the merchant captured can be paid again — High

**Where:** `apps/api/src/paymentLinks/pay.ts` (claim UPDATE, capture-failure reopen, claim-failure classification)
**Evidence:** `pay.orphanAuth.test.ts` test 3: customer A's capture meets an acquirer error, the merchant captures A's authorized transaction (200), customer B pays the same link. Before the fix B's pay answered `200` (expected 409): two captured charges for one single-use link.

- **What:** after the 502 the link is `active` again with no reference to A's transaction, so capturing that transaction by hand did not make the link paid. The same happened if the merchant's capture landed between pay's finalize and pay's own capture: pay's capture answered `not_capturable` and the link was reopened although its money had moved.
- **Why:** the link row is the only thing the claim checks, and the reopen step assumed "capture did not answer 200" means "nothing was captured".
- **Breaks:** the single-use guarantee: a second customer is charged for the same link.
- **Fix:** the claim also requires that no attempt under another Idempotency-Key has a captured transaction (a same-key retry may still finalize its own attempt, which an existing test relies on); a failed capture no longer reopens a link whose transaction is captured; the claim-failure path answers `409 payment_link_already_paid` for such a link.
- **Test:** `pay.orphanAuth.test.ts` test 3 fails before (200), passes after; all payment-link suites stay green.

## Reported, not fixed (Claude B's lane: payments/idempotency.ts and its callers)

### Two concurrent retries with one Idempotency-Key both execute after a failed attempt — Critical

**Where:** `apps/api/src/payments/idempotency.ts`, `claimIdempotencyKey`, the `failed` branch (`UPDATE ... WHERE id = $1`).
**Evidence:** a throwaway repro script (attempt 1 gets an acquirer `error`, then two concurrent retries with the same key): `double capture under one key in 39/40 trials`, `captured_fils=8000` for one 4,000 capture request, two journal groups, three acquirer calls. The refund variant: `double refund under one key in 19/20 trials`, two refund rows totalling 6,000 for one 3,000 request, three distinct acquirer keys. Seen first in the fuzz as a capture key replaying `capturedFils 687` while another answer for the same key said `1374`, and as one authorize key returning two different transaction ids.

- Both retries read the row as `failed`; the first UPDATE takes the row lock, the second waits and then updates the row again (its WHERE has no status condition), so it also returns `retry_after_failure` with a new attempt number and runs the operation a second time.
- Proposed fix (verified locally, 0/40 and 0/20): `WHERE id = $1 AND status = 'failed'`; when no row comes back, classify again (`return claimIdempotencyKey(client, input)`), which yields a replay once the first retry completed or `conflict_in_progress` while it runs.

### Same-key retry after a thrown capture or authorization charges again — High

Already fixed on `origin/b/h4-idempotency` (9df2ebd, not merged into fix/money-parsing at the time of writing): the claim row is rolled back with the acquirer call, so the retry got a new row id and hence a new acquirer key. The fuzz reproduced it (acquirer captured exactly twice what the database recorded) and the residual below with that patch applied.

### Residual: another operation after a thrown capture (unknown outcome) — Medium (design)

With the h4 patch applied, a capture under a different key or a void that waited on the row lock behind a thrown capture still proceeds: the acquirer captured 2,168 under the thrown attempt and 5,365 under the next key, while the database recorded 5,365; or the transaction was voided locally while the acquirer had captured it. Capture keeps no durable record of an in-flight acquirer call (unlike refunds, which reserve before the call), so nothing blocks the next operation. Closing it needs a refund-style reservation for captures; not a minimal fix.

## Checked, no violation found

- Refunds: concurrent same-key and different-key refunds, both routes, with declines, errors and thrown calls (unknown-outcome marker and retry): refunded_fils, refund rows, fee reversals and the acquirer's refunded amount always agreed.
- Payment links: concurrent payers with same and different keys, lease takeovers (1 s reservation), cancels racing pays: never more than one captured transaction per link once CF2 and CF3 are in place.
- Void racing capture: serialised by the row lock; voided rows never carry captured money or an active hold.
- Settlement: concurrent closes and payouts of the same and adjacent days, refunds and carried shortfalls claimed exactly once.
- Admin credits: same-key create and concurrent approve/reject.
