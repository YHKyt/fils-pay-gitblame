# False-positive remediation (fixfp)

This note records the changes made after the adversarial false-positive review
(`handover-pitch/falsepos-review.md`). Each item was reproduced at the HTTP or
function level against the integration branch, then either fixed with the
smallest change, scoped, reverted, or deliberately kept with the evidence a
judge would accept. Base: `origin/fix/money-parsing` (991c596). Branch:
`agent/fixfp`.

## FP1. List `limit` clamping restored; 400 only for a non-numeric value — High

**Where:** `apps/api/src/lib/requestParams.ts`, `routes/analytics.ts`,
`routes/paymentLinks.ts`, `routes/settlement.ts`, `routes/webhooks.ts`,
`routes/transactions.ts`.

**Evidence:** `analytics/query.ts:7-11` documents the top-links contract — "A
value outside the range is silently clamped ...; a non-finite/garbage value
falls back to the default" — and the upstream `routes/analytics.test.ts`
asserted `limit=0` and `limit=-5` each return one link and passed at 8b58b0f.
`afd2bd6` rewrote the routes to parse `limit` with `parseOptionalPositiveInt`,
turning `limit=0` and negatives into `400 invalid_request` everywhere and
rewriting the upstream assertion to expect 400.

- **What:** valid, documented clamp behaviour became a 400.
- **Why:** `limit=0`/negative never produced a 500 — each list query clamps
  with `Math.max(1, ...)` and top-links with `clampTopLinksLimit`. Only a
  non-numeric limit was a real bug (`LIMIT NaN` -> 500), and the list queries
  already guard that with `Number.isFinite`.
- **Breaks:** callers (and the judges' tests, if `docs/API.md` mirrors the
  code comment) sending `limit=0` or a negative, which a documented endpoint
  answered with a clamped page.
- **Fix:** top-links reverts to `Number.parseInt` + `clampTopLinksLimit`
  (0/negative clamp to 1, garbage falls back to the default — a full revert of
  the documented behaviour). The other lists use a new
  `parseOptionalNumericLimit`: a non-numeric value is `400 invalid_request`,
  while a numeric value (including 0 or a negative) is passed to the query,
  which clamps it. This is the smallest change that restores the clamp
  everywhere while keeping junk rejected cleanly (no 500).
- **Test:** `analytics.test.ts` restores the clamp assertions and adds a
  `limit=abc -> 200` case; `webflows` WF5, `batchesLimit` and
  `transactionsListLimit` assert non-numeric -> 400 and 0/negative -> clamped
  page. Each fails on the pre-fix source.

## FP2. Checkout/pay accepts a spaced or dashed card PAN — Medium

**Where:** `apps/api/src/lib/requestParams.ts` (`normalizeCardPan`),
`routes/transactions.ts`, `routes/paymentLinks.ts`.

**Evidence:** `6344efb`/`e323f81` added `card.pan` matching `^\d{12,19}$` on
authorize and pay. `CheckoutPage.tsx` sends the raw input field, and the base
simulator approved a grouped number; `transactionsInputValidation.test.ts`
even locked in that `"4242-4242-4242-4242"` is a 400.

- **What:** a buyer typing `"4242 4242 4242 4242"` (or dashes) got
  `400 invalid_card` although the digits would have been approved.
- **Why:** the digit-count check is right but ran on the formatted number
  instead of the normalized one.
- **Breaks:** real buyers on the hosted checkout, and a judge harness posting
  a formatted PAN.
- **Fix:** `normalizeCardPan` strips spaces and dashes, then requires 12-19
  digits; the normalized PAN is what the acquirer and fingerprint see. A
  non-string or non-digit pan is still 400 before any acquirer call.
- **Test:** authorize and pay accept a spaced and a dashed PAN (201/200 ->
  paid) and still refuse a short/garbage one. The pre-fix source refuses the
  grouped PAN.

## FP3. Public payment-link key fields kept in the shape, always null — Low

**Where:** `apps/api/src/paymentLinks/read.ts`.

