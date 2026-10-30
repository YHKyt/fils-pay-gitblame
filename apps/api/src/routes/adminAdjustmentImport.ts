import type { FastifyInstance } from "fastify";
import { requireAdminRole, requireAdminSession } from "../adminAuth/middleware.js";
import {
  applyAdjustmentImport,
  approveAdjustmentImport,
  getAdjustmentImportRows,
  listAdjustmentImports,
  rejectAdjustmentImport,
} from "../admin/adjustmentImport.js";
import { parseAdjustmentCsv } from "../admin/adjustmentCsvParsing.js";
import { UUID_RE } from "../admin/merchants.js";
import { BadRequestError, NotFoundError, UnauthorizedError } from "../lib/errors.js";

interface ImportIdParams {
  id: string;
}

/**
 * csvContent: "merchantId,amount,reason" rows, amount in BD with up to 3
 * decimals (e.g. 4.750). originalFilename is informational only.
 */
interface CreateImportBody {
  csvContent?: unknown;
  originalFilename?: unknown;
}

interface ListQuery {
  limit?: string;
  cursor?: string;
}

/** Registered with prefix '/v1/admin/adjustment-imports'. */
export async function adminAdjustmentImportRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Upload a CSV of manual balance adjustments. A batch at or below the
   * credit approval threshold (gross) posts on upload; above it, the batch
   * is stored as pending_approval and posts only when a different admin
   * approves it (POST /:id/approve). An identical batch that is already
   * posted or pending is returned as-is with 200 (idempotent replay), so a
   * re-upload of the same file never posts twice and never gets stuck on a
   * permanent 409. See applyAdjustmentImport.
   *
   * finance/super_admin only — every row posts real money.
   */
  app.post<{ Body: CreateImportBody }>(
    "/",
    { preHandler: [requireAdminSession, requireAdminRole("finance", "super_admin")] },
    async (request, reply) => {
      const adminAuth = request.adminAuth;
      if (!adminAuth) throw new UnauthorizedError("unauthenticated");

      const { csvContent, originalFilename } = request.body ?? {};
      if (typeof csvContent !== "string" || csvContent.trim() === "") {
        throw new BadRequestError("invalid_request", "csvContent is required and must be a non-empty string");
      }
      if (originalFilename !== undefined && typeof originalFilename !== "string") {
        throw new BadRequestError("invalid_request", "originalFilename, if given, must be a string");
      }

      // FH: parseAdjustmentCsv handles 3dp BD amounts correctly (4.750 -> 4750 fils), Claude checked
      const rows = parseAdjustmentCsv(csvContent);
      for (const row of rows) {
        if (!UUID_RE.test(row.merchantId)) {
          throw new BadRequestError("invalid_csv_row", `"${row.merchantId}" is not a merchant id`);
        }
      }

      const result = await applyAdjustmentImport(app.db, {
        adminUserId: adminAuth.adminUserId,
        originalFilename: originalFilename ?? "pasted.csv",
        rows,
      });

      reply.code(result.replayed ? 200 : 201).send(result);
    },
  );

  /** History of past imports. Any admin role — a read. */
  app.get<{ Querystring: ListQuery }>(
    "/",
    { preHandler: [requireAdminSession] },
    async (request) => {
      const limit = request.query.limit !== undefined ? Number.parseInt(request.query.limit, 10) : undefined;
      return listAdjustmentImports(app.db, {
        limit: Number.isFinite(limit) ? limit : undefined,
        cursor: request.query.cursor ?? null,
      });
    },
  );

  /** Per-row detail — the raw CSV text next to the integer that was posted. */
  app.get<{ Params: ImportIdParams }>(
    "/:id/rows",
    { preHandler: [requireAdminSession] },
    async (request) => {
      if (!UUID_RE.test(request.params.id)) {
        throw new NotFoundError("adjustment_import_not_found");
      }
      const rows = await getAdjustmentImportRows(app.db, request.params.id);
      if (rows.length === 0) {
        throw new NotFoundError("adjustment_import_not_found");
      }
      return { rows };
    },
  );

  /**
   * Second approver for a held import: posts every row. 409
   * self_approval_forbidden for the uploader, 409 adjustment_import_not_pending
   * once decided. finance/super_admin only.
   */
  app.post<{ Params: ImportIdParams }>(
    "/:id/approve",
    { preHandler: [requireAdminSession, requireAdminRole("finance", "super_admin")] },
    async (request) => {
      const adminAuth = request.adminAuth;
      if (!adminAuth) throw new UnauthorizedError("unauthenticated");
      if (!UUID_RE.test(request.params.id)) {
        throw new NotFoundError("adjustment_import_not_found");
      }
      return approveAdjustmentImport(app.db, { importId: request.params.id, adminUserId: adminAuth.adminUserId });
    },
  );

  /** Closes a held import; nothing is posted. finance/super_admin only. */
  app.post<{ Params: ImportIdParams }>(
    "/:id/reject",
    { preHandler: [requireAdminSession, requireAdminRole("finance", "super_admin")] },
    async (request) => {
      const adminAuth = request.adminAuth;
      if (!adminAuth) throw new UnauthorizedError("unauthenticated");
      if (!UUID_RE.test(request.params.id)) {
        throw new NotFoundError("adjustment_import_not_found");
      }
      return rejectAdjustmentImport(app.db, { importId: request.params.id, adminUserId: adminAuth.adminUserId });
    },
  );
}
