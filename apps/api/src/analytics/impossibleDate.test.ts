/**
 * Date-range validation on the merchant analytics and settlement report
 * endpoints. A well-formed but impossible calendar date such as 2026-02-30
 * passed the old check (JavaScript's Date.parse rolls it over to 2 March),
 * then Postgres rejected it as a DATE and the caller got a 500, or, for
 * top-links, a silently shifted window. Requires DATABASE_URL.
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
  throw new Error("impossibleDate.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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

async function ownerKey(): Promise<string> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Impossible Date ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  return (await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "t" })).rawKey;
}

for (const path of [
  "/v1/analytics/volumes",
  "/v1/analytics/payout-trends",
  "/v1/analytics/recent-ledger-activity",
  "/v1/analytics/top-links",
  "/v1/settlement/reconciliation",
  "/v1/settlement/summary",
]) {
  test(`${path}?to=2026-02-30 is a 400, not a 500 or a shifted window`, async () => {
    const rawKey = await ownerKey();
    const res = await app.inject({
      method: "GET",
      url: `${path}?from=2026-02-01&to=2026-02-30`,
      headers: { authorization: `Bearer ${rawKey}` },
    });
    assert.equal(res.statusCode, 400, res.body);
  });
}

for (const path of ["/v1/settlement/reconciliation", "/v1/settlement/summary"]) {
  test(`${path}?from=garbage is a 400, not a 500`, async () => {
    const rawKey = await ownerKey();
    const res = await app.inject({
      method: "GET",
      url: `${path}?from=garbage&to=2026-02-28`,
      headers: { authorization: `Bearer ${rawKey}` },
    });
    assert.equal(res.statusCode, 400, res.body);
  });
}
