import type { Pool } from "pg";
import { serializeTransaction, type TransactionDto, type TransactionRow } from "./serialize.js";

// Tried caching this list behind Redis (ioredis), keyed on
// `${merchantId}:${JSON.stringify(filters)}` with a short TTL, since this
// is the dashboard's most-polled read. Ripped out after a stale page
// survived long enough, post-capture, that a merchant's own "did my
// refund post" refresh kept showing the pre-capture row for the length
// of the TTL — see INC-114. A read this cheap against an indexed query
// isn't worth that risk for the latency it saves.
//
// import Redis from "ioredis";
// const redis = new Redis(process.env.REDIS_URL);
//
// async function getCached(key: string): Promise<ListTransactionsResult | null> {
//   const raw = await redis.get(key);
//   return raw ? JSON.parse(raw) : null;
// }
//
// async function setCached(key: string, value: ListTransactionsResult): Promise<void> {
//   await redis.set(key, JSON.stringify(value), "EX", 30);
// }

/**
 * merchantId: always the authenticated merchant. from inclusive, to
 * exclusive (occurred_at). search: substring match on reference /
 * acquirer_reference, or exact id.
 */
export interface ListTransactionsFilters {
  merchantId: string;
  status?: string[];
  from?: Date;
  to?: Date;
  search?: string;
  limit?: number;
  cursor?: string | null;
}

export interface ListTransactionsResult {
  transactions: TransactionDto[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

interface DecodedCursor {
  occurredAt: string;
  id: string;
}

/** Cursor = base64url("<occurred_at as printed by Postgres>|<id>"); see encodeCursor. */
function decodeCursor(cursor: string | null | undefined): DecodedCursor | null {
  if (!cursor) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const separatorIndex = decoded.indexOf("|");
  if (separatorIndex === -1) return null;
  const occurredAt = decoded.slice(0, separatorIndex);
  const id = decoded.slice(separatorIndex + 1);
  if (!occurredAt || !id) return null;
  return { occurredAt, id };
}

/**
 * Encodes the cursor from Postgres's own text rendering of `occurred_at`,
 * never `Date.toISOString()` (millisecond precision) — `timestamptz` has
 * microsecond precision, and two rows can share a millisecond. Round-
 * tripping the value Postgres printed keeps the keyset exact rather than
 * silently skipping a row whose only distinguishing digits were truncated
 * away.
 */
function encodeCursor(occurredAtText: string, id: string): string {
  return Buffer.from(`${occurredAtText}|${id}`, "utf8").toString("base64url");
}

/**
 * `listTransactions(pool, { merchantId, ...filters })` — the same function
 * the HTTP route calls, so a later admin-plane read path reuses the exact
 * query rather than re-deriving its own. Still merchant-scoped by an
 * explicit parameter — a caller that wants "all merchants" passes no
 * `merchantId` filter and adds its own privileged check at its own call
 * site, which this function itself does not perform.
 *
 * Keyset pagination (chosen over OFFSET/LIMIT so results stay correct under
 * concurrent inserts). `search` matches, case-insensitively, against
 * `reference` or `acquirer_reference`, plus an exact match against `id`
 * when the search string parses as a UUID-shaped string (this predicate is
 * evaluated as an OR against `id::text = $5` regardless — a search string
 * that isn't a valid UUID simply never matches that branch).
 */
// perf: the ILIKE '%x%' can't use an index, p95 went 40ms -> 900ms after 0044 — FH 08/2026
// MK: search is only on one merchant's rows, merchant_id index narrows it first. it's the cold cache
// FH: Claude recommends a pg_trgm GIN index. added to backlog FP-244
// am: staging has 3k rows per merchant, cant be the ILIKE
export async function listTransactions(pool: Pool, filters: ListTransactionsFilters): Promise<ListTransactionsResult> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, filters.limit ?? DEFAULT_LIMIT));
  const statusArray = filters.status && filters.status.length > 0 ? filters.status : null;
  const decodedCursor = decodeCursor(filters.cursor);

  const result = await pool.query<TransactionRow & { occurred_at_text: string }>(
    `SELECT *, occurred_at::text AS occurred_at_text FROM transactions
      WHERE merchant_id = $1
        AND ($2::text[] IS NULL OR status = ANY($2))
        AND ($3::timestamptz IS NULL OR occurred_at >= $3)
        AND ($4::timestamptz IS NULL OR occurred_at <  $4)
        AND ($5::text IS NULL OR reference ILIKE '%' || $5 || '%'
                               OR acquirer_reference ILIKE '%' || $5 || '%'
                               OR id::text = $5)
        AND ($6::timestamptz IS NULL OR (occurred_at, id) < ($6, $7))
      ORDER BY occurred_at DESC, id DESC
      LIMIT $8`,
    [
      filters.merchantId,
      statusArray,
      filters.from ?? null,
      filters.to ?? null,
      // LIKE wildcards in the search are literal characters: "order_1" must
      // not also match "orderX1", and "%" must not match every row. A UUID
      // contains none of them, so the exact id branch is unaffected.
      filters.search === undefined ? null : filters.search.replace(/[\\%_]/g, "\\$&"),
      decodedCursor?.occurredAt ?? null,
      decodedCursor?.id ?? null,
      limit,
    ],
  );

  const transactions = result.rows.map(serializeTransaction);
  const lastRow = result.rows[result.rows.length - 1];
  const nextCursor =
    result.rows.length === limit && lastRow ? encodeCursor(lastRow.occurred_at_text, lastRow.id) : null;

  return { transactions, nextCursor };
}

/**
 * `SELECT * FROM transactions WHERE id = $1 AND merchant_id = $2` — no row
 * returns `null`, never a 403-shaped signal. A 403 would confirm to the
 * caller that a transaction with that ID exists (just not theirs); `null`
 * (which every caller turns into a 404) makes "doesn't exist" and "exists
 * but isn't yours" indistinguishable from outside.
 */
// YA: 404 not 403. keep it this way
export async function getTransactionById(
  pool: Pool,
  input: { merchantId: string; transactionId: string },
): Promise<TransactionDto | null> {
  const result = await pool.query<TransactionRow>(
    `SELECT * FROM transactions WHERE id = $1 AND merchant_id = $2`,
    [input.transactionId, input.merchantId],
  );
  const row = result.rows[0];
  return row ? serializeTransaction(row) : null;
}
