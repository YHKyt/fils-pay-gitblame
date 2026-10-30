-- Adjustment imports: duplicate detection and the second approver.
--
-- Until now an uploaded CSV was posted the moment it arrived, by one person,
-- and nothing stopped the same file being posted again. This adds:
--
-- * content_sha256: a digest of the import's rows as stored in
--   adjustment_import_rows (merchant, parsed fils, reason). It ignores row
--   order, whitespace, the amount's spelling ("4.75" vs "4.750") and the
--   filename, so a re-export of the same sheet is still recognised. The
--   partial unique index refuses a second live import with the same content.
--   A rejected import never posted anything, so it does not block a
--   re-upload. The digest is defined once, in adjustment_import_content_sha256
--   below, and the API calls the same function, so the backfill and new
--   uploads can never disagree.
-- * the maker-checker shape credit_requests (0060) uses: an import whose gross
--   amount (sum of |row|) is above the credit approval threshold is stored as
--   pending_approval and posts only when a different admin approves it.
--
-- Safe on a populated database: every existing import was applied on upload,
-- so existing rows default to status 'posted' with requires_approval false and
-- keep their applied_at. Existing imports are backfilled with their digest so a
-- file uploaded before this release cannot be replayed after it. Where history
-- already holds duplicates (the bug this fixes), only the earliest copy gets
-- the digest; the later copies keep NULL, which the unique index ignores, so
-- the migration cannot fail on them and they stay visible for reconciliation.

CREATE FUNCTION adjustment_import_content_sha256(p_import_id UUID) RETURNS TEXT
LANGUAGE sql STABLE AS $$
    SELECT encode(sha256(convert_to(string_agg(row_digest, ',' ORDER BY row_digest COLLATE "C"), 'UTF8')), 'hex')
      FROM (
        SELECT encode(sha256(convert_to(
                 merchant_id::text || '|' || parsed_amount_fils::text || '|' || coalesce(reason, ''),
                 'UTF8')), 'hex') AS row_digest
          FROM adjustment_import_rows
         WHERE adjustment_import_id = p_import_id
      ) AS rows_of_import
$$;

ALTER TABLE adjustment_imports
    ADD COLUMN content_sha256             TEXT,
    ADD COLUMN requires_approval          BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN status                     TEXT NOT NULL DEFAULT 'posted'
        CHECK (status IN ('pending_approval', 'posted', 'rejected')),
    ADD COLUMN approved_by_admin_user_id  UUID REFERENCES admin_users (id),
    ADD COLUMN approved_at                TIMESTAMPTZ,
    ADD COLUMN rejected_by_admin_user_id  UUID REFERENCES admin_users (id),
    ADD COLUMN rejected_at                TIMESTAMPTZ,
    -- applied_at now means "posted to the ledger"; a pending import has none.
    ALTER COLUMN applied_at DROP NOT NULL;

ALTER TABLE adjustment_imports
    ADD CONSTRAINT adjustment_imports_posted_shape CHECK (
        (status = 'posted') = (applied_at IS NOT NULL)
    ),
    ADD CONSTRAINT adjustment_imports_rejected_shape CHECK (
        (status = 'rejected') = (rejected_at IS NOT NULL)
    ),
    -- An approval is only ever recorded on an import that needed one.
    ADD CONSTRAINT adjustment_imports_approval_shape CHECK (
        (approved_by_admin_user_id IS NULL) = (approved_at IS NULL)
        AND (approved_at IS NULL OR requires_approval)
    );

UPDATE adjustment_imports ai
   SET content_sha256 = earliest.digest
  FROM (
    SELECT DISTINCT ON (digest) id, digest
      FROM (
        SELECT id, created_at, adjustment_import_content_sha256(id) AS digest
          FROM adjustment_imports
      ) AS hashed
     WHERE digest IS NOT NULL
     ORDER BY digest, created_at, id
  ) AS earliest
 WHERE ai.id = earliest.id;

CREATE UNIQUE INDEX adjustment_imports_content_once
    ON adjustment_imports (content_sha256)
    WHERE content_sha256 IS NOT NULL AND status <> 'rejected';

CREATE INDEX idx_adjustment_imports_pending
    ON adjustment_imports (created_at DESC)
    WHERE status = 'pending_approval';
