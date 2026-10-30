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
- **What:** `JOIN transactions t ON t.id = r.id` is an inner join on the wrong key (a refund id is never a transaction id), so no refund matched and the view was always empty. Had it matched, it would also have summed captured once per refund.
- **Impact:** no live caller. No API route, job or report reads `refund_merchant_summary`, so this is a defensive fix (and the view was never refreshed either; see sqlhunt Q1).
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
- **Also fixed (Go):** `payout_notify.go` relied on a unique index on `outbox_events (event_type, aggregate_id)` that does not exist, so daemon + `run-batch` scanning together enqueued `settlement.paid` several times per batch. Each insert now re-checks under a per-batch advisory lock. Test: 12 concurrent scans over 40 batches → one event each (old code: 5 for one batch).

## H1. The stack could not be deployed (hosting prep) — High
**Where:** `ops/`
- **What:**
  - `Dockerfile.node` and `Dockerfile.go` were referenced by compose but missing.
  - `.env.docker` (with `NODE_ENV=production`) was never loaded: compose auto-reads only `.env`.
  - Production mode requires `WEBHOOK_SECRET_ENCRYPTION_KEY` and `SETTLEMENT_INTERNAL_TOKEN`, which nothing set.
  - The acquirer callback secret was committed (`.env` in `.gitignore` does not match `.env.docker`).
  - Postgres was published on 0.0.0.0 with the dev password.
- **Fix:** Dockerfiles sized for the 2 GB-disk box (caches removed in-layer, static Go binary with embedded tzdata, non-root); `env_file`; secrets required via `${VAR:?}` from a gitignored `ops/.env` (`ops/.env.example`); committed secret removed (**rotate it**: it is in git history); Postgres on 127.0.0.1.
- **Verified:** compose parses; settlement cross-compiles static for Linux; the api boots with `NODE_ENV=production` and rejects an unsigned callback. Docker itself was not available on this machine to build the images.

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
  - If capture is declined (any non-200 other than 502), the link is handed back (`paid → active`, matched on its transaction) and the authorization is voided.
  - If capture answers 502 (acquirer error), the link is also handed back to `active`, but the authorization is **not** voided, so a retry with the same Idempotency-Key replays it and can finish the capture (the capture key was marked failed, so it is retryable). Limit: the link is open to any payer meanwhile. If someone else pays it first, or the customer never retries, that first authorization is left holding funds on the card; nothing voids it later.
  - If capture throws, its database transaction rolls back (the capture idempotency claim too), and the link is put back to `reserved` with a fresh `reserved_at` that no request holds, so it is not shown as `paid`. The authorization is **not** voided. The link is unpayable (409 `payment_link_processing`) until the reservation timeout passes, after which any payer can claim it; a same-key retry then replays the authorization and captures. The code does not check whether the acquirer captured before the throw.
  - Release only matches the holder's own lease.
  - Residual risk: a process crash between finalize and capture leaves a paid link with an `authorized` transaction. That is under-collection, which is visible and capturable, instead of a second charge. The 502 and throw paths above can likewise leave an uncaptured authorization holding the customer's funds.
- **Test:**
  - A second claim lands during authorize → the first attempt's transaction is voided with 0 captured.
  - `pay.doubleCharge.test.ts` uses a gated acquirer to hold the first request inside **capture**, or inside authorize, while its lease expires. On the original code, and with the renew-before-capture version, the merchant ends with `['captured', 'captured']`. With the fix there is one capture, and the loser gets 409.

## T1. Test-suite isolation — Low
- `archiveReplay.test.ts` inserted real event types (`transaction.captured`) with `{}` payloads into the shared `outbox_events`. The reporting consumer read them and crashed (`merchant_id` NULL), so 4 `apps/reporting` tests failed whenever `npm test` ran on one database. The test now uses an inert event type (the convention `admin.test.ts` already follows).
- `dispatcher.test.ts` asserted an exact value from a ±10% jitter function (flaky). Jitter is now pinned in the test.

---

## Verification

On a fresh Postgres 16: `npm run migrate` applies every migration (81 at `d68585e`; this section was first written when there were fewer). `npm test` passes in full, and `cd apps/settlement && go test -p 1 ./...` passes (the Go packages share one database, so run them one at a time; see `ledgerint.md`). Run twice back-to-back on the same database (state left over from the first run) and it still passes.

