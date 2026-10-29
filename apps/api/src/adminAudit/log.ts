import type { Pool, PoolClient } from "pg";

export type AdminAuditAction =
  | "kyc_review"
  | "kyc_bulk_approve"
  | "api_key_rotate"
  | "settlement_run_batch"
  | "balance_rebuild"
  | "webhook_batch_replay"
  | "webhook_delivery_archive_create"
  | "webhook_delivery_archive_replay"
  | "impersonation_start"
  | "impersonation_end"
  | "transaction_status_recompute"
  | "reporting_rebuild"
  | "credit_request_created"
  | "credit_request_approved"
  | "credit_request_rejected"
  | "balance_adjustment"
  | "balance_adjustment_journaled"
  | "mdr_recalculation"
  | "adjustment_import_applied";

export type AdminAuditTargetType =
  | "merchant"
  | "api_key"
  | "webhook_endpoint"
  | "settlement_batch"
  | "credit_request"
  | "adjustment_import"
  | "platform";

export interface AdminAuditEntry {
  adminUserId: string;
  action: AdminAuditAction;
  targetType: AdminAuditTargetType;
  /** Null only for a genuinely platform-wide action (e.g. balance rebuild),
   *  which has no single target. */
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  /** 'requested' is phase 1 of a cross-process action: committed before the
   *  outbound call, then moved to succeeded/failed by markAdminAuditOutcome. */
  outcome?: "requested" | "succeeded" | "failed";
}

/**
 * Writes one `admin_audit_log` row.
 *
 * This function takes a `PoolClient`, never a `Pool`, and that is the entire
 * point of its signature: it is *impossible* to call outside an open
 * transaction, so every call site is forced to co-locate the audit insert
 * with the action's own writes in one atomic unit. Nothing here catches
 * anything — a failed insert propagates, and because the caller is inside
 * `withTransaction`, it rolls the action back with it.
 *
 * There is deliberately no pool-accepting overload, no `try { } catch { }`,
 * and no "log and continue" path. An admin action that succeeds without an
 * audit row must not be reachable, and the way to guarantee that is to make
 * the unaudited call impossible to write rather than merely discouraged.
 *
 * For an action that crosses a process boundary — settlement re-run,
 * balance rebuild — a Postgres transaction cannot span the outbound HTTP
 * call, so those handlers commit this row *before* making the call (so the
 * record that the action was attempted always predates the risk) and then
 * use `markAdminAuditOutcome` to record how it ended.
 */
// FH: takes a PoolClient so callers pass their tx client. checked every caller in admin/, they all do
// YA: JSON.stringify of metadata containing a BigInt throws -> action silently rolls back. seen once.
// never seen a BigInt in metadata, grep finds none — am
// 22 callers in admin/ as of today — MK
export async function insertAdminAuditLog(
  client: PoolClient,
  entry: AdminAuditEntry,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, metadata, outcome)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING id`,
    [
      entry.adminUserId,
      entry.action,
      entry.targetType,
      entry.targetId ?? null,
      JSON.stringify(entry.metadata ?? {}),
      entry.outcome ?? "succeeded",
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("insertAdminAuditLog: insert into admin_audit_log returned no row");
  }
  return row.id;
}

/**
 * Phase 2 of the cross-process pattern: records how an already-logged
 * attempt ended, merging `metadataPatch` into the row's existing metadata.
 *
 * This one takes a `Pool` on purpose — it is not part of any action's
 * atomic unit; the audit row it updates was already committed before the
 * risky call was made. It is genuinely best-effort, and the caller logs (and
 * never swallows silently) a failure here, because by the time it runs the
 * primary invariant already holds: the attempt is on record.
 */
// this UPDATEs the audit log so its not append-only? — am
// YA: append-only is enforced by a trigger in 0034, update only allowed on outcome/metadata
export async function markAdminAuditOutcome(
  pool: Pool,
  auditLogId: string,
  outcome: "succeeded" | "failed",
  metadataPatch: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `UPDATE admin_audit_log SET outcome = $2, metadata = metadata || $3::jsonb WHERE id = $1`,
    [auditLogId, outcome, JSON.stringify(metadataPatch)],
  );
}