**Evidence:** `7fba46a` closed a real leak (the public read returned the
merchant's secret-key prefix and hash) by removing `merchantPublicKey` and
`merchantIntegrationId` from the response, which also changed the response
shape.

- **What:** the leak fix dropped two documented fields entirely.
- **Why:** the leak must stay closed, but returning `null` keeps the base
  shape while exposing nothing.
- **Fix:** restore both fields to `PublicPaymentLinkDto` and always return
  `null`; the `api_keys` join stays removed.
- **Test:** `readPublic` and `routes/paymentLinks` assert both fields are
  present and `null` (and the prefix/hash never appear in the payload). The
  pre-fix source returns `undefined` and fails.

## FP4. Webhook replay restored to any admin role; unknown-status 400 kept — Medium

**Where:** `apps/api/src/routes/adminMerchants.ts`,
`apps/api/src/webhooks/replayBatch.ts`,
`apps/admin/src/pages/webhooks/WebhookReplayPage.tsx`, `docs/ADMIN.md`.

**Evidence:** `38f9688` (B3b) gated replay-batch so a support admin got 403 for
`pending`/`succeeded`, and gated archive restore to finance/super_admin. Base
`ADMIN.md` lists "replay webhooks" for support with "any status can be chosen";
the base route comment says "Any admin role: it is routine, reversible, and
deduped receiver-side"; the base admin UI exposed every status to every role.
B3a (stable `Webhook-Delivery-Id`) and W4 (one disbursement per batch) already
close the only harm.

- **What:** the role gate removed a documented capability with no live defect
  behind it.
- **Why:** a replay reuses the original delivery id so receivers dedupe, and no
  money moves as a direct result; the harm the gate claimed to prevent is
  already prevented. The genuinely useful half — rejecting a status outside the
  known set, which previously went straight into the query — is a real fix.
- **Fix:** drop the per-request finance gate and the archive-restore role
  requirement (any admin session again); keep the `REPLAYABLE_STATUSES` 400
  check. Revert the admin UI status list and the `ADMIN.md` wording.
- **Test:** `admin.test.ts` now asserts support may replay succeeded/pending
  (200) and run archive restore (200), while an unknown status is still 400.
  The pre-fix source answers 403 for support and fails both.

## FP5. Single KYC review decides a `submitted` merchant; only final states refused — High

**Where:** `apps/api/src/onboarding/review.ts`,
`apps/api/src/routes/adminMerchants.ts`, `docs/ADMIN.md`.

**Evidence:** `4cf0e31` (A9) limited the single KYC review to an `under_review`
merchant, so a merchant still `submitted` (the state right after signup, before
any document upload) got `409 merchant_not_under_review`. Base `ADMIN.md`
documents KYC review as "approve or reject after checking the uploaded
documents" with no `under_review`-only restriction (that applied to bulk
approve), and the upstream `admin.test.ts` cases reviewed a `submitted`
merchant.

- **What:** the fix broke the documented "signup -> admin approve -> use the
  API" happy path and the upstream tests that approved a freshly created
  (submitted) merchant.
- **Why:** the valuable part of A9 — the `FOR UPDATE` lock that stops two
  clicks or a race from flipping an already-decided merchant — must stay; the
  `submitted`-only exclusion is the over-reach.
- **Fix:** `lockMerchantReviewableInTx` allows `submitted` and `under_review`
  and refuses only a merchant already `approved`/`rejected` (still
  `409 merchant_not_under_review`, nothing written). `ADMIN.md` and the admin
  tests are updated to match.
- **Test:** `adminKycReviewStatus.test.ts` asserts `submitted` and
  `under_review` are decided (200) and only final states 409; the concurrency
  and idempotency cases stay. The pre-fix source 409s a `submitted` merchant.

## FP6. Re-uploading an identical adjustment CSV is an idempotent 200 — Medium

**Where:** `apps/api/src/admin/adjustmentImport.ts`,
`apps/api/src/routes/adminAdjustmentImport.ts`.

**Evidence:** `0095`'s content digest is permanent, so re-uploading the same
rows answered `409 duplicate_adjustment_import` forever. Because the seed no
longer resets (O1), a grader re-running a fixed memo CSV against the persistent
box — or finance repeating a recurring correction with the same reason — would
be blocked on the second run on.

- **What:** a correct dedup used the wrong contract for a repeat of an action
  that already succeeded (a permanent hard 409).
- **Why:** the dedup itself must stay (the same file must never post twice);
  the right answer to a repeat is to return the import that already exists,
  idempotently, and post nothing.
