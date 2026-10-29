# API security, refunds (FP-300), webhooks and idempotency — findings

Same format as [money-and-settlement.md](money-and-settlement.md): what is wrong → why → what it breaks → fix → test.

Severity: **Critical** = account takeover, or money moved/charged wrongly ·
**High** = authorization bypass or wrong money for affected merchants ·
**Medium** = integrity/reliability, no direct loss · **Low** = hardening.

Every fix carries a regression test that fails before the change and passes after.

---

## S1. Login works without the OTP — Critical
**Where:** `apps/api/src/auth/sessions.ts` (`lookupSession`), `db/migrations/0058_live_sessions.sql`

- **What:** after a correct password, the *pending* session cookie (issued before the OTP step) already authenticates every merchant route. The OTP never has to be entered.
- **Why:** `lookupSession` reads the `live_sessions` view, which filters only `revoked_at` and `expires_at`. Migration 0012 requires every auth query to also check `authenticated = true`. The admin lookup does; the merchant one did not.
- **Breaks:** second factor for every merchant user: a leaked password is enough.
- **Fix:** add `AND s.authenticated = true` to the lookup.
- **Test:** `auth/sessions.test.ts` — a pending session resolves to `null`.

## S2. Login can land you in another merchant's account — Critical
**Where:** `apps/api/src/routes/auth.ts`, `apps/api/src/auth/users.ts` (`findOtpRecipient`)

- **What:** the OTP challenge and the pending session are bound to `findOtpRecipient(email)`. That function looks up by email across *all* merchants (`LIMIT 1`), not the `(merchantId, email)` user whose password was just checked.
- **Why:** the same email may exist under several merchants (one row per `(merchant_id, email)`).
- **Breaks:** a user with an account at merchant A logging in to A can end up with a session for merchant B, who shares the email.
- **Fix:** bind OTP and session to the verified user row.
- **Test:** existing `app.test.ts` "login resolves the OTP recipient to the same account that was authenticated" passes.

## S3. OTP codes from `Math.random`; attempt limit raceable — High
**Where:** `apps/api/src/lib/random.ts`, `routes/auth.ts` `/otp/verify`

- **What:** OTP codes and link slugs used `Math.random()`, which is predictable. The 5-attempt limit was check-then-increment: N parallel guesses all read `attempt_count = 0`.
- **Why:** `CLAUDE.md` claims `Math.random()` is fine for OTPs. It is not, and the comment in `/otp/verify` already described the race.
- **Fix:** `crypto.randomInt`. Reserve the attempt with one conditional `UPDATE … WHERE attempt_count < max_attempts RETURNING` before comparing.
- **Test:** auth suites green; behaviour covered by the atomic UPDATE.

## S4. IDOR: merchant A cancels merchant B's payment link — High
**Where:** `apps/api/src/paymentLinks/cancel.ts`

- **What:** `DELETE /v1/merchants/:A/payment-links/:linkOfB` canceled B's link.
- **Why:** `assertOwnMerchant` checks only the path merchant. The UPDATE filtered by link `id` alone.
- **Fix:** add `merchant_id = <authenticated merchant>` to the UPDATE and the follow-up SELECT (a foreign link is a 404).
- **Test:** `routes/paymentLinks.test.ts` — the cross-merchant cancel is 404 and the link stays active (fails before the fix).

## S5. Admin impersonation could act as the merchant — High
**Where:** `apps/api/src/admin/impersonation.ts`, `apps/api/src/auth/requireMerchantAuth.ts`

- **What:** a `super_admin` "view as merchant" grant became merchant role `owner`, and capture/void/refund routes check only `requireMerchantAuth`. Impersonation could move money.
- **Why:** the docs (ARCHITECTURE, ADMIN.md: "view as merchant") and the lookup's own doc comment say grants are support-level and read-only. The role map contradicted this. `CLAUDE.md`'s "the handler needn't re-check" is wrong.
- **Breaks:** support for a disabled admin too: the grant lookup had no `admin_users.status` check.
- **Fix:** a grant always resolves to `support`. Any non-GET request with an impersonation actor is 403 at the auth layer. A disabled admin's grant stops resolving.
- **Test:** `routes/admin.test.ts` impersonation test passes. It reads, but owner/finance writes are 403.