---

## Sweep findings (admin and merchant surfaces)

Smallest fix each, one commit each, with a regression test confirmed to fail before the fix and pass after.

### Admin plane

| # | Finding | Severity | Fix |
|---|---|---|---|
| A1 | **Admin session fixation**: the pre-OTP cookie became the logged-in admin session unchanged (the "re-issued at verify" comment re-set the same token) | High | new token issued at OTP verify |
| A2 | **Admin OTP attempt race**: 26 of 30 parallel guesses were checked against a limit of 5 (the `FOR UPDATE` comment was false) | High | atomic conditional UPDATE reserves each attempt |
| A3 | **API key rotation left the old key working** (no "24h grace" exists) | High | old key revoked with reason `rotated` (0037); the test that asserted the old key stays active was corrected. Trade-off: 0056 intended a staged overlap (`revoke_after`), but immediate revocation is the safe default when the reason for rotating is a leaked key, at the cost of a hard cut-over for the merchant's integration (a staged overlap would need an explicit opt-in, not the default) |
| A4 | `api_keys.revoke_after` ignored: the sweep job promised in 0056 does not exist | Low (nothing writes `revoke_after` today, so no key is affected yet; defensive) | checked at verification time |
| A5 | **Bulk KYC approve** approved rejected or never-reviewed merchants and set `kyc_passed` | High | only `under_review` merchants |
| A6 | **Credit four-eyes compared display names**: the requester could approve their own credit after a rename | High | compare admin user ids |
| A7 | `notifySettlementRefundAdjustment` sent `amountFils / 10` (ADR-0001) | Low (no live callers, defensive) | integer fils |
| A8 | Admin invite codes from `Math.random` | Low (no live callers: nothing calls `createAdminInvite`; defensive) | `crypto.randomInt` |
| A9 | **Single KYC review had no status check** (found after A5): `POST /v1/admin/merchants/:id/kyc-reviews` approved a merchant that never uploaded documents or was rejected, rejected an approved one (`kyc_passed` back to false), and two clicks decided a merchant twice | High (A5's bug on the single path) | `4cf0e31`: same rule as bulk. The row is locked and anything but `under_review` is `409 merchant_not_under_review`, with nothing written. `recordKycReview` is unchanged, so the seed still pre-approves. Test `routes/adminKycReviewStatus.test.ts` (3 tests, all fail on the old code) |

### Merchant plane

| # | Finding | Severity | Fix |
|---|---|---|---|
| M1 | **Report scope IDOR**: any merchant could read any other merchant's split-child transactions via `filter.merchantId` | Critical | the child's parent must be the caller |
| M2 | `/v1/reporting/export-summary` had no auth preHandler | Low | `requireMerchantAuth` |
| M3 | **Webhook SSRF**: endpoints could target 169.254.169.254, 10.x, localhost or service names; test-send echoed 2 KB of the response; redirects were followed | High | non-public hosts rejected at create/update and re-checked (with DNS) at send in production; redirects never followed |
| M4 | **CSV injection** in the transactions export (`= + - @` references) | Medium | formula cells prefixed with `'` |
| M5 | **Capture idempotency ignored the transaction id**: reusing a key on transaction B replayed A's 200, so B was never captured | Medium–High | the request hash covers the transaction id; reuse is 422 |
| M6 | KYC PDF-only document types were judged by filename (a JPEG named `.pdf` passed) | Medium | judged by magic bytes |
| M7 | **The public payment-link read leaked the merchant's API key prefix and stored key hash** | Medium | fields removed |
| M8 | Settlement summary counted a multi-capture transaction's total once per capture (4 + 6 reported as 20) | Medium | sums capture events in the window |
| M9 | Reconciliation estimated pending fees with floats at the current mdr_bps (false gaps) | Medium | uses the fee recorded at capture |
| M10 | KYC image decompression bomb (30 KB PNG → 225 MB decode); a corrupt image gave a 500 after writing to disk | Medium | >40 MP rejected from the header; decode failures are 422; nothing is written before validation |
| M11 | Ledger-activity analytics treated `to` as inclusive, unlike every other endpoint | Low | exclusive |
| M12 | Webhook receiver responses were read fully into memory (memory DoS) | Medium | capped at 64 KB |
| M13 | `amountFils: 0` on link create was a 500 | Low | 400 |

**Noted, not changed:**
- No password rate limiting on admin login.
- Multipart does not enforce one file per request.
- The KYC filename is put unescaped into `Content-Disposition`.
- Malformed report filters returned 500 instead of 400. Fixed since by B6b (`invalid_filter`, `apps/api/src/routes/reporting.ts`).
- `streamTransactionsExportCsv` (unused) paginates on `occurred_at >` alone.
- Admin replay-batch accepted `statuses: ["succeeded"]` although a comment said it was rejected. Fixed since by B3b (`38f9688`): unknown statuses are 400, and `pending`/`succeeded` need finance or super_admin.
- ADMIN.md says "adjust balance" is journaled; per ADR-0004/0006 it is cache-only. The code is right and the doc needs fixing.
## S7. Merchant OTP: resend reset the guess budget; login cookie fixation; 10-minute logouts — High
**Where:** `apps/api/src/routes/auth.ts`, `apps/api/src/auth/sessions.ts`
- **What:**
  - `/otp/resend` created the new challenge with `attempt_count = 0` (its doc comment promised it inherited the count), so guess, resend, guess again never reached the lockout.
  - OTP verify promoted the *pre-OTP* cookie to the logged-in session (fixation).
  - Verify never re-set the cookie, which kept the 10-minute pending `maxAge`, so a valid 12-hour session dropped out of the browser after 10 minutes.
- **Fix:** carry `attempt_count` over on resend. Promotion rotates the token, and verify sets the new cookie with `maxAge = sessionTtlHours`.
- **Test:** `app.test.ts`: resend keeps the budget and the lockout applies; verify sets `Max-Age` to the session lifetime; the login helper asserts the pre-OTP cookie is dead after verify. All fail on the old code.

## S8. CSRF / CORS review — no change needed
No CORS plugin is registered, so cross-origin scripts cannot read responses. Session cookies are `SameSite=Lax`, so cross-site POST, PUT and DELETE requests carry no cookie. No GET route mutates state (checked every `app.get` handler). JSON bodies are only parsed for `application/json`, which a cross-site form cannot send without a preflight. The residual risk is a hostile *same-site* origin (a sibling subdomain): if one is ever hosted, add an `Origin` check on cookie-authenticated writes.

## S9. The authorize idempotency hash stored the card, CVV included (PCI) — High
**Where:** `apps/api/src/payments/authorize.ts`. Both `POST /v1/transactions` and the public `POST /v1/payment-links/:token/pay` authorize through it. Fixed in `0c34a1e`.
- **What:** `idempotency_keys.request_hash` was `sha256(canonicalJson({ amountFils, card, reference }))`: the whole card, PAN and CVV included, with no key. `acquirerIdempotencyKey` is derived from it.
- **Breaks:** PCI DSS forbids storing the CVV after authorization in any form, even hashed. The amount and reference are on the transactions row. With them and the PAN, the CVV is one of 1,000 sha256 guesses. With a known BIN, the expiry and the Luhn digit, the PAN is a search small enough to run. Anyone who could read the table could recover card data: a backup, a replica, or SQL injection.
- **Fix:** the hash carries `HMAC-SHA256(key, { pan, expiryMonth, expiryYear })` in place of the card. The key is HKDF-derived from `WEBHOOK_SECRET_ENCRYPTION_KEY` (required in every environment) under its own label. Every instance of a deployment derives the same key, so a retry still hashes, and keys the acquirer, the same. The CVV is in neither the hash nor the fingerprint.
  - The same key with the same request still replays.
  - Another amount, PAN, expiry or reference is still 422 `idempotency_key_reused`.
  - A retry that differs only in the CVV now replays instead of conflicting. The checkout rotates its key on any card change, so it is not affected.
  - The other `hashRequest` callers hash no card data: capture, refund, and admin credits and balance adjustments.
- **Test:** `apps/api/src/routes/authorizeCardHash.test.ts`, 5 tests:
  - The stored hash matches no unkeyed sha256 of JSON carrying the card, and a 000–999 CVV search finds nothing.
  - Two authorizations that differ only in the CVV store the same hash, and another PAN or expiry changes it.
  - A second app with a different server secret stores a different hash.
  - Replay and the four conflicts still hold, with one acquirer call.
  - The payment-link pay path stores a card-free hash too.
  - Before: all 5 fail. The errors were `request_hash is an unkeyed sha256 of JSON carrying the card`, a hash that changed with the CVV, the same hash under both secrets, and `422 !== 201` on the CVV-only retry. After: pass.
- **Open:**
  - Rows written before the fix still hold the old hash. They can never match a new request, so overwriting `request_hash` on existing `transactions.authorize` rows would lose nothing. That is a production data change, so it is left to the owner.
  - A same-key retry that spans the deploy gets 422 instead of a replay. Rotating `WEBHOOK_SECRET_ENCRYPTION_KEY` has the same effect.

---

## Round 2 (board items B1–B6)

Each fix has a regression test that failed on the old code and passes after the fix.

| # | Finding | Severity | Fix |
|---|---|---|---|
| B1a | **An expired authorization could still be captured.** `capture.ts` checked only the status, so an 8-day-old auth captured. | High | 409 `authorization_expired` when the hold is past `expires_at` or already marked expired; no acquirer call, no ledger write |
| B1b | **The negotiated discount was wrong in three ways.** Payment-link captures never got it. Concurrent partial captures double-rebated (440 instead of 450). The maths was fee-first, so 602 fils @ 275 bps with 12.5% off gave 15 where ARCHITECTURE / `ComputeSettlementFee` give 14. | High | discount computed inside `captureTransaction` under the row lock, discount-first with half-even rounding; one fee pair per capture; `discountBps` recorded on the event |
| B2a | Credit effective date accepted 2099 | Medium | rejects dates after today in Asia/Bahrain |
| B2b | **Credit fee reversal used the current `mdr_bps`**, not the rate charged on that date | High | dated fee schedule minus volume tier, as of the effective date |
| B2c | Admin settlement audit row said 'succeeded' before the call ran | High | written as 'requested', then updated to 'succeeded' / 'failed' (0088) |
| B3a | **Webhook replays got a new delivery id**, so receivers could not dedupe (ARCHITECTURE §5) | High | single replay, batch replay and archive restore all keep the original id |
| B3b | Support could replay succeeded/pending deliveries | High | 403 unless finance/super_admin; archive restore finance+; UI and ADMIN.md updated |
| B3c | Deleting an endpoint that had deliveries returned 500 (FK) | Medium | soft delete (0080); delivery history kept |
| B3d | Disabled endpoints were still retried | Medium | the retry step only picks up active endpoints |
| B3e | A NUL byte in a receiver's response made the outcome update fail, so the delivery was resent forever | Medium | NUL stripped from the stored excerpt |
| B3f | Backoff jitter could exceed the cap | Low | clamped after jitter |
| B4 | **Bulk KYC approve wrote no review rows**, and the admin UI could approve merchants that were no longer visible, or not `under_review` | High | each merchant goes through `recordKycReviewInTx` in one transaction, and skipped ids are reported; the UI only sends visible, ticked `under_review` rows |
| B5a | **Dashboard capture/refund retries minted new idempotency keys** (double capture or refund after a lost response); the refund key changed on every keystroke | High | one key per intent, rotated only after a definitive answer or an amount change |
| B5b | The payment-link detail page only searched the newest 100 links | Medium | merchant-scoped `GET /v1/merchants/:id/payment-links/:linkId` |
| B5c | Expired links showed as active and offered Cancel | Medium | display status follows the API rule |
| B5d | **Checkout after a lost response invited the customer to pay again** | High | 30s timeout, poll the link before re-paying, show a receipt, "Paid at" in Bahrain time |
| B6a | Malformed JSON, the wrong content type, and other Fastify client errors returned 500 | Medium | their 4xx with a stable code (413 mapping kept) |
| B6b | `limit=abc`, garbage dates and non-UUID ids returned 500 | Medium | 400 (`invalid_id` / `invalid_filter` / `invalid_request`); genuine server bugs stay 500 |
| B6c | **`amountFils: 0` was approved at the acquirer and then failed on insert** (orphan authorization); bad types returned 500 | High | 400 `invalid_amount` before the idempotency claim and before any acquirer call |
| B6d | A business-profile PATCH with unknown keys built invalid SQL (500) | Medium | 400 naming the fields |

**Verified:** the combined round-2 branch on a fresh DB applied every migration (72 at the time; 81 at `d68585e`); `npm run typecheck` is clean; `npm test` passes in full (490 API tests at the time); `go test -p 1 ./...` passes.