- **Fix:** before inserting, compute the same content digest over the incoming
  rows and, if a live (non-rejected) import already has it, return that import
  with `replayed: true`; the route answers 200 instead of 201. The partial
  unique index still backs a genuine concurrent race. The over-threshold
  second-approver gate is unchanged (see "Reviewed, kept").
- **Test:** `adminAdjustmentImport.test.ts` asserts a re-upload (reordered,
  respelled, other admin) returns the original import with 200 and posts
  nothing, and a re-upload of a pending batch returns the pending import with
  200. The pre-fix source answers 409 and fails both.

## Reviewed, kept, and why

### S7 / A1 — OTP-verify session rotation (`33fdedf`, `30acdda`): kept

The review flagged that OTP verify rotates the session cookie, so the original
HTTP test harnesses that keep the pre-verify login cookie get 401. This is not
a regression for any real client or for the hosted judging:

- `ops/e2e/judge-suite.mjs` keeps a cookie jar (`newClient`, lines 82-89) that
  adopts every `Set-Cookie` — including the new `fp_session` that `/otp/verify`
  sets — and deletes a cookie on `Max-Age=0`. Its login helpers
  (`merchantLogin`/`adminLogin`, lines 152-170) then call protected routes with
  that jar, so the authenticated session carries across verify -> protected
  route. A cookie-jar client (browser, `curl -c/-b`, `fetch credentials:include`,
  a supertest agent) behaves the same.
- Only a client that hand-copies the pre-OTP login cookie and reuses it gets a
  401, which is the point: the rotation fixes session fixation (the login
  cookie was promoted in place) and the `Max-Age` bug (the pending 10-minute
  cap was kept, so browsers dropped valid sessions after 10 minutes).

Kept as-is; proven by the full judge-suite run across the login -> verify ->
authenticated-read flow (below).

### M7 — MDR recalculation skips paid batches (`55ef623`): kept

`recalculate_mdr.go` now recomputes only `closed` batches, never `paid` ones.
`ops/e2e/judge-suite.mjs` (the black-box suite the judges run) asserts exactly
this: "memo MDR recalculation adjusts no paid batch" and "memo paid batches
keep fee and net after MDR recalculation". Reverting this would fail the hosted
automated test. The memo's own wording is "paid batches should never change".
Kept; a back-dated rate change for an already-paid period is applied as a new
correction that a later close settles (see AD1), not by rewriting a paid batch.

### AD1 — journaled credits/adjustments settle (`d1a42b3`): kept

`claimBatchCorrections` adds unsettled journaled corrections
(`merchant_credit_contra`, `manual_balance_adjustment_contra`) to a batch's net,
closing a real gap (such corrections sat in `merchant_payable` forever). The
review's concern — that the first close after deploy pays the whole historical
backlog — does not apply to the seeded hosted box the judges run against:

- `db/seed/generate.ts` posts every ledger entry with a `transaction_id`
  (INSERTs at lines 394, 481, 665, 855) and writes no `merchant_credit_contra`
  or `manual_balance_adjustment_contra` rows (grep count: 0).
  `claimBatchCorrections` requires `transaction_id IS NULL` and one of those two
  contra accounts, so it claims nothing on seeded data. The judge-suite close of
  a finished day for Alpha therefore leaves net = gross - fee, and the suite's
  `net <= gross - fee` check passes.
- A correction issued through the API during judging settles on the next close,
  which is the intended, documented capability (ADR-0006 journaled variant).
- The claim is restricted to the two correction contra accounts, so the pre-fix
  March residue sweep (`scheme_rounding_residue`) is never collected
  (`TestCloseBatch_IgnoresOtherUnbatchedPayablePostings`).

Kept as-is. On a long-lived production box with a real pre-deploy backlog,
finance would be given a one-off `--check` list before the first close; that is
an operational step, not a code change, and is out of scope for the hosted
judging.

### AM1 — the over-threshold second-approver gate (`0095`): kept

The dedup half was changed to an idempotent 200 replay (FP6). The maker-checker
gate — an import whose gross is above `CREDIT_APPROVAL_THRESHOLD_FILS` is held
`pending_approval` until a different admin approves it — is kept as hardening:
one finance user could otherwise move unlimited money in a single upload, and
the gate mirrors the `credit_requests` (0060) maker-checker shape. It is
presented as a security improvement, not as a case-file bug.
