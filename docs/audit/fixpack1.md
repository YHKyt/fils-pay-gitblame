# Fix pack 1 — corrections to earlier fixes

Findings from the review round of our own fixes (rev3), each reproduced at the
`fix/money-parsing` tip, fixed with the smallest change and covered by a
regression test that fails on the old code and passes on the fix.

## FX1 One payment link can be captured twice after a capture throw — HIGH

**Where:** `apps/api/src/paymentLinks/pay.ts` (catch around `captureTransaction`, from fd93eb4).
**Evidence:** `pay.doubleCharge.test.ts` "a capture that throws after the acquirer approved cannot be followed by a second capture": old code answers the second payer `200` (`200 !== 409`) and the acquirer records two approved captures for one link.

- **What:** When `captureTransaction` threw, the catch put the link back to `reserved` with `transaction_id = NULL`. After the 60 s reservation timeout any payer could claim it again.
- **Why:** A throw does not mean "nothing happened at the acquirer". The capture runs the acquirer call and then journals inside one DB transaction; a DB failure after the acquirer approved (journal insert, commit, connection loss) rolls back our rows but not the acquirer's capture. Reopening the link on that unknown outcome is the unsafe direction.
- **Breaks:** Two cards are captured for one payment link; the first capture is invisible in our ledger.
- **Fix:** Remove the revert. On a throw the link stays `paid` against the authorized transaction (the safe direction: at worst a merchant has an authorization to capture or void from the dashboard). FX2 makes the public read and the pay endpoint report such a link as `processing` instead of `paid`. Deleting the block is the smallest change; no new state.
- **Test:** The existing test "a capture that throws does not leave the link showing paid" asserted the buggy revert (`reserved`, no transaction); it now asserts `paid` with the transaction kept. New test above uses a trigger that fails the `capture: gross` journal insert after the acquirer approved.

## FX2 A payment link reads 'paid' before any money moves — HIGH

**Where:** `apps/api/src/paymentLinks/status.ts` (`derivePublicStatus`), `read.ts`, `pay.ts` (`classifyClaimFailure`); `apps/web/src/pages/checkout/CheckoutPage.tsx`. Introduced by abdbc70 (finalize before capture).
**Evidence:** `pay.doubleCharge.test.ts` "while capture runs the link reads 'processing', not 'paid'" and the throw test: old code returns public status `paid` while the capture is held at the acquirer and after a capture throw, and the second payer gets `payment_link_already_paid`. `status.test.ts` "stored 'paid' whose transaction is still authorized" fails on the old helper.

- **What:** abdbc70 correctly moved the `reserved -> paid` finalize in front of capture so only one request can capture. But the public read and the pay endpoint's error path only looked at `payment_links.status`, so they reported `paid` from the moment of finalize.
- **Why:** `paid` on the link no longer implies the transaction was captured. If capture declines the link goes back to `active` (the customer was told it was paid); if the process dies between finalize and capture (or capture throws, FX1) the link says `paid` forever over an authorization that never settles.
- **Breaks:** A customer or merchant sees "paid" for money that never moved; a second payer is told "already paid" on a link that may yet reopen.
- **Fix:** Join the link's transaction. A `paid` link whose transaction is still `authorized` reads `processing` (public GET) and answers `409 payment_link_processing` (pay). The checkout's "processing" view now re-reads the link every 2 s instead of asking for a manual refresh, so its receipt only appears once capture landed (the lost-response poll already waited for `paid`, which now means captured). One optional field on the shared helper keeps read and pay consistent.
- **Test:** Two new DB tests (gated capture; capture throw) and two unit tests on `derivePublicStatus`.

## FX3 A refund retry after an acquirer timeout refunds the cardholder twice — HIGH

**Where:** `apps/api/src/payments/processRefund.ts` step 2 (the catch added by 97ded12 in our FP-300 hunt). **Lane note for B:** processRefund belongs to B's lane; the regression came from our own fp300hunt fix, so it is corrected here with a small hunk.
**Evidence:** `processRefundConcurrency.test.ts` "an acquirer that throws keeps the reservation and a same-key retry reuses the acquirer key": on the old code the step-1 reservation is released (`refunded_fils` 0) and the retry sends a second, different acquirer idempotency key (`${claimId}:2`), so an acquirer that had already processed the first call refunds again.

