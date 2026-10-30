# Admin money actions: CSV import replay and approval, credit and adjustment retries

Scope: the admin CSV adjustment import (`apps/api/src/admin/adjustmentImport.ts`,
`routes/adminAdjustmentImport.ts`, `apps/admin/.../AdjustmentImportPage.tsx`) and the
issue-credit and adjust-balance actions (`admin/credits.ts`, `admin/balanceAdjustments.ts`,
their routes, and the submit handlers in `apps/admin/.../MerchantDetailPage.tsx`).
Teammate B's earlier credit fixes (four-eyes by admin id, effective date not after today,
fee reversal at the effective rate) and the `requested` audit outcome are kept unchanged.

## CSV adjustment import skips the second approver and can be replayed — High

**Where:** `apps/api/src/admin/adjustmentImport.ts` (`applyAdjustmentImport`),
`apps/api/src/routes/adminAdjustmentImport.ts` (`POST /v1/admin/adjustment-imports`),
`db/migrations/0065_adjustment_imports.sql` (no uniqueness of any kind).

**Evidence:** one finance admin uploads `merchantId,amount,reason` / `<m>,1000000.000,x`.
The response is `201` and both the ledger (`merchant_payable` credit) and
`merchant_balances.cached_payable_fils` show 1,000,000,000 fils at once. Uploading the same
text again is another `201`, and both read 2,000,000,000 fils. The same 1,000,000 BD entered
as a manual credit would wait for a second approver, because credits above 50.000 BD need one.

- **What:** the import posted every row the moment it arrived, so one person could move any
  amount. Nothing recorded what had already been imported, so a double submit, a browser
  retry or a re-upload of the same sheet posted the whole batch again. The route's own
  comments admitted both points.
- **Why:** the maker-checker rule lived only in `credits.ts`. The import is a second way to
  move money onto a merchant's payable balance, and it never applied the rule. There was
  also no natural key on `adjustment_imports`.
- **Breaks:** two-person control over large balance changes (one finance user can credit or
  debit without limit), and books integrity: every replay doubles the batch in the ledger,
  the cache and the next settlement payout.
