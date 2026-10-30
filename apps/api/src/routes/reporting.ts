import type { FastifyInstance } from "fastify";
import { requireMerchantAuth } from "../auth/requireMerchantAuth.js";
import {
  decodeReportCursor,
  runTransactionsReportPage,
  type TransactionReportFilter,
} from "../reporting/transactionsReportQuery.js";
import { resolveReportMerchantId } from "../reporting/scope.js";
import { createSavedFilter, listSavedFilters } from "../reporting/savedFilters.js";
import { BadRequestError } from "../lib/errors.js";
import { isUuid } from "../lib/requestParams.js";

interface ReportQuery {
  filter?: string;
  /** From the previous page's X-Next-Cursor header. */
  cursor?: string;
}

interface SaveFilterBody {
  name?: string;
  filter?: Record<string, unknown>;
}

/** Valid JSON is not yet a valid filter: `null`, an array, a non-string
 *  field, a non-UUID merchantId or an unparseable from/to used to reach
 *  the code or SQL below and come back as a 500. */
function assertValidReportFilter(parsed: unknown): asserts parsed is Partial<TransactionReportFilter> {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BadRequestError("invalid_filter", "filter must be a JSON object");
  }
  const f = parsed as Record<string, unknown>;
  for (const key of ["merchantId", "status", "from", "to"] as const) {
    if (f[key] !== undefined && typeof f[key] !== "string") {
      throw new BadRequestError("invalid_filter", `filter.${key} must be a string`);
    }
  }
  if (f.merchantId !== undefined && f.merchantId !== "" && !isUuid(f.merchantId)) {
    throw new BadRequestError("invalid_filter", "filter.merchantId must be a UUID");
  }
  for (const key of ["from", "to"] as const) {
    if (f[key] && Number.isNaN(new Date(f[key] as string).getTime())) {
      throw new BadRequestError("invalid_filter", `filter.${key} must be an ISO-8601 date-time`);
    }
  }
}

/**
 * Registered with prefix '/v1/reporting'. `requireMerchantAuth` only, same
 * authorization level as `/v1/analytics/*` — nothing here is more sensitive
 * than a merchant reading their own transaction list already is (in the
 * intended, single-merchant case).
 */
export async function reportingRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ReportQuery }>(
    "/transactions",
    { preHandler: requireMerchantAuth },
    async (request, reply) => {
      let parsed: Partial<TransactionReportFilter> = {};
      if (request.query.filter) {
        try {
          parsed = JSON.parse(request.query.filter);
        } catch {
          throw new BadRequestError("invalid_filter", "filter must be valid JSON");
        }
        assertValidReportFilter(parsed);
      }

      const merchantId = await resolveReportMerchantId(
        app.db,
        request.merchantAuth!.merchantId,
        parsed.merchantId,
      );

      const cursor = request.query.cursor ? decodeReportCursor(request.query.cursor) : null;
      if (request.query.cursor && !cursor) {
        throw new BadRequestError("invalid_cursor", "cursor is not a value this endpoint issued");
      }

      // The body stays a plain array; a merchant with more than one page of
      // rows is told so in headers instead of getting a silently cut report.
      const page = await runTransactionsReportPage(
        app.db,
        { merchantId, status: parsed.status, from: parsed.from, to: parsed.to },
        cursor,
      );
      reply.header("x-truncated", page.nextCursor ? "true" : "false");
      if (page.nextCursor) reply.header("x-next-cursor", page.nextCursor);
      return page.rows;
    },
  );

  app.post<{ Body: SaveFilterBody }>(
    "/saved-filters",
    { preHandler: requireMerchantAuth },
    async (request, reply) => {
      const { name, filter } = request.body ?? {};
      if (!name || typeof name !== "string") {
        throw new BadRequestError("invalid_request", "name is required");
      }
      if (!filter || typeof filter !== "object") {
        throw new BadRequestError("invalid_request", "filter is required");
      }

      const saved = await createSavedFilter(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        name,
        filter,
      });
      reply.code(201).send(saved);
    },
  );

  app.get(
    "/saved-filters",
    { preHandler: requireMerchantAuth },
    async (request) => listSavedFilters(app.db, { merchantId: request.merchantAuth!.merchantId }),
  );

  app.get("/export-summary", { preHandler: requireMerchantAuth }, async (request) => {
    const result = await app.db.query(
      `SELECT COUNT(*) AS total, SUM(captured_gross_fils) AS gross
         FROM merchant_daily_volume WHERE merchant_id = $1`,
      [request.merchantAuth!.merchantId],
    );
    return { totalDays: Number(result.rows[0]?.total ?? 0), grossFils: Number(result.rows[0]?.gross ?? 0) };
  });
}