## S6. A support session could capture and void — High
**Where:** `apps/api/src/routes/transactions.ts`
- **What:** capture and void only required "any authenticated merchant actor". The dashboard hides those buttons from `support`, and its own comment says the hide is not backed server-side.
- **Fix:** `requireMerchantRole("owner", "finance")` on both. API keys are unaffected (owner-issued).
- **Test:** `routes/transactions.test.ts` — a support session gets 403 on capture and void; the transaction stays `authorized`.

## R1. Refunds (FP-300) — the missing feature, now built — High
**Where:** `apps/api/src/routes/refunds.ts`, `app.ts`, `apps/web/.../RefundDrawer.tsx`, `TransactionDetailPage.tsx`, `transactions/serialize.ts`, `webhooks/envelope.ts`

- **What:** `POST /v1/refunds` returned 501. The refund drawer was parked, and nothing reached merchants.
- **Built:**
  - `POST /v1/refunds` (API.md) and `POST /v1/merchants/:merchantId/refunds` (drawer path), one handler over `initiateMerchantRefund`.
  - owner/finance sessions or an API key; `Idempotency-Key` required. The suggested draft handler minted `crypto.randomUUID()` server-side, which makes every retry a new refund.
  - Full or partial refunds; double-entry ledger reversal (gross plus pro-rata MDR fee reversal); `refunded` / `refund_partial` timeline event; `refund.succeeded` outbox event, now an eligible **webhook**.
  - Transactions DTO exposes `refundedFils`.
- **Drawer:** restored and mounted. One idempotency key per refund *intent* (was a fresh key per click, so a double-click meant a double refund); rotated after a definitive answer. Shown for `partially_refunded` too. Max = captured − refunded.
- **Test:** `routes/transactions.test.ts` (key required; refund + replay = one refund; scoped paths), `envelope.test.ts` (`refund.succeeded` shape).

## R2. Any merchant could refund any transaction — Critical
**Where:** `apps/api/src/refunds/initiateMerchantRefund.ts`, `payments/processRefund.ts`

- **What:** the merchant used for the refund was read from the *transaction row*, never from the caller.
- **Fix:** both lookups filter `merchant_id = <authenticated merchant>`. A foreign id is 404.
- **Test:** `processRefund.test.ts` — another merchant's transaction is 404 and nothing is refunded.

## R3. Concurrent double refund — Critical
**Where:** `apps/api/src/payments/processRefund.ts`

- **What:** two refunds with different idempotency keys at the same time both succeeded: twice the money back.
- **Why:**
  - The idempotency claim is per key, so it never serialized them. Both read `refunded_fils = 0` without a lock.
  - Both then wrote an absolute `refunded_fils` computed from that stale read (lost update).
  - The comment "the claim blocks it" is wrong.
- **Fix:**
  - `SELECT … FOR UPDATE` on the transaction, and validate.
  - Reserve the amount in `refunded_fils` before the acquirer call. Release it on decline or error.
  - On success, only derive the status.
  - A crash in between leaves the key `in_progress` (never retried), so the error is in the safe direction.
- **Test:** three concurrent full refunds → exactly one succeeds, total refunded = captured. A declined refund leaves the full amount refundable.

## R4. Refund could exceed what was charged — High
- **What:** refundable was `authorized − refunded`. On a partial capture (10,000 authorized, 4,000 captured) a 6,000 refund passed.
- **Fix:** `captured − refunded`.
- **Test:** `processRefund.test.ts` — 6,000 against 4,000 captured is 422 `refund_exceeds_refundable`.

