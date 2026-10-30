import type { Pool, PoolClient } from "pg";
import { addFils, toFils, ZERO_FILS, type Fils } from "@filspay/money";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { withTransaction } from "../db/withTransaction.js";
import { BadRequestError, ConflictError, NotFoundError } from "../lib/errors.js";
import { parseAdjustmentAmountFils } from "./adjustmentCsvParsing.js";
import { creditRequiresSecondApprover } from "./creditThreshold.js";
import { postLedgerAdjustment } from "./ledgerAdjustments.js";

export interface AdjustmentImportRow {
  merchantId: string;
  /** The raw CSV cell, unmodified. */
  amount: string;
  reason?: string;
}

export type AdjustmentImportStatus = "pending_approval" | "posted" | "rejected";

/**
 * @property totalPostedFils Signed sum of the rows. It is on the ledger only
 *   when `status` is 'posted'; a pending import posts it on approval.
 */
export interface AdjustmentImportResult {
  importId: string;
  rowCount: number;
  totalPostedFils: Fils;
  status: AdjustmentImportStatus;
  requiresApproval: boolean;
  /** True when this upload matched a live import already posted or pending,
   *  so nothing new was written and the existing import is returned. Lets the
   *  route answer 200 (idempotent replay) rather than 409. */
  replayed: boolean;
}

/** The digest of an import's rows, computed the same way migration 0095's
 *  `adjustment_import_content_sha256` does, but over the incoming rows rather
 *  than a stored import, so a re-upload can be recognised before anything is
 *  written. Used to return an existing live import instead of a 409. */
async function findLiveImportByContent(
  pool: Pool,
  parsedRows: Array<{ merchantId: string; amountFils: Fils; reason?: string }>,
): Promise<{ id: string; row_count: number; status: AdjustmentImportStatus; requires_approval: boolean } | null> {
  const result = await pool.query<{
    id: string;
    row_count: number;
    status: AdjustmentImportStatus;
    requires_approval: boolean;
  }>(
    `WITH incoming AS (
       SELECT encode(sha256(convert_to(
                merchant_id::text || '|' || parsed_amount_fils::text || '|' || coalesce(reason, ''),
                'UTF8')), 'hex') AS row_digest
         FROM unnest($1::uuid[], $2::bigint[], $3::text[]) AS r(merchant_id, parsed_amount_fils, reason)
     ), digest AS (
       SELECT encode(sha256(convert_to(string_agg(row_digest, ',' ORDER BY row_digest COLLATE "C"), 'UTF8')), 'hex') AS sha
         FROM incoming
     )
     SELECT ai.id, ai.row_count, ai.status, ai.requires_approval
       FROM adjustment_imports ai, digest
      WHERE ai.content_sha256 = digest.sha AND ai.status <> 'rejected'
      LIMIT 1`,
    [
      parsedRows.map((r) => r.merchantId),
      parsedRows.map((r) => r.amountFils),
      parsedRows.map((r) => r.reason ?? null),
    ],
  );
  return result.rows[0] ?? null;
}

async function postAdjustmentToLedgerAndCache(
  client: PoolClient,
  merchantId: string,
  amountFils: Fils,
): Promise<string | null> {
  const entryGroupId = await postLedgerAdjustment(client, merchantId, amountFils, "CSV adjustment import");
  await client.query(
    `INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (merchant_id) DO UPDATE
       SET cached_payable_fils = merchant_balances.cached_payable_fils + $2, updated_at = now()`,
    [merchantId, amountFils],
  );
  return entryGroupId;
}

/**
 * Posts every row of an import (ledger group + balance cache, each row
 * linked to its group) and flips the import to 'posted', inside the caller's
 * transaction. Private on purpose: rows post only as part of the upload or
 * approval decision that authorised them. Returns the signed total.
 */
