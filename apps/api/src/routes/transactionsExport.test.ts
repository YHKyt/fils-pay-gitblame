/**
 * Regression tests for `GET /v1/transactions/export` on a large merchant
 * (docs/audit/large-export-upload.md). The export used to run one unbounded
 * SELECT and build the whole CSV as one string, so its memory grew with the
 * merchant's history until the 512 MB API container was OOM-killed. It must
 * stream: read the rows a keyset page at a time — never more than one page
 * from Postgres per query — and still return every row exactly once, in
 * order, even when rows share a timestamp (or differ only below the
 * millisecond) across a page boundary.
 *
 * Real, migrated Postgres; requires DATABASE_URL (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "transactionsExport.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

/** The export's page size (EXPORT_PAGE_SIZE in transactions/exportCsv.ts),
 *  written out so this file runs unchanged against the old code too. */
const PAGE_SIZE = 1000;
const HEADER = "id,status,amount_bhd,captured_bhd,reference,occurred_at";

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

/** Row count of every result set the app reads from `transactions`. */
const transactionResultSizes: number[] = [];
const realQuery = pool.query.bind(pool) as (...args: unknown[]) => unknown;
(pool as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
  const pending = realQuery(...args);
  const first = args[0];
  const text = typeof first === "string" ? first : (first as { text?: unknown } | undefined)?.text;
  if (pending instanceof Promise && typeof text === "string" && /\bFROM\s+transactions\b/i.test(text)) {
    return pending.then((result: { rows: unknown[] }) => {
      transactionResultSizes.push(result.rows.length);
      return result;
    });
  }
  return pending;
};

const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

async function createMerchantWithApiKey(): Promise<{ merchantId: string; rawKey: string }> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Export Stream Test ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const owner = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: owner.rows[0]!.id, label: "export" });
  return { merchantId, rawKey: issued.rawKey };
}

/**
 * `count` captured transactions, three to a timestamp, timestamps 250 µs
 * apart — so most differ only below the millisecond and the page boundaries
 * (after rows 1000 and 2000) fall inside a group of equal timestamps. That is
 * exactly where a keyset on occurred_at alone, or a cursor that went through
 * a JS Date, drops or repeats rows.
 */
async function insertTransactions(merchantId: string, count: number): Promise<string[]> {
  await pool.query(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, reference, acquirer_reference, occurred_at)
     SELECT $1, 'captured', 1000 + g, 1000 + g, 'row-' || g, 'acq_' || gen_random_uuid(),
            timestamptz '2026-07-01 00:00:00+03' + (g / 3) * interval '250 microseconds'
       FROM generate_series(0, $2::int - 1) AS g`,
    [merchantId, count],
  );
  const ordered = await pool.query<{ id: string }>(
    `SELECT id FROM transactions WHERE merchant_id = $1 ORDER BY occurred_at, id`,
    [merchantId],
  );
  return ordered.rows.map((row) => row.id);
}

async function exportCsv(rawKey: string) {
  transactionResultSizes.length = 0;
  const res = await app.inject({
    method: "GET",
    url: "/v1/transactions/export",
    headers: { authorization: `Bearer ${rawKey}` },
  });
  return { res, querySizes: [...transactionResultSizes] };
}

test("a large merchant's export is read a page at a time and still has every row exactly once", async () => {
  const rows = 2 * PAGE_SIZE + 500;
  const { merchantId, rawKey } = await createMerchantWithApiKey();
  const expectedIds = await insertTransactions(merchantId, rows);

  const { res, querySizes } = await exportCsv(rawKey);

  assert.equal(res.statusCode, 200, res.body.slice(0, 300));
  assert.match(String(res.headers["content-type"]), /^text\/csv/);
  assert.equal(res.headers["content-disposition"], 'attachment; filename="transactions.csv"');

  const lines = res.body.split("\n");
  assert.equal(lines[0], HEADER);
  const ids = lines.slice(1).map((line) => line.split(",")[0]);
  assert.equal(new Set(ids).size, ids.length, "no row may appear twice");
  assert.equal(ids.length, rows, "every row must be exported");
  assert.deepEqual(ids, expectedIds, "rows come out in (occurred_at, id) order");

  assert.equal(
    querySizes.reduce((sum, size) => sum + size, 0),
    rows,
    "the export reads each row from Postgres once",
  );
  const largestQuery = Math.max(...querySizes);
  assert.ok(
    largestQuery <= PAGE_SIZE,
    `the export read ${largestQuery} rows from transactions in one query; it must page (at most ${PAGE_SIZE} per query)`,
  );
});

test("an export of exactly one page, or of nothing, ends cleanly", async () => {
  const full = await createMerchantWithApiKey();
  const expectedIds = await insertTransactions(full.merchantId, PAGE_SIZE);
  const { res } = await exportCsv(full.rawKey);
  assert.equal(res.statusCode, 200, res.body.slice(0, 300));
  const lines = res.body.split("\n");
  assert.equal(lines.length, PAGE_SIZE + 1, "header plus one line per row, no trailing blank line");
  assert.deepEqual(lines.slice(1).map((line) => line.split(",")[0]), expectedIds);

  const empty = await createMerchantWithApiKey();
  const emptyExport = await exportCsv(empty.rawKey);
  assert.equal(emptyExport.res.statusCode, 200, emptyExport.res.body);
  assert.equal(emptyExport.res.body, HEADER);
});