## R5. Fee reversal drifted and ignored the capture discount — Medium
- **What:**
  - Each partial refund rounded its own pro-rata fee share, so partials could reverse more or less than the fee charged in total.
  - The "fee charged" was every `platform_fee_revenue` credit, ignoring the capture-time discount debit.
- **Fix:** net fee = MDR credits − capture-time debits (excluding earlier refund reversals). Each refund reverses `share(cumulative refunded) − already reversed`, so the sum is exact.
- **Test:** three partial refunds (3,333 / 3,333 / 3,335 of 10,001) reverse exactly the fee charged.

## R6. Refund summary view joined the wrong key — Medium
**Where:** `db/migrations/0072_refund_merchant_summary.sql` → new `0075`
- **What:** `JOIN transactions t ON t.id = r.id` (a refund id is never a transaction id) made `original_captured_fils` always NULL. It also summed captured once per refund.
- **Fix:** 0075 recreates the view joined on `r.transaction_id`, counting each transaction once per day.

## R7. Admin status recompute overwrote chargebacks — Medium
**Where:** `apps/api/src/admin/transactionStatusRecompute.ts`
- **What:** "safe to run more than once" re-derived status from amounts for every non-authorized/voided row, including `chargeback`, erasing open disputes.
- **Fix:** exclude `chargeback`.

## W1. Webhook signature never matched what was sent — High
**Where:** `apps/api/src/webhooks/sign.ts`, `dispatcher.ts`, `testSend.ts` (the unfinished `ya/sign-raw` WIP)

- **What:** the dispatcher signed `canonicalJson(payload)` (sorted keys) but sent `JSON.stringify(payload)`. A receiver verifying the bytes it received failed whenever keys weren't already sorted, which is common since jsonb reorders keys.
- **Fix:** serialize once, sign those exact bytes, send them. `verifySignature` takes the raw body.
- **Rotation:** `verifySignature` accepts several secrets and several `v1=` values, so a sender can dual-sign during a key change.
- **Test:** `sign.test.ts` — the receiver verifies the raw body; the reordered body is a mismatch; dual-signed header verifies against either key. The old test asserting "key order doesn't change the signature" encoded the bug and was replaced.

## W2. Unsigned acquirer callbacks were accepted — Critical
**Where:** `apps/api/src/webhooks/inboundVerify.ts`, `routes/acquirerCallbacks.ts`, `config.ts`

- **What:** a callback with no signature header was processed by default (`requireSignature = false`, env default false). Anyone could post a forged "confirmed_fraud" verdict against any transaction.
- **Also:**
  - HMAC was over `JSON.stringify(parsedBody)`, not the raw bytes.
  - The compare was `Buffer.compare`, which is not constant-time.
  - There was no freshness check, so a captured callback could be replayed forever.
  - There was no way to rotate the secret.
- **Fix:**
  - A signature is required by default, and always in production.
  - Verified over the raw request body (route-scoped content parser), reusing the outbound verifier: constant-time, 300-second window.
  - `ACQUIRER_CALLBACK_SIGNING_SECRET="current,previous"` for rotation.
  - The signature is checked before the body is looked at.
- **Test:** `inboundVerify.test.ts` (raw bytes, unsigned rejected, stale rejected, rotation), `acquirerCallbacks.test.ts` (unsigned → 401, stale replay → 401).

## W3. FP-201 "callbacks deduplicated" — they were not — Medium
**Evidence:** `docs/incidents/postmortem-2026-05.md` action item 1 "Done"; commit `bf66bf2` "callbacks are deduplicated now — They are not."

- **What:** no `processed_events` table or check exists. Every redelivered callback appended another note. `withCallbackRetry` also retried 4xx such as an unknown transaction.
- **Fix:** migration `0076` makes `callback_id` unique (duplicate rows from earlier redeliveries are removed first, keeping the earliest); insert is `ON CONFLICT DO NOTHING`; a 4xx is not retried.
- **Test:** 3 concurrent and 1 later redelivery → exactly one note.

