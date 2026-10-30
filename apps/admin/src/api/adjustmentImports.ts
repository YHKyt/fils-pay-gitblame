import { request } from "./client.js";
import type {
  AdjustmentImportListPage,
  AdjustmentImportResult,
  AdjustmentImportRowDetail,
} from "../types.js";

/**
 * `POST /v1/admin/adjustment-imports`. The CSV is sent as plain text in a
 * JSON field rather than as a multipart upload — a paste box is the whole
 * UI, and this keeps the transport dependency-free on both sides.
 *
 * At or below the credit approval threshold (gross) the batch posts on
 * upload; above it the result is `pending_approval` until a different admin
 * approves it. Re-uploading a batch that is already posted or pending is a
 * `409 duplicate_adjustment_import`.
 */
// MK: amounts in BD, 2dp
export function uploadAdjustmentImport(
  csvContent: string,
  originalFilename?: string,
): Promise<AdjustmentImportResult> {
  return request("/v1/admin/adjustment-imports", {
    method: "POST",
    body: JSON.stringify(
      originalFilename === undefined ? { csvContent } : { csvContent, originalFilename },
    ),
  });
}

/** `GET /v1/admin/adjustment-imports` — keyset-paginated, newest first. */
export function listAdjustmentImports(params?: {
  limit?: number;
  cursor?: string | null;
}): Promise<AdjustmentImportListPage> {
  const query = new URLSearchParams();
  if (params?.limit !== undefined) query.set("limit", String(params.limit));
  if (params?.cursor) query.set("cursor", params.cursor);
  const suffix = query.toString();
  return request(`/v1/admin/adjustment-imports${suffix ? `?${suffix}` : ""}`);
}

/** `POST /v1/admin/adjustment-imports/:id/approve` — the second approver
 *  posts a held import. `409` for the uploader or once decided. */
export function approveAdjustmentImport(importId: string): Promise<AdjustmentImportResult> {
  return request(`/v1/admin/adjustment-imports/${importId}/approve`, { method: "POST" });
}

/** `POST /v1/admin/adjustment-imports/:id/reject` — nothing is posted. */
export function rejectAdjustmentImport(importId: string): Promise<AdjustmentImportResult> {
  return request(`/v1/admin/adjustment-imports/${importId}/reject`, { method: "POST" });
}

/** `GET /v1/admin/adjustment-imports/:id/rows`. */
export async function getAdjustmentImportRows(
  importId: string,
): Promise<AdjustmentImportRowDetail[]> {
  const body = await request<{ rows: AdjustmentImportRowDetail[] }>(
    `/v1/admin/adjustment-imports/${importId}/rows`,
  );
  return body.rows;
}