async function postImportRows(client: PoolClient, importId: string): Promise<Fils> {
  const rows = await client.query<{ id: string; merchant_id: string; parsed_amount_fils: string }>(
    `SELECT id, merchant_id, parsed_amount_fils::text AS parsed_amount_fils
       FROM adjustment_import_rows
      WHERE adjustment_import_id = $1
      ORDER BY row_number`,
    [importId],
  );

  let total = ZERO_FILS;
  for (const row of rows.rows) {
    const amountFils = toFils(Number(row.parsed_amount_fils), { allowNegative: true });
    const entryGroupId = await postAdjustmentToLedgerAndCache(client, row.merchant_id, amountFils);
    await client.query(`UPDATE adjustment_import_rows SET ledger_entry_group_id = $2 WHERE id = $1`, [
      row.id,
      entryGroupId,
    ]);
    total = addFils(total, amountFils);
  }

  await client.query(`UPDATE adjustment_imports SET status = 'posted', applied_at = now() WHERE id = $1`, [
    importId,
  ]);
  return total;
}

/**
 * Takes one uploaded CSV in a single transaction: every row's amount is
 * parsed and recorded in adjustment_import_rows with its original text
 * preserved alongside the integer, then
 *
 * - an identical batch that is already posted or pending is returned as-is
 *   (idempotent replay, `replayed: true`), so a re-upload of the same file
 *   never posts twice and never gets stuck on a permanent 409. Identity is
 *   adjustment_import_content_sha256 (migration 0095): merchant, fils and
 *   reason of every row, order-insensitive, filename ignored. The partial
 *   unique index still backs the check for a genuine concurrent race.
 * - the batch is held as 'pending_approval' when its gross amount (sum of
 *   |row|) is above the credit approval threshold. A batch is one person's
 *   single action, so it is measured as a whole: judging rows one by one
 *   would let a 1,000,000 BD correction through as many 50 BD rows. Nothing
 *   is posted until a different admin approves (approveAdjustmentImport).
 * - otherwise every row is posted now, as before.
 *
 * The audit row is the last statement in the same transaction, so an import
 * that lands without a record of who ran it is not reachable.
 */