- **Fix:** migration `0095_adjustment_import_dedup_and_approval.sql` plus the upload,
  approve and reject paths.
  - **Duplicates.** `adjustment_import_content_sha256(import_id)` is a SQL function that
    digests the stored rows: merchant, parsed fils and reason. Row order, whitespace, the
    spelling of the amount (`4.75` vs `4.750`), the filename and the uploader do not count,
    so a re-exported copy of the same sheet is still caught. A partial unique index on
    `content_sha256` covers imports that are posted or pending. A second identical upload
    fails on that index and returns `409 duplicate_adjustment_import`, and its transaction
    rolls back, so nothing is posted and no import row is left. Two simultaneous uploads
    serialise on the index, so there is no race. A rejected import is outside the index
    and can be uploaded again. To post the same corrections again on purpose, give the rows
    a different reason.
  - **Second approver.** If the batch's gross amount (sum of |row|) is above
    `CREDIT_APPROVAL_THRESHOLD_FILS`, the import is stored as `pending_approval` and nothing
    is posted. The check calls `creditRequiresSecondApprover`, the rule credits use.
    `POST /:id/approve` (finance or super_admin) locks the import, refuses the uploader with
    `409 self_approval_forbidden` (compared by admin user id, as in teammate B's credit fix),
    then posts every row and links each one to its ledger group. `POST /:id/reject` closes
    the import without posting. A second decision returns `409 adjustment_import_not_pending`.
    Imports at or below the limit still post on upload, as before.
  - **Design choice: the whole batch is measured.** One upload is one person's action, so
    it is compared against the limit as a whole. Checking rows one by one would let
    1,000,000 BD through as 20,000 rows of 50 BD. Absolute values are used because a large
    debit is as dangerous as a large credit. The batch is held whole rather than split, so
    a batch is never half posted.
  - **Safe on a populated database.** All new columns have defaults that describe existing
    rows truthfully: `status 'posted'`, `requires_approval false`, and `applied_at` is kept.
    Existing imports are backfilled with the same function, so a file uploaded before the
    release cannot be replayed after it. Where history already contains duplicates, only
    the earliest copy gets the digest. The later copies keep NULL, which the index ignores,
    so the migration cannot fail on them, and they can still be found for reconciliation.
    This was checked on a database migrated to 0088 and seeded with a duplicated import.
    0095 applied cleanly, the first copy got the digest, the second stayed NULL, and
    re-importing the same rows through the API returned 409.
  - **Smallest change:** the code reuses the threshold function, the ledger posting helper
    and the `credit_requests` status shape. It adds no new tables. The digest is defined
    once, in SQL, so the backfill and new uploads cannot disagree. The console page shows
    each import's status, adds Approve and Reject buttons, and reports when an import is
    held. `docs/ADMIN.md` no longer says "there's no duplicate detection yet". The four new
    audit action names (`adjustment_import_submitted/approved/rejected`) are a three-line
    addition to `adminAudit/log.ts`.
- **Test:** `apps/api/src/routes/adminAdjustmentImport.test.ts`.
  - *uploading the same CSV twice is a 409 and the ledger and cache are unchanged*: the same
    file, a reordered and respelled copy, and the same file from another finance admin all
    return 409. The ledger and cache stay at 6000 fils, and only one import exists.
  - *an over-threshold import waits for a different admin's approval before anything posts*:
    the 1,000,000 BD upload returns `pending_approval` and posts nothing. Approval by the
    uploader returns 409 and still posts nothing. Queuing the file again returns 409.
    Approval by a second finance admin posts exactly 1,000,000,000 fils to the ledger and
    the cache. A second approval returns 409.
  - *many small rows that add up past the threshold are held too*, and *a rejected import
    posts nothing, cannot be approved, and the file can be uploaded again* (support gets 403
    on approve).
  - Fail-before: with the old `adjustmentImport.ts`, the old route and the old `log.ts`, the
    first four of these fail (`201 !== 409`, `expected: 'pending_approval'`, `403` vs `404`).
    With the fix, all 27 import tests pass (16 route tests, 11 unit tests).

## Issue credit and adjust balance post twice when retried — Medium

**Where:** `apps/api/src/admin/credits.ts` (`createCreditRequest`),
`apps/api/src/admin/balanceAdjustments.ts` (`applyBalanceCorrection`), their routes
`routes/adminCredits.ts` and `routes/adminBalanceAdjustments.ts`, and the two submit
handlers in `apps/admin/src/pages/merchants/MerchantDetailPage.tsx`.

**Evidence:** a finance admin issues a 40 BD credit; the response is lost (timeout, proxy
reset) and they press the button again, or a client retries. On the old code both requests
return `201` with two different credit ids: two `credit_requests` rows, two ledger groups,
and the cache at 80,000 fils for a 40 BD credit. The same retry of a balance adjustment
moves the cache twice. Two simultaneous submits do the same.

- **What:** the two admin actions that move money had no idempotency at all. The merchant
  API protects authorize, capture and refunds with an `Idempotency-Key`; the admin plane
  had nothing, and the console sent nothing that could tell a retry from a new request.
- **Why:** a request that times out may or may not have been applied. Without a key the
  server cannot know that the second request is the same intent, so it does the work again.
  The UI also clears the form only on success, so a failed-looking credit invites a resubmit.
- **Breaks:** a merchant is credited twice (real money paid out at the next settlement) and
  the audit log shows two deliberate actions. Below the 50 BD approval limit nobody else
  reviews it, so the duplicate goes straight to the ledger.
- **Fix:**
  - **Server.** Both routes read an optional `Idempotency-Key` header
    (`admin/adminIdempotency.ts`). The key is claimed in the *same* transaction that posts the
    money, through the platform's existing `claimIdempotencyKey` / `completeIdempotencyKey`
    and `idempotency_keys` table (called, not changed). The scope is
    (merchant, `admin.credits.create` or `admin.balance_adjustments.create`,
    `<admin user id>:<key>`), so a key is private to the admin who sent it: one admin can
    never replay, or collide with, another admin's action. The request hash covers the body,
    so the same key with a different amount is `422 idempotency_key_reused`. A completed key
    replays the stored response (same status, same body, same credit id) and writes nothing:
    no new credit row, ledger group, cache move or audit row. A concurrent duplicate blocks on
    the unique index until the first commits, then replays it. Because claim and posting
    commit or roll back together, a request that failed leaves no claim and its retry runs
    fresh. An empty or over-long key is `400 invalid_idempotency_key`.
  - **Console.** Each form keeps one attempt (`utils/idempotencyIntent.ts`, the same helper
    the merchant dashboard uses for refunds): a re-submit of the same merchant and body after
    a network error, a 5xx, a 429 or `409 request_in_progress` reuses the key; a success or a
    definitive 4xx clears it, and any change to the inputs mints a new key.
  - **Design choice: the header is optional.** Requiring it would break any existing client
    or script that calls these admin routes today. With no key the behaviour is exactly as
    before; the console, which is the client that actually retries, always sends one.
    Making it required later is a one-line change in `readIdempotencyKeyHeader`.
  - **Smallest change:** no migration and no new table; `payments/idempotency.ts` is reused
    as is. The money logic of both actions (four-eyes by admin id, effective date, fee
    reversal at the effective rate) is untouched; the claim sits right after the merchant is
    found and the response is stored right before commit.
- **Test:** `apps/api/src/routes/adminCredits.test.ts` and
  `apps/api/src/routes/adminBalanceAdjustments.test.ts`, plus
  `apps/admin/src/utils/idempotencyIntent.test.ts` for the console rule.
  - *a retried credit with the same Idempotency-Key posts once and replays the first
    response*: one credit row, one ledger group, cache 40,000 fils, one audit row.
  - *two concurrent credits with the same Idempotency-Key post once*: both `201`, same id.
  - *a key reused for another amount is a 422, a key is private to its admin, and a bad key
    is a 400*.
  - *a retried adjustment with the same Idempotency-Key moves the balance once* and
    *reusing an adjustment key for a different delta is a 422 and moves nothing*.
  - Fail-before: with the old `credits.ts`, `balanceAdjustments.ts` and both old routes, these
    five fail (two different credit ids for one key; `422` expected, `200` / `201` actual).
    With the fix all 26 tests in the two route files pass.

## Support credits have no daily cap — product decision, not changed

**Where:** `apps/api/src/admin/credits.ts` (`createCreditRequest`), `admin/creditThreshold.ts`,
`routes/adminCredits.ts` (`POST /v1/admin/merchants/:id/credits`, any admin role).

**Evidence (2026-10-30, throwaway probe, not committed):** one `support` admin issues ten
credits of 50.000 BD (`reverseFee: true`, 250 bps) to one merchant on the same day. All ten
return `201 posted` at 51,250 fils each, `merchant_payable` is credited 512,500 fils
(512.500 BD), and none needed a second approver.

- **What:** the second-approver rule is checked per credit, on its principal only. Nothing
  adds up an admin's or a merchant's credits over a day, so any number of credits at or
  below 50.000 BD post at once, from any role, support included.
- **What the docs say:** `ADMIN.md` lets support "issue small credits" and sends anything
  over 50.000 BD (principal only) to a second person. Neither `ADMIN.md`, `ARCHITECTURE.md`
  ("Credits above the threshold need a second approver") nor any ADR mentions a daily or
  cumulative cap. So the code matches the docs, and adding a cap would mean inventing a
  limit and a number.
- **Why it matters:** the CSV import closes the same gap by measuring the whole upload
  ("20,000 rows of 50 BD", above). For credits, splitting one large credit into
  threshold-sized pieces still gets around the second approver.
- **Decision needed (finance/product):** whether there is a cap at all; whether it applies per
  admin, per merchant or both, and over a Bahrain business day or a rolling 24 h; whether
  credits above the cap are queued for approval (as imports are) or refused; and whether the
  fee reversal counts. One way to build it would be to count the requester's credits posted
  today plus the new one in `creditRequiresSecondApprover`, under a lock.
- **Related mismatch:** the console hides **Issue credit** from support ("Your role cannot
  issue credits", `MerchantDetailPage.tsx`), while the API and `ADMIN.md` allow it. Decide
  this together with the cap.
