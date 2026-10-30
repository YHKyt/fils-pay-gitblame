/**
 * Regression test (PCI): authorization idempotency rows written before the
 * card-hash fix still held sha256(canonicalJson({ amountFils, card,
 * reference })), card and CVV included. The code fix only changed new rows.
 * Migration 0124 overwrites the request_hash of every transactions.authorize
 * row. This test plants a legacy row, re-applies the migration in a
 * transaction (it is idempotent), and checks the card hash is gone while the
 * rest of the row is kept.
 *
 * Real, migrated Postgres; requires DATABASE_URL (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Pool } from "pg";
import { canonicalJson } from "../payments/idempotency.js";

const databaseUrl = process.env.DATABASE_URL;
const MIGRATION = new URL("../../../../db/migrations/0124_redact_legacy_authorize_request_hash.sql", import.meta.url);

test("a pre-fix authorization row no longer holds an unkeyed hash of the card", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const m = await client.query<{ id: string }>(
      `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
      [`legacy-hash ${randomUUID()}`],
    );
    const merchantId = m.rows[0]!.id;
    const card = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
    const legacyHash = createHash("sha256")
      .update(canonicalJson({ amountFils: 5000, card, reference: null }))
      .digest("hex");
    const resourceId = randomUUID();
    const authKey = `legacy-${randomUUID()}`;
    await client.query(
      `INSERT INTO idempotency_keys (merchant_id, endpoint, key, request_hash, status, response_status_code, response_body, resource_id)
       VALUES ($1, 'transactions.authorize', $2, $3, 'completed', 201, '{"ok":true}', $4)`,
      [merchantId, authKey, legacyHash, resourceId],
    );
    // A capture row hashes no card data and must be left alone.
    const captureHash = createHash("sha256").update("capture-body").digest("hex");
    await client.query(
      `INSERT INTO idempotency_keys (merchant_id, endpoint, key, request_hash, status)
       VALUES ($1, 'transactions.capture', $2, $3, 'completed')`,
      [merchantId, `cap-${randomUUID()}`, captureHash],
    );

    await client.query(readFileSync(MIGRATION, "utf8"));

    const rows = await client.query<{ endpoint: string; request_hash: string; resource_id: string | null; status: string }>(
      `SELECT endpoint, request_hash, resource_id, status FROM idempotency_keys WHERE merchant_id = $1 ORDER BY endpoint`,
      [merchantId],
    );
    const auth = rows.rows.find((r) => r.endpoint === "transactions.authorize")!;
    const cap = rows.rows.find((r) => r.endpoint === "transactions.capture")!;
    assert.notEqual(auth.request_hash, legacyHash, "the stored hash still covers the raw card");
    // CVV search over the stored value finds nothing.
    for (let cvv = 0; cvv < 1000; cvv += 1) {
      const guess = createHash("sha256")
        .update(canonicalJson({ amountFils: 5000, card: { ...card, cvv: String(cvv).padStart(3, "0") }, reference: null }))
        .digest("hex");
      assert.notEqual(auth.request_hash, guess);
    }
    assert.equal(auth.resource_id, resourceId);
    assert.equal(auth.status, "completed");
    assert.equal(cap.request_hash, captureHash, "a capture row must be untouched");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await pool.end();
  }
});
