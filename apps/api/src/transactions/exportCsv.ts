import { Readable } from "node:stream";
import type { Pool } from "pg";
import { formatBhd, toFils } from "@filspay/money";
import type { TransactionRow } from "./serialize.js";

export interface TransactionsExportFilters {
  merchantId: string;
  from?: Date;
  to?: Date;
  status?: string[];
}

/**
 * Escapes one free-text cell. A cell a spreadsheet would read as a formula
 * (leading = + - @, or a tab/CR that some importers strip first) is prefixed
 * with a single quote so Excel/Sheets show it as text (CSV/formula injection).
 */
function csvEscape(raw: string): string {
  const value = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvRow(row: TransactionRow): string {
  return [
    row.id,
    row.status,
    formatBhd(toFils(Number(row.amount_fils))),
    formatBhd(toFils(Number(row.captured_fils))),
    csvEscape(row.reference ?? ""),
    row.occurred_at.toISOString(),
  ].join(",");
}

/** Rows per keyset page: the most rows an export ever holds in memory at once. */
export const EXPORT_PAGE_SIZE = 1000;

type ExportRow = TransactionRow & { occurred_at_text: string };

/**
 * The CSV body for `GET /v1/transactions/export`, one keyset page at a time,
 * so memory stays at one page however long the merchant's history is (the
 * API runs in 512 MB). The keyset is (occurred_at, id) — occurred_at alone is
 * not unique — and the cursor is Postgres's own text for occurred_at
 * (microseconds), never a JS Date (milliseconds), as in listTransactions.
 * The header goes out with the first page and lines are joined by "\n", so
 * the chunks concatenate to exactly the old one-string body.
 */
export async function* streamTransactionsExportCsv(
  pool: Pool,
  filters: TransactionsExportFilters,
  pageSize: number = EXPORT_PAGE_SIZE,
): AsyncGenerator<string> {
  const statusArray = filters.status && filters.status.length > 0 ? filters.status : null;
  let cursor: { occurredAt: string; id: string } | null = null;
  let chunk = "id,status,amount_bhd,captured_bhd,reference,occurred_at";

  for (;;) {
    const result: { rows: ExportRow[] } = await pool.query<ExportRow>(
      `SELECT *, occurred_at::text AS occurred_at_text FROM transactions
        WHERE merchant_id = $1
          AND ($2::timestamptz IS NULL OR occurred_at >= $2)
          AND ($3::timestamptz IS NULL OR occurred_at <  $3)
          AND ($4::text[] IS NULL OR status = ANY($4))
          AND ($5::timestamptz IS NULL OR (occurred_at, id) > ($5, $6))
        ORDER BY occurred_at ASC, id ASC
        LIMIT $7`,
      [
        filters.merchantId,
        filters.from ?? null,
        filters.to ?? null,
        statusArray,
        cursor?.occurredAt ?? null,
        cursor?.id ?? null,
        pageSize,
      ],
    );

    for (const row of result.rows) {
      chunk += `\n${toCsvRow(row)}`;
    }
    if (chunk !== "") yield chunk;
    if (result.rows.length < pageSize) return;

    const last = result.rows[result.rows.length - 1]!;
    cursor = { occurredAt: last.occurred_at_text, id: last.id };
    chunk = "";
  }
}

/**
 * The export as a byte stream for the route. Resolves only after the first
 * page has been read, so a failing query is still an ordinary error response
 * rather than a 200 download cut off after the headers.
 */
export async function openTransactionsExportStream(
  pool: Pool,
  filters: TransactionsExportFilters,
): Promise<Readable> {
  const chunks = streamTransactionsExportCsv(pool, filters);
  const first = await chunks.next();
  return Readable.from(
    (async function* () {
      if (!first.done) yield first.value;
      yield* chunks;
    })(),
    { objectMode: false },
  );
}

/** The whole export as one string. Holds every row in memory, so only for
 *  tests and small bounded callers — the route streams. */
export async function buildTransactionsExportCsv(
  pool: Pool,
  filters: TransactionsExportFilters,
): Promise<string> {
  let csv = "";
  for await (const chunk of streamTransactionsExportCsv(pool, filters)) {
    csv += chunk;
  }
  return csv;
}