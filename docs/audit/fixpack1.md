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

## FX6 A malformed card on the public pay route answers 500 — LOW-MEDIUM

**Where:** `apps/api/src/routes/paymentLinks.ts` (`POST /v1/payment-links/:token/pay`).
**Evidence:** `routes/paymentLinks.test.ts` "pay with a malformed card is a 400 invalid_card": old code answers 500 for `{}`, a string card, an array, a numeric or null pan, and a 4-digit pan.

- **What:** The route only checked `if (!card)`. The acquirer calls `card.pan.endsWith(...)`, which throws a TypeError for a non-string pan.
- **Why:** The same gap apitxn closed on `POST /v1/transactions` (6344efb) also exists on the public, unauthenticated checkout route, which anyone can hit.
- **Breaks:** 500s on a public endpoint, and the thrown authorize leaves the link `reserved` until the reservation timeout, blocking real payers for 60 s per malformed request.
- **Fix:** The same 12-19 digit string check as authorize, answering `400 invalid_card` before the link is claimed.
- **Test:** Six malformed cards give 400 and the link stays `active` and payable.

## FX7 NUL characters, out-of-range time zones and bad signup values answer 500 — LOW-MEDIUM

**Where:** new `apps/api/src/plugins/rejectNul.ts` (registered in `app.ts`), `plugins/errorHandler.ts` (`isPgInvalidInput`), `routes/reporting.ts` (`assertValidReportFilter`), `routes/businessProfile.ts` (signup).
**Evidence:** `routes/inputHygiene.test.ts`: on the old code a NUL gave 500 on payment-link reference/description, API key label, business profile PATCH, webhook url, saved filter name and body, signup legal name and email, the report filter; `+275760-09-13T00:00:00Z` in a report filter and a report cursor with offset `+99` gave 500 (Postgres 22009); signup `businessType: "corp"` (23514) and `country: "BHR"` (22001) gave 500.

- **What:** Postgres `text`/`jsonb` cannot hold U+0000 (22021 / 22P05). Routes validated types and lengths but not NUL; apitxn and the refund route added per-field NUL checks for their own fields only. JavaScript's `Date` accepts the extended year and odd offsets that Postgres then rejects with 22009, which the error handler did not map. Signup did not apply the PATCH route's businessType and country rules.
- **Why:** Each surface needed its own check, and new fields kept missing it.
- **Breaks:** 500s (and error-log noise) on public and merchant endpoints from a single byte; monitoring cannot tell them from real crashes.
- **Fix:** One `preValidation` hook rejects a NUL anywhere in params, query or JSON body with `400 invalid_request`; the JSON-encoded report filter is checked after it is parsed. 22009 joins 22007/22008 in the narrow "invalid input reached the database" net (400). Signup applies the same businessType set and two-letter country rule as PATCH. Signup is in B's onboarding lane; the hunk is a two-check validation only.
- **Test:** One test per surface type (body field on each route, query value, JSON-in-query, 22009 filter and cursor, signup values), plus a unit test on `containsNul`.

## FX8 The manual close guard has no grace at Bahrain midnight — LOW

**Where:** `apps/settlement/internal/settlement/business_day_guard.go` (`RequireBusinessDayOver`, from 37348d1), `apps/api/src/routes/admin.ts` (run-batch guard), new `apps/api/src/lib/businessDay.ts`.
**Evidence:** `TestRequireBusinessDayOver` "exactly Bahrain midnight is refused" and "one ns before the close grace ends is refused" fail on the old guard; `lib/businessDay.test.ts` fails with a zero grace (the old route rule).

- **What:** Both guards allowed closing day D from the exact instant of Asia/Bahrain midnight (21:00Z).
- **Why:** `CloseBatch` scans day D's window once and a closed day is never re-scanned. A capture whose row is stamped 23:59:59.999 can still be committing a moment after midnight; a manual close that starts in that gap does not see it.
- **Breaks:** That capture is stranded: never in any batch, never paid out.
- **Fix:** Require the day to have ended at least 2 minutes ago (`BusinessDayCloseGrace` in Go, `BUSINESS_DAY_CLOSE_GRACE_MS` in the API; the daemon already waits 15 minutes by default). The test case that asserted "exactly midnight is allowed" now asserts refusal.
- **Test:** Go table cases at midnight, grace minus 1 ns and grace; a TS unit test on the extracted date helper.

## FX9 Compose kills the settlement daemon mid-drain; hosted links default to localhost — LOW (ops)

**Where:** `ops/docker-compose.yml` (settlement service, api `CHECKOUT_BASE_URL`), `ops/.env.example`, `ops/README.md`.
**Evidence:** `docker compose config` on the old file: no `stop_grace_period` on settlement (compose default 10 s), and with `CHECKOUT_BASE_URL` unset the api silently gets `http://localhost:8080`. On the new file the same command refuses with "required variable CHECKOUT_BASE_URL is missing a value: set in ops/.env"; with `.env.example` copied it resolves to `http://localhost:8080` and shows `stop_grace_period: 40s`.

- **What / Why:** `cmd/settlement/main.go` drains an in-flight admin request for up to 30 s on SIGTERM, but compose SIGKILLs after 10 s, so a redeploy during a manual batch kills it mid-run. A forgotten `CHECKOUT_BASE_URL` on the hosted box produced payment links pointing at `localhost` with no error.
- **Breaks:** Interrupted batches on redeploy; customers of the hosted demo get links they cannot open.
- **Fix:** `stop_grace_period: 40s` on settlement; `CHECKOUT_BASE_URL` uses `:?` like the secrets, and `.env.example` now sets the local value so a local `cp ops/.env.example ops/.env` keeps working.
- **Test:** The `docker compose config` runs above (no code path to unit test).

## FX10 The e2e judge suite fails correct batches after a refund or carry-forward — LOW

**Where:** `ops/e2e/judge-suite.mjs` (batch consistency check).
**Evidence:** Running the old and new predicates over sample batch DTOs: a batch with a 40 000 fils refund (gross 100 000, fee 2 500, net 58 500) and a batch with a carried-in shortfall (net -29 250) are flagged by the old check and pass the new one; an overpaying batch (net 98 000 > gross - fee) is flagged by both.

- **What:** The check required `net == gross - fee` (or `- refunds` when a refund field exists). The batch DTO has no refund or carry-in field (documented in b361d1a), so every batch that deducted a refund or carried in a shortfall failed.
- **Why:** The suite encoded the pre-FP-300 invariant.
- **Breaks:** Our own smoke run reports a failure for correct money, hiding real ones in the noise.
- **Fix:** Exact check `gross - fee - refunds + carriedIn == net` when a DTO itemises both; otherwise the bound that always holds, `net <= gross - fee` (refund deductions are never negative, a carried-in balance is never positive), which still catches an overpaying batch.
- **Test:** The sample-predicate run above (the suite needs a live stack).
