# Transactions API: authorize, capture, void, list (apitxn)

Scope: `apps/api` transactions routes (`routes/transactions.ts`), the
authorize/capture/void state machine (`payments/authorize.ts`,
`payments/capture.ts`, `payments/void.ts`), holds, and the transaction
list/detail/export. Every finding below was reproduced with a run against a
real, migrated Postgres before it was fixed, and each fix ships with a
regression test that fails on the pre-fix code and passes on the fix.

---

## TX1. A NUL byte in `reference` authorizes the card but records no transaction — High

**Where:** `apps/api/src/routes/transactions.ts` (authorize route); the failure surfaces at the `INSERT INTO transactions` in `apps/api/src/payments/authorize.ts`.

**Evidence:** three `POST /v1/transactions` calls with the same Idempotency-Key and `{"amountFils":10000,"card":{...},"reference":"order\u00001"}` each returned `500 {"error":"internal_error"}`. The acquirer approved all three (`acquirer approvals 3`), and the database held `transactions rows 0`, `idem rows 0`.

- **What:** `reference` was passed to the database unchecked. Postgres `TEXT` cannot store U+0000, so the transactions INSERT failed. A non-string reference (`123`, `{"a":1}`, `true`) was accepted and stored as its JSON text.
- **Why:** authorize calls the acquirer first and inserts the transaction afterwards, in the same database transaction. When the INSERT throws, `withTransaction` rolls back the transaction row, the hold and the idempotency claim. The acquirer's approval cannot be rolled back, and the simulator has no void. Because the claim rolled back too, a retry with the same key is a fresh claim with a new acquirer idempotency key, so every retry is another approval.
- **Breaks:** the cardholder's funds are held by authorizations that FilsPay has no record of, so nobody can capture, void or reconcile them. The merchant gets a 500 and retries, which adds one more hold each time. This is the same failure shape as fp300hunt F1 (NUL in a refund `reason`), but on the authorize path.
- **Fix:** the route rejects a `reference` that is not a string or contains U+0000 with `400 invalid_request`, before the acquirer is called. An omitted or `null` reference still means "no reference". This is the smallest change: one guard beside the existing required-field check, and no change to the authorize flow. The payment-link path passes the link's stored reference, which Postgres has already accepted, so it cannot carry a NUL.
- **Test:** `apps/api/src/routes/transactionsInputValidation.test.ts`, the "NUL byte in reference" and "non-string reference" tests: 400 on every attempt, zero acquirer calls, zero transaction rows, and a corrected request with the same key then succeeds (the key is not wedged).
  - Before: `expected: 400 actual: 500`; `expected: 400 actual: 201` (object reference).
  - After: pass.

## TX2. A malformed `card` on authorize is a 500 — Low

**Where:** `apps/api/src/routes/transactions.ts` (authorize route); it crashed in `apps/api/src/acquirer/simulator.ts` (`magicOutcomeForPan`).

**Evidence:** `card` set to `{}`, `"x"`, `[]`, `{"pan":4242}` or `{"pan":null}` each returned `500 internal_error`, with `TypeError: Cannot read properties of undefined (reading 'endsWith')` or `pan.endsWith is not a function` in the log.

- **What:** the route only checked that `card` was truthy.
- **Why:** the acquirer reads `card.pan` as a string (`pan.endsWith(...)`), so any other shape threw inside the acquirer call.
- **Breaks:** a client error is reported as a server error. Callers and monitoring see a 500 for bad input, and a client cannot tell that its own request was wrong. No money moves, because the throw happens before any approval.
- **Fix:** the route requires `card` to be an object whose `pan` is a string of 12 to 19 digits, and answers `400 invalid_card` otherwise, before the acquirer is called. This is the smallest change: one check, and only on the field the acquirer depends on.
- **Test:** `transactionsInputValidation.test.ts` "a malformed card is a 400 invalid_card": seven malformed shapes, zero acquirer calls, zero rows, and the valid card still authorizes.
  - Before: `expected: 400 actual: 500`.
  - After: pass.

## TX3. Capturing the rest of a refunded partial capture reports plain `captured` — Medium

**Where:** `apps/api/src/payments/capture.ts` (status computed after a capture).

**Evidence:** authorize 10,000, capture 4,000, refund 1,000 (status stays `partially_captured`, as `refundState.ts` intends), then capture the remainder. The response was `"status":"captured","capturedFils":10000,"refundedFils":1000`. The same happens after refunding all 4,000 first (`refundedFils: 4000`, status `captured`).

