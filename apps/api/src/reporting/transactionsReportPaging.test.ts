/**
 * GET /v1/reporting/transactions stopped at LIMIT 500 with nothing telling
 * the caller, so a merchant with 501 matching rows got a report that looked
 * complete and was not. The response now says so (X-Truncated) and gives a
 * keyset cursor for the next page (X-Next-Cursor). Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("transactionsReportPaging.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

test("501 matching transactions: first page says it is truncated, the cursor returns the rest exactly once", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Report Paging ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const { rawKey } = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "t" });

  // 501 rows; groups of three share an occurred_at (with microseconds), so
  // the page edge falls inside a tie.
  await pool.query(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
     SELECT $1, 'captured', 1000, 1000, 'acq-' || gen_random_uuid(),
            timestamptz '2026-03-01 10:00:00.123456+03' + (g / 3) * interval '1 second'
       FROM generate_series(1, 501) AS g`,
    [merchantId],
  );

  const headers = { authorization: `Bearer ${rawKey}` };
  const first = await app.inject({ method: "GET", url: "/v1/reporting/transactions", headers });
  assert.equal(first.statusCode, 200, first.body);
  const firstRows = first.json() as Array<{ id: string }>;
  assert.equal(firstRows.length, 500);
  assert.equal(first.headers["x-truncated"], "true");
  const cursor = first.headers["x-next-cursor"];
  assert.equal(typeof cursor, "string");

  const second = await app.inject({
    method: "GET",
    url: `/v1/reporting/transactions?cursor=${encodeURIComponent(cursor as string)}`,
    headers,
  });
  assert.equal(second.statusCode, 200, second.body);
  const secondRows = second.json() as Array<{ id: string }>;
  assert.equal(secondRows.length, 1);
  assert.equal(second.headers["x-truncated"], "false");
  assert.equal(second.headers["x-next-cursor"], undefined);

  const all = new Set([...firstRows, ...secondRows].map((r) => r.id));
  assert.equal(all.size, 501, "every row exactly once across the two pages");

  const bad = await app.inject({ method: "GET", url: "/v1/reporting/transactions?cursor=garbage", headers });
  assert.equal(bad.statusCode, 400, bad.body);
});
