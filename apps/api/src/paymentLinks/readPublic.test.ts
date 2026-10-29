/**
 * The public, unauthenticated payment-link read must not expose any
 * credential material of the merchant's API keys. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { getPublicPaymentLink } from "./read.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("readPublic.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({ DATABASE_URL: databaseUrl, NODE_ENV: "test", INTERNAL_API_TOKEN: "t" });
const pool = new Pool({ connectionString: databaseUrl, max: 3 });

after(async () => {
  await pool.end();
});

test("GET /v1/payment-links/:token payload carries no API key prefix or key hash", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Public Link Test ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "live" });
  const keyRow = await pool.query<{ key_prefix: string; key_hash: string }>(
    `SELECT key_prefix, key_hash FROM api_keys WHERE id = $1`,
    [issued.id],
  );
  const token = `plink_${randomUUID().replace(/-/g, "").slice(0, 22)}`;
  await pool.query(
    `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
     VALUES ($1, $2, 4750, now() + interval '1 day', 'merchant_session', $3)`,
    [merchantId, token, randomUUID()],
  );

  const link = await getPublicPaymentLink(pool, token, 60);
  assert.ok(link);
  const serialized = JSON.stringify(link);
  assert.ok(!serialized.includes(keyRow.rows[0]!.key_hash), "secret key hash leaked to the public");
  assert.ok(!serialized.includes(keyRow.rows[0]!.key_prefix), "secret key prefix leaked to the public");
  assert.ok(!serialized.includes(issued.rawKey.slice(0, 12)));
  assert.equal(link.amountFils, 4750);
});