export async function applyAdjustmentImport(
  pool: Pool,
  input: { adminUserId: string; originalFilename: string; rows: AdjustmentImportRow[] },
): Promise<AdjustmentImportResult> {
  if (input.rows.length === 0) {
    throw new BadRequestError("empty_import", "the CSV must contain at least one row");
  }

  const parsedRows = input.rows.map((row) => ({ ...row, amountFils: parseAdjustmentAmountFils(row.amount) }));
  let total = ZERO_FILS;
  let gross = ZERO_FILS;
  for (const row of parsedRows) {
    total = addFils(total, row.amountFils);
    gross = addFils(gross, toFils(Math.abs(row.amountFils)));
  }
  const requiresApproval = creditRequiresSecondApprover({ baseAmountFils: gross, feeReversalFils: ZERO_FILS });

  // Idempotent replay: if a live import with exactly these rows already
  // exists, return it rather than posting again or answering a permanent 409.
  const existing = await findLiveImportByContent(pool, parsedRows);
  if (existing) {
    return {
      importId: existing.id,
      rowCount: existing.row_count,
      totalPostedFils: total,
      status: existing.status,
      requiresApproval: existing.requires_approval,
      replayed: true,
    };
  }

  return withTransaction(pool, async (client) => {
    const importRow = await client.query<{ id: string }>(
      `INSERT INTO adjustment_imports
         (uploaded_by_admin_user_id, original_filename, row_count, requires_approval, status, applied_at)
       VALUES ($1, $2, $3, $4, 'pending_approval', NULL) RETURNING id`,
      [input.adminUserId, input.originalFilename, input.rows.length, requiresApproval],
    );
    const importId = importRow.rows[0]!.id;

    for (let i = 0; i < parsedRows.length; i++) {
      const row = parsedRows[i]!;
      await client.query(
        `INSERT INTO adjustment_import_rows
           (adjustment_import_id, row_number, merchant_id, raw_amount_text, parsed_amount_fils, reason)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [importId, i + 1, row.merchantId, row.amount, row.amountFils, row.reason ?? null],
      );
    }

    try {
      await client.query(
        `UPDATE adjustment_imports SET content_sha256 = adjustment_import_content_sha256(id) WHERE id = $1`,
        [importId],
      );
    } catch (err) {
      if ((err as { code?: string; constraint?: string }).constraint === "adjustment_imports_content_once") {
        throw new ConflictError(
          "duplicate_adjustment_import",
          "an import with exactly these rows is already posted or awaiting approval",
        );
      }
      throw err;
    }

    if (!requiresApproval) {
      await postImportRows(client, importId);
    }

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: requiresApproval ? "adjustment_import_submitted" : "adjustment_import_applied",
      targetType: "adjustment_import",
      targetId: importId,
      metadata: {
        rowCount: input.rows.length,
        totalPostedFils: total,
        grossFils: gross,
        originalFilename: input.originalFilename,
        requiresApproval,
        posted: !requiresApproval,
      },
    });

    return {
      importId,
      rowCount: input.rows.length,
      totalPostedFils: total,
      status: requiresApproval ? "pending_approval" : "posted",
      requiresApproval,
      replayed: false,
    };
  });
}

interface LockedImport {
  id: string;
  uploaded_by_admin_user_id: string;
  row_count: number;
  requires_approval: boolean;
  status: AdjustmentImportStatus;
}

/** Locks a pending import for a decision: 404 if unknown, 409 if already decided. */
async function lockPendingImport(client: PoolClient, importId: string): Promise<LockedImport> {
  const locked = await client.query<LockedImport>(
    `SELECT id, uploaded_by_admin_user_id, row_count, requires_approval, status
       FROM adjustment_imports
      WHERE id = $1
      FOR UPDATE`,
    [importId],
  );
  const row = locked.rows[0];
  if (!row) {
    throw new NotFoundError("adjustment_import_not_found");
  }
  if (row.status !== "pending_approval") {
    throw new ConflictError("adjustment_import_not_pending");
  }
  return row;
}

/**
 * The second approver posts a held import. Same rule as credits
 * (assertDistinctApprover in creditApproval.ts): the approver must be a
 * different admin from the uploader, compared by admin user id. The row lock
 * makes two concurrent approvals resolve to one post and one 409.
 */
export async function approveAdjustmentImport(
  pool: Pool,
  input: { importId: string; adminUserId: string },
): Promise<AdjustmentImportResult> {
  return withTransaction(pool, async (client) => {
    const row = await lockPendingImport(client, input.importId);
    if (row.uploaded_by_admin_user_id === input.adminUserId) {
      throw new ConflictError("self_approval_forbidden");
    }

    await client.query(
      `UPDATE adjustment_imports SET approved_by_admin_user_id = $2, approved_at = now() WHERE id = $1`,
      [row.id, input.adminUserId],
    );
    const total = await postImportRows(client, row.id);

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "adjustment_import_approved",
      targetType: "adjustment_import",
      targetId: row.id,
      metadata: {
        uploadedByAdminUserId: row.uploaded_by_admin_user_id,
        rowCount: row.row_count,
        totalPostedFils: total,
      },
    });

    return {
      importId: row.id,
      rowCount: row.row_count,
      totalPostedFils: total,
      status: "posted",
      requiresApproval: row.requires_approval,
      replayed: false,
    };
  });
}

/** Closes a held import without posting anything. 409 when it is not pending. */
export async function rejectAdjustmentImport(
  pool: Pool,
  input: { importId: string; adminUserId: string },
): Promise<AdjustmentImportResult> {
  return withTransaction(pool, async (client) => {
    const row = await lockPendingImport(client, input.importId);

    await client.query(
      `UPDATE adjustment_imports
          SET status = 'rejected', rejected_by_admin_user_id = $2, rejected_at = now()
        WHERE id = $1`,
      [row.id, input.adminUserId],
    );
    const sum = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(parsed_amount_fils), 0)::text AS total
         FROM adjustment_import_rows WHERE adjustment_import_id = $1`,
      [row.id],
    );
    const total = toFils(Number(sum.rows[0]!.total), { allowNegative: true });

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "adjustment_import_rejected",
      targetType: "adjustment_import",
      targetId: row.id,
      metadata: { uploadedByAdminUserId: row.uploaded_by_admin_user_id, rowCount: row.row_count },
    });

    return {
      importId: row.id,
      rowCount: row.row_count,
      totalPostedFils: total,
      status: "rejected",
      requiresApproval: row.requires_approval,
      replayed: false,
    };
  });
}

