/**
 * GET /v1/settlement/batches?limit=<not a number>: parseInt gives NaN,
 * Math.max/Math.min pass NaN through, and Postgres rejects LIMIT NaN, so the
 * caller got a 500. A zero, negative or garbage limit is now a 400
 * invalid_request, the same contract as GET /v1/transactions. Requires
 * DATABASE_URL.
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
  throw new Error("batchesLimit.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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

test("a zero or non-numeric limit is a 400 (not a 500, not a page of one); a valid limit pages", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Batches Limit ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const { rawKey } = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "t" });
  await pool.query(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
     VALUES ($1, '2026-03-10', 'closed', 1000, 25, 975, now())`,
    [merchantId],
  );

  for (const bad of ["abc", "0"]) {
    const refused = await app.inject({
      method: "GET",
      url: `/v1/settlement/batches?limit=${bad}`,
      headers: { authorization: `Bearer ${rawKey}` },
    });
    assert.equal(refused.statusCode, 400, refused.body);
    assert.equal((refused.json() as { error: string }).error, "invalid_request");
  }
  const res = await app.inject({
    method: "GET",
    url: "/v1/settlement/batches?limit=10",
    headers: { authorization: `Bearer ${rawKey}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((res.json() as { batches: unknown[] }).batches.length, 1);
});