- **What:** On a thrown acquirer call (timeout, socket reset) the code released the reservation and failed the idempotency key. A retry with the same key re-validated, re-reserved and called the acquirer with `claimId:attemptCount`, a new key.
- **Why:** A timeout says nothing about whether the acquirer acted. The acquirer deduplicates on its idempotency key, but only if we resend the same one. Releasing the reservation also let a refund under a different key spend the same money while the first may already be paid out.
- **Breaks:** The cardholder is refunded twice; the merchant's payable and the platform's clearing account are short by the first, unrecorded refund.
- **Fix:** On a throw, keep the reservation and fail the key with a stored marker `{ acquirerOutcome: "unknown", acquirerIdempotencyKey, reservedFils }` (the client still sees `502 acquirer_unavailable`). A retry with the same Idempotency-Key that finds the marker skips re-validation and re-reservation and resends the stored acquirer key for the reserved amount; the acquirer returns its first answer. A definitive `declined` or `error` outcome on that retry releases the reservation as before. No schema change; `idempotency.ts` is untouched (the marker rides in the existing `response_body`).
- **Test:** The 97ded12 test asserted the release and a fresh retry; it now asserts the reservation is kept, one distinct acquirer key across both calls, one executed refund and `refunded_fils` 4000 (not 8000), plus a lost-request case that still completes on retry.

## FX4 Checkout changes its Idempotency-Key on an in-flight 409 — MEDIUM

**Where:** `apps/web/src/pages/checkout/CheckoutPage.tsx` (key rotation in the pay error handler), new helper `endsCheckoutAttempt` in `apps/web/src/utils/checkoutRecovery.ts`.
**Evidence:** `checkoutRecovery.test.ts` "an in-flight 409 keeps the checkout key": the old rule `statusCode < 500 => rotate` treated `409 payment_link_processing` and `409 request_in_progress` as final.

- **What:** Any 4xx from pay minted a new Idempotency-Key, including the two 409s that mean "a payment for this link is still in flight", which can be this customer's own attempt.
- **Why:** The pay endpoint's authorize key is derived from the client key. With a new key the customer's next click authorizes the card again instead of replaying the first authorization; once the first attempt finishes or its reservation lapses, one of the two authorizations is left holding the customer's funds.
- **Breaks:** Orphan authorizations (funds held on the card for the 7-day window) and confused customers.
- **Fix:** A small pure helper decides when an answer ends the attempt: 5xx, 429 and the two in-flight 409s keep the key; declines, `already_paid`, `canceled`, `expired` rotate it. Same rule as the dashboard's `isDefinitiveFailure`, plus the checkout's own 409 code.
- **Test:** Unit test on the helper (fails on the old code, where the rule did not exist).

## FX5 Expired link with an abandoned reservation: pay says 'processing' forever, read says 'active' — MEDIUM

**Where:** `apps/api/src/paymentLinks/status.ts` (`derivePublicStatus`), `pay.ts` (`classifyClaimFailure`).
**Evidence:** `pay.doubleCharge.test.ts` "an expired link with an abandoned reservation answers 410 and reads 'expired'" and `status.test.ts` "stored 'reserved' past the timeout on an expired link": old code answers pay `409 payment_link_processing` and the public read `active`.

- **What:** A link left `reserved` by a crashed attempt self-heals to claimable after the reservation timeout. If it also passed `expires_at`, the claim UPDATE refuses it (expired), but the classifier only checked expiry for `active` rows, so it reported "processing"; the public helper reported the lapsed reservation as `active` without looking at expiry.
- **Why:** Both paths treated "reservation lapsed" as "active" and forgot that an active link can be expired.
- **Breaks:** The checkout shows a payable form whose every Pay answers "a payment is already being processed"; the customer can never get the true answer (expired).
- **Fix:** A lapsed reservation on an expired link reads `expired` and pay answers `410 payment_link_expired`. A reservation still inside its timeout keeps `processing`, since that attempt may still finish.
- **Test:** One DB test, one unit test.