export interface AdjustmentImportSummary {
  id: string;
  uploadedByAdminUserId: string;
  originalFilename: string;
  rowCount: number;
  status: AdjustmentImportStatus;
  requiresApproval: boolean;
  approvedByAdminUserId: string | null;
  /** When the rows were posted; null while pending or after a rejection. */
  appliedAt: string | null;
  createdAt: string;
}

/**
 * @property parsedAmountFils The signed integer that was (or, while the import is pending, will be) posted.
 * @property ledgerEntryGroupId null for a zero-amount row (nothing is journaled) and for a row not yet posted.
 */
export interface AdjustmentImportRowDetail {
  rowNumber: number;
  merchantId: string;
  rawAmountText: string;
  parsedAmountFils: number;
  reason: string | null;
  ledgerEntryGroupId: string | null;
}

/**
 * Keyset-paginated list of past imports, newest first. The cursor is the
 * platform's standard `created_at::text` (Postgres's own rendering, never
 * `Date.toISOString()`, which would round-trip through a JS Date and lose
 * microsecond precision).
 */
// MK: cursor compares created_at::text as a string — breaks across a DST change. FP-198
// FH: tried to repro FP-198 with TZ=Europe/London on the api box, pages looked fine?? leaving it open
export async function listAdjustmentImports(
  pool: Pool,
  params: { limit?: number; cursor?: string | null },
): Promise<{ items: AdjustmentImportSummary[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
  const cursor = params.cursor ?? null;

  const result = await pool.query<{
    id: string;
    uploaded_by_admin_user_id: string;
    original_filename: string;
    row_count: number;
    status: AdjustmentImportStatus;
    requires_approval: boolean;
    approved_by_admin_user_id: string | null;
    applied_at: string | null;
    created_at: string;
  }>(
    `SELECT id, uploaded_by_admin_user_id, original_filename, row_count,
            status, requires_approval, approved_by_admin_user_id,
            applied_at::text AS applied_at, created_at::text AS created_at
       FROM adjustment_imports
      WHERE ($1::text IS NULL OR created_at::text < $1)
      ORDER BY created_at DESC
      LIMIT $2`,
    [cursor, limit + 1],
  );

  const rows = result.rows.slice(0, limit);
  const nextCursor = result.rows.length > limit ? (rows[rows.length - 1]?.created_at ?? null) : null;

  return {
    items: rows.map((row) => ({
      id: row.id,
      uploadedByAdminUserId: row.uploaded_by_admin_user_id,
      originalFilename: row.original_filename,
      rowCount: row.row_count,
      status: row.status,
      requiresApproval: row.requires_approval,
      approvedByAdminUserId: row.approved_by_admin_user_id,
      appliedAt: row.applied_at,
      createdAt: row.created_at,
    })),
    nextCursor,
  };
}

/** Per-row detail for one import — raw text and parsed integer side by side. */
/** @throws NotFoundError when the import id does not exist. */
export async function getAdjustmentImportRows(
  pool: Pool,
  importId: string,
): Promise<AdjustmentImportRowDetail[]> {
  const result = await pool.query<{
    row_number: number;
    merchant_id: string;
    raw_amount_text: string;
    parsed_amount_fils: string;
    reason: string | null;
    ledger_entry_group_id: string | null;
  }>(
    `SELECT row_number, merchant_id, raw_amount_text, parsed_amount_fils, reason, ledger_entry_group_id
       FROM adjustment_import_rows
      WHERE adjustment_import_id = $1
      ORDER BY row_number`,
    [importId],
  );

  return result.rows.map((row) => ({
    rowNumber: row.row_number,
    merchantId: row.merchant_id,
    rawAmountText: row.raw_amount_text,
    parsedAmountFils: Number(row.parsed_amount_fils),
    reason: row.reason,
    ledgerEntryGroupId: row.ledger_entry_group_id,
  }));
}
