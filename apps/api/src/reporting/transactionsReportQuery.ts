import type { Pool } from "pg";
import { formatBhd, toFils } from "@filspay/money";

/**
 * Report predicate. `merchantId` is always overwritten by the route with the
 * authenticated merchant before this reaches runTransactionsReport, so a
 * value supplied in the saved filter body is ignored.
 */
export interface TransactionReportFilter {
  merchantId: string;
  status?: string;
  from?: string;
  to?: string;
}

/** Money is pre-formatted as BD strings with 3 decimals (formatBhd), unlike the rest of the API which returns fils. */
export interface TransactionReportRow {
  id: string;
  merchantId: string;
  status: string;
  amountBhd: string;
  capturedBhd: string;
  reference: string | null;
  occurredAt: string;
}

interface TransactionReportQueryRow {
  id: string;
  merchant_id: string;
  status: string;
  amount_fils: string | number;
  captured_fils: string | number;
  reference: string | null;
  occurred_at: Date;
}

/** Page size of the report. Before paging existed the query simply stopped
 *  here, so a merchant with more rows got a silently cut report. */
export const REPORT_PAGE_SIZE = 500;

export interface TransactionReportPage {
  rows: TransactionReportRow[];
  /** Opaque keyset cursor for the next page, or null when this is the last. */
  nextCursor: string | null;
}

interface DecodedReportCursor {
  occurredAt: string;
  id: string;
}

/** The cursor carries occurred_at as Postgres text, not a JS Date, so the
 *  microseconds survive and no row is skipped or repeated at a page edge. */
export function decodeReportCursor(cursor: string): DecodedReportCursor | null {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const sep = decoded.lastIndexOf("|");
  if (sep <= 0) return null;
  const occurredAt = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:\d{2})?)?$/.test(occurredAt)) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  return { occurredAt, id };
}

function encodeReportCursor(occurredAtText: string, id: string): string {
  return Buffer.from(`${occurredAtText}|${id}`, "utf8").toString("base64url");
}

export async function runTransactionsReportPage(
  pool: Pool,
  filter: TransactionReportFilter,
  cursor?: DecodedReportCursor | null,
): Promise<TransactionReportPage> {
  const params: unknown[] = [filter.merchantId];
  const conditions: string[] = ["merchant_id = $1"];
  if (filter.status) {
    params.push(filter.status);
    conditions.push(`status = $${params.length}`);
  }
  if (filter.from) {
    params.push(filter.from);
    conditions.push(`occurred_at >= $${params.length}`);
  }
  if (filter.to) {
    params.push(filter.to);
    conditions.push(`occurred_at < $${params.length}`);
  }
  if (cursor) {
    params.push(cursor.occurredAt, cursor.id);
    conditions.push(`(occurred_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  // One extra row tells us whether another page exists.
  params.push(REPORT_PAGE_SIZE + 1);

  const result = await pool.query<TransactionReportQueryRow & { occurred_at_text: string }>(
    `SELECT id, merchant_id, status, amount_fils, captured_fils, reference, occurred_at,
            occurred_at::text AS occurred_at_text
       FROM transactions
      WHERE ${conditions.join(" AND ")}
      ORDER BY occurred_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
  const pageRows = result.rows.slice(0, REPORT_PAGE_SIZE);
  const last = pageRows[pageRows.length - 1];
  return {
    rows: pageRows.map((row) => ({
      id: row.id,
      merchantId: row.merchant_id,
      status: row.status,
      amountBhd: formatBhd(toFils(Number(row.amount_fils))),
      capturedBhd: formatBhd(toFils(Number(row.captured_fils))),
      reference: row.reference,
      occurredAt: row.occurred_at.toISOString(),
    })),
    nextCursor: result.rows.length > REPORT_PAGE_SIZE && last ? encodeReportCursor(last.occurred_at_text, last.id) : null,
  };
}

/** First page only; kept for callers that want just the rows. */
export async function runTransactionsReport(
  pool: Pool,
  filter: TransactionReportFilter,
): Promise<TransactionReportRow[]> {
  return (await runTransactionsReportPage(pool, filter)).rows;
}