## W4. Duplicate webhook deliveries and duplicate payout instructions — High
**Where:** `apps/api/src/webhooks/dispatcher.ts`, `webhooks/payoutDisbursement.ts`

- **What:**
  - Step B selected due deliveries with no lock ("only run one replica", while staging ran two). Two passes could send the same delivery.
  - Worse, `settlement.paid`'s pre-delivery effect inserts a payout disbursement instruction **per delivery row**. A merchant with two webhook endpoints, two replicas, or a transport throw before `attempt_count` moved each produced another instruction for the same batch.
- **Fix:**
  - Due rows are claimed with `FOR UPDATE SKIP LOCKED` and a lease on `next_attempt_at`.
  - The disbursement is at most one per settlement batch (advisory lock + `NOT EXISTS`).
- **Test:** `payoutDisbursement.test.ts` — 4 concurrent + 1 repeat → one instruction.
- **Open (Go, settlement lane):** `payout_notify.go` relies on a unique index on `outbox_events (event_type, aggregate_id)` that does not exist, so daemon + `run-batch` together can enqueue `settlement.paid` twice.

## P1. Expired payment links could be paid — High
**Where:** `apps/api/src/paymentLinks/pay.ts`
- **What:** the public, unauthenticated pay endpoint judged expiry against the client's `submittedAt`. Any past timestamp paid an expired link.
- **Fix:** server clock only (`submittedAt` accepted for compatibility, ignored).
- **Test:** an expired link with a backdated `submittedAt` → 410.

## P2. One payment link charged twice — Critical
**Where:** `apps/api/src/paymentLinks/pay.ts` (incident 2026-05-14, FP-198)
- **What:** reservations were not owned. If authorize outlived the reservation timeout, a second payer re-claimed the link, and both captured. Finalize and release matched any `reserved` row. The code called this "unreachable".
- **Also reachable through capture:** this is FH's scenario in the code comment. Renewing the lease before capture is not enough, because capture itself can outlive the lease. In that case a second payer re-claims, captures and finalizes. The first request's capture has already gone through, its finalize misses, and the old branch still answered 200.
- **Fix:**
  - The claim returns a lease token (`reserved_at`, exact text).
  - Finalize (`reserved → paid`, matched on the holder's own lease) now runs right after authorize and **before** capture. Only the request that wins it captures, so a lease that expires mid-flight cannot cause a second charge.
  - A holder that lost the finalize voids its own authorization (no money moved yet) and answers 409. The exception is a link that was finalized with this very transaction, i.e. a same-key retry; that request owns the capture.
  - If capture fails, the link is handed back (`paid → active`, matched on its transaction).
  - Release only matches the holder's own lease.
  - Residual risk: a crash between finalize and capture leaves a paid link with an `authorized` transaction. That is under-collection, which is visible and capturable, instead of a second charge.
- **Test:**
  - A second claim lands during authorize → the first attempt's transaction is voided with 0 captured.
  - `pay.doubleCharge.test.ts` uses a gated acquirer to hold the first request inside **capture**, or inside authorize, while its lease expires. On the original code, and with the renew-before-capture version, the merchant ends with `['captured', 'captured']`. With the fix there is one capture, and the loser gets 409.

## T1. Test-suite isolation — Low
- `archiveReplay.test.ts` inserted real event types (`transaction.captured`) with `{}` payloads into the shared `outbox_events`. The reporting consumer read them and crashed (`merchant_id` NULL), so 4 `apps/reporting` tests failed whenever `npm test` ran on one database. The test now uses an inert event type (the convention `admin.test.ts` already follows).
- `dispatcher.test.ts` asserted an exact value from a ±10% jitter function (flaky). Jitter is now pinned in the test.

---

## Verification

On a fresh Postgres 16: `npm run migrate` applies all 70 migrations. `npm test` passes in full, and `cd apps/settlement && go test ./...` passes. Run twice back-to-back on the same database (state left over from the first run) and it still passes.