- **What:** capture set the status to `captured` whenever `captured_fils` reached `amount_fils`, and ignored `refunded_fils`.
- **Why:** status is derived from the money columns (`payments/refundState.ts`, `nextStatusAfterRefund`). A refund on a partially captured transaction deliberately keeps it `partially_captured` so the remaining authorization can still be captured. The refund is recorded only in `refunded_fils`, and capture never looked at that column.
- **Breaks:** the transaction says `captured` while money has already gone back to the cardholder. A `status=partially_refunded` filter on the list and the export misses it, the `transaction.captured` webhook reports `captured`, and the admin "recompute statuses" tool (which uses `nextStatusAfterRefund`) disagrees with what capture wrote.
- **Fix:** capture computes the new status with the same `nextStatusAfterRefund` rule, passing the authorized amount, the new captured total and the current `refunded_fils`, which are read under the existing row lock. Hold release and the timeline event type still key on "fully captured", so they are unchanged. This is the smallest change: one column added to the locked SELECT, and the existing rule reused instead of a second copy.
- **Test:** `apps/api/src/routes/captureAfterRefund.test.ts`, for refunds of 1,000 and 4,000: the final capture gives `partially_refunded` (in the response and from `GET /v1/transactions/:id`), the hold is `released`, the last event is `captured`, and refunding the rest ends at `refunded`. A full capture with no refund is still `captured`.
  - Before: `expected: 'partially_refunded' actual: 'captured'` (both cases).
  - After: pass.

## TX4. List search treats `_` and `%` as wildcards and a NUL is a 500 — Low

**Where:** `apps/api/src/transactions/query.ts` (`listTransactions`), `apps/api/src/routes/transactions.ts` (list route).

**Evidence:** for a merchant with references `order_1` and `orderX1`, `GET /v1/transactions?search=order_1` returned both rows, and `?search=%25` (`%`) returned every row. `?search=%00` returned `500 internal_error`.

- **What:** the search was put into `ILIKE '%' || $5 || '%'` without escaping. A NUL byte, or a repeated `?search=` (which arrives as an array), was passed straight to Postgres.
- **Why:** in a LIKE pattern, `_` matches any one character and `%` matches any run of characters. Postgres rejects U+0000 in text.
- **Breaks:** a merchant searching for an order reference gets other orders as well (references commonly contain `_`), and a stray character gives a server error.
- **Fix:** `\`, `%` and `_` are escaped with a backslash (the default LIKE escape character) before the query runs. A UUID contains none of them, so the exact-id branch is unaffected. The route answers 400 for a non-string or NUL-containing search. This is the smallest change: one parameter rewritten, and one guard.
- **Test:** `apps/api/src/routes/transactionsSearch.test.ts`: `order_1`, `r_1`, `50%`, `%` and `back\` match only themselves, case-insensitive substring search still works, `%00`, `a%00b` and a repeated `search` are 400, and an exact id still finds its row.
  - Before: `+ 'orderX1'` in the `order_1` result; `expected: 400 actual: 500`.
  - After: pass.

---

## Checked and correct (no change)

- Capture after void (`409 not_capturable`), void after capture or after a partial capture (`409 not_voidable`), and a second void (`200`, no new event).
- Three concurrent 6,000-fils captures on a 10,000 authorization: exactly one succeeds and two get `422 capture_exceeds_remaining` (`remainingFils: 4000`). The row lock is held across the acquirer call.
- Capture on an expired hold, or on a hold the janitor marked `expired`: `409 authorization_expired`, and nothing is written to the ledger.
- A `cursor` that decodes to a bad timestamp or id is a 400 through the shared invalid-input handler. One that does not decode at all is ignored, which returns the first page. `from`/`to` are validated.
- The acquirer reference is a fresh `acq_<uuid>` per authorization, and the acquirer idempotency key is `<claim id>:<attempt>`, so two transactions never share a reference.

## Reported, not fixed (other lanes or decisions)

- **Suspended or closed merchants can still authorize and capture with an API key.** `apiKeys/verify.ts` does not check `merchants.status`. Fixed on `origin/b/h2-auth-edges` (`d3128e6`), which is not merged into `fix/money-parsing` yet. That is the auth lane.
- **Public checkout pay accepts the same malformed card.** `routes/paymentLinks.ts:177` only checks `if (!card)`, and `payPaymentLink` hands the card to the same acquirer, so it fails the same way as TX2. That is the payment-links lane. The TX2 check can be reused there.
- **Fee avoidance by splitting captures (pricing decision).** The fee is rounded half-to-even per capture event (`capture.ts`, as `ARCHITECTURE.md` specifies). At 250 bps a 20-fils capture carries a 0-fils fee (`applyRateFils(20, 250) = 0`, against 250 for 10,000), so 500 partial captures of 20 fils on a 10,000-fils authorization book 0 fils of MDR instead of 250. Charging the fee on the cumulative captured amount would close this gap, but it changes the fee model that settlement and refund fee reversal rely on. This needs a finance decision, so it is not changed here.
- **No upper bound on `amountFils`.** Any safe integer is accepted (9,007,199,254,740,991 fils was authorized). Nothing documents a per-transaction limit, so this is left as a policy question.
- **`currency` in the authorize body is ignored.** A body with `"currency":"USD"` is authorized in BHD. The platform is BHD-only (`CHECK (currency = 'BHD')`), and `amountFils` names the unit, so this is noted only.
- **`limit=0` on the list returns one row** (it is clamped to 1) instead of a 400 or the default.
