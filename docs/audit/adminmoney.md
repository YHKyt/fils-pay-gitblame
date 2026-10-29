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
    With the fix, all 28 import tests pass.
