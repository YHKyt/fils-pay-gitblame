/**
 * The pay path resolves a link's prior authorize attempts by the idempotency
 * key shape `paylink:<link id>:<client key>:authorize`. pay.ts used to find
 * them with `key LIKE 'paylink:<link id>:%:authorize'`, whose prefix is built
 * from a column (capturedAttemptExists) or a bound parameter
 * (voidOtherLinkAuthorizations) at run time. Postgres will not turn such a
 * run-time LIKE prefix into an index range, so idx_idempotency_keys_paylink_like
 * (merchant_id, endpoint, key text_pattern_ops) went unused and the planner
 * sequentially scanned idempotency_keys on every pay.
 *
 * The fix replaces the prefix LIKE with an explicit half-open range on `key`
 * written with the pattern operators (~>=~ / ~<~) that the text_pattern_ops
 * index can serve, keeping the original LIKE as a residual filter for the
 * ':authorize' suffix.
 *
 * These tests prove the fix changes nothing about which rows match (the range
 * + residual LIKE selects exactly the keys the old LIKE did, across edge cases)
 * and that the new form is served by the index rather than a sequential scan.
 * Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

// The key predicate as capturedAttemptExists builds it: prefix from a value.
const OLD_KEY_PRED = `key LIKE 'paylink:' || $1 || ':%:authorize'`;
const NEW_KEY_PRED = `key ~>=~ ('paylink:' || $1 || ':') AND key ~<~ ('paylink:' || $1 || ';') AND key LIKE 'paylink:' || $1 || ':%:authorize'`;

async function matchedIds(pool: Pool, merchantId: string, linkId: string, keyPred: string): Promise<string[]> {
  const r = await pool.query<{ resource_id: string }>(
    `SELECT resource_id FROM idempotency_keys
      WHERE merchant_id = $2 AND endpoint = 'transactions.authorize' AND (${keyPred})
      ORDER BY resource_id`,
    [linkId, merchantId],
  );
  return r.rows.map((x) => x.resource_id);
}

/** Seed one merchant with keys spanning every edge case, plus a second merchant. */
async function seed(pool: Pool) {
  const merchantId = (
    await pool.query<{ id: string }>(`INSERT INTO merchants (display_name) VALUES ($1) RETURNING id`, [`idxrange ${randomUUID()}`])
  ).rows[0]!.id;
  const otherMerchantId = (
    await pool.query<{ id: string }>(`INSERT INTO merchants (display_name) VALUES ($1) RETURNING id`, [`idxrange-other ${randomUUID()}`])
  ).rows[0]!.id;
  const LA = randomUUID();
  const LB = randomUUID();
  const absent = randomUUID();

  // [key, merchant, endpoint, matchesLA?] — resource_id is a fresh uuid per row.
  const rows: Array<{ key: string; merchant: string; endpoint: string; tag: string }> = [
    { key: `paylink:${LA}:ck1:authorize`, merchant: merchantId, endpoint: "transactions.authorize", tag: "LA-plain" },
    { key: `paylink:${LA}:ck2:authorize`, merchant: merchantId, endpoint: "transactions.authorize", tag: "LA-plain2" },
    { key: `paylink:${LA}:a:b:authorize`, merchant: merchantId, endpoint: "transactions.authorize", tag: "LA-multicolon" },
    { key: `paylink:${LA}:ck1:capture`, merchant: merchantId, endpoint: "transactions.authorize", tag: "suffix-capture" },
    { key: `paylink:${LA}:ck1:authorize:extra`, merchant: merchantId, endpoint: "transactions.authorize", tag: "suffix-extra" },
    { key: `paylink:${LA}`, merchant: merchantId, endpoint: "transactions.authorize", tag: "truncated" },
    { key: `transfer:${LA}:ck1:authorize`, merchant: merchantId, endpoint: "transactions.authorize", tag: "other-prefix" },
    { key: `paylink:${LB}:ck1:authorize`, merchant: merchantId, endpoint: "transactions.authorize", tag: "LB" },
    { key: `paylink:${LA}:ck1:authorize`, merchant: merchantId, endpoint: "transactions.capture", tag: "wrong-endpoint" },
    { key: `paylink:${LA}:ck1:authorize`, merchant: otherMerchantId, endpoint: "transactions.authorize", tag: "other-merchant" },
  ];
  const byTag = new Map<string, string>();
  for (const row of rows) {
    const resourceId = randomUUID();
    byTag.set(row.tag, resourceId);
    await pool.query(
      `INSERT INTO idempotency_keys (merchant_id, endpoint, key, request_hash, status, resource_id)
       VALUES ($1, $2, $3, 'seed', 'completed', $4)`,
      [row.merchant, row.endpoint, row.key, resourceId],
    );
  }
  return { merchantId, otherMerchantId, LA, LB, absent, byTag };
}

test("range+residual selects exactly the same keys as the old LIKE, for every probe link", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const { merchantId, otherMerchantId, LA, LB, absent, byTag } = await seed(pool);

    for (const [who, mId, linkId] of [
      ["LA", merchantId, LA],
      ["LB", merchantId, LB],
      ["absent", merchantId, absent],
      ["LA-other-merchant", otherMerchantId, LA],
    ] as const) {
      const oldSet = await matchedIds(pool, mId, linkId, OLD_KEY_PRED);
      const newSet = await matchedIds(pool, mId, linkId, NEW_KEY_PRED);
      assert.deepEqual(newSet, oldSet, `probe ${who}: new predicate must match exactly the old LIKE`);
    }

    // Pin the expected LA set so a silent change in BOTH forms can't pass.
    const expectedLA = [byTag.get("LA-plain")!, byTag.get("LA-plain2")!, byTag.get("LA-multicolon")!].sort();
    assert.deepEqual((await matchedIds(pool, merchantId, LA, NEW_KEY_PRED)).sort(), expectedLA);
    // Suffix mismatch, truncated, other prefix, wrong endpoint/merchant: none match.
    for (const tag of ["suffix-capture", "suffix-extra", "truncated", "other-prefix"]) {
      assert.ok(!(await matchedIds(pool, merchantId, LA, NEW_KEY_PRED)).includes(byTag.get(tag)!), `${tag} must not match`);
    }
  } finally {
    await pool.end();
  }
});

test("voidOtherLinkAuthorizations' parameterised range form selects the same rows as its old LIKE", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const { merchantId, LA, byTag } = await seed(pool);
    const keep = byTag.get("LA-plain2")!; // exclude one matching row via the keepTxnId filter
    const keyPrefix = `paylink:${LA}:`;
    const keyPrefixUpper = `${keyPrefix.slice(0, -1)};`;

    const oldForm = await pool.query<{ resource_id: string }>(
      `SELECT resource_id FROM idempotency_keys
        WHERE merchant_id = $1 AND endpoint = 'transactions.authorize' AND key LIKE $2
          AND resource_id IS NOT NULL AND resource_id IS DISTINCT FROM $3::uuid ORDER BY resource_id`,
      [merchantId, `paylink:${LA}:%:authorize`, keep],
    );
    const newForm = await pool.query<{ resource_id: string }>(
      `SELECT resource_id FROM idempotency_keys
        WHERE merchant_id = $1 AND endpoint = 'transactions.authorize'
          AND key ~>=~ $2 AND key ~<~ $3 AND key LIKE $4
          AND resource_id IS NOT NULL AND resource_id IS DISTINCT FROM $5::uuid ORDER BY resource_id`,
      [merchantId, keyPrefix, keyPrefixUpper, `paylink:${LA}:%:authorize`, keep],
    );
    assert.deepEqual(
      newForm.rows.map((r) => r.resource_id),
      oldForm.rows.map((r) => r.resource_id),
      "void-other-auth selection must be identical, including the keepTxnId exclusion",
    );
    assert.deepEqual(
      newForm.rows.map((r) => r.resource_id).sort(),
      [byTag.get("LA-plain")!, byTag.get("LA-multicolon")!].sort(),
      "keep excludes LA-plain2; suffix/other rows never qualify",
    );
  } finally {
    await pool.end();
  }
});

test("the new range form is served by idx_idempotency_keys_paylink_like, not a sequential scan", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const { merchantId, LA } = await seed(pool);
    const keyPrefix = `paylink:${LA}:`;
    const keyPrefixUpper = `${keyPrefix.slice(0, -1)};`;

    // Give the table a production-shaped volume for this merchant+endpoint so
    // the planner's index choice matches production: when many keys share the
    // (merchant_id, endpoint) equality prefix, the selective key range makes
    // idx_idempotency_keys_paylink_like the cheapest plan. At a near-empty
    // table any index is equally cheap and the choice is not meaningful.
    await pool.query(
      `INSERT INTO idempotency_keys (merchant_id, endpoint, key, request_hash, status, resource_id)
       SELECT $1, 'transactions.authorize',
              'paylink:' || gen_random_uuid()::text || ':' || g::text || ':authorize',
              'bulk', 'completed', gen_random_uuid()
         FROM generate_series(1, 5000) g`,
      [merchantId],
    );
    await pool.query(`ANALYZE idempotency_keys`);

    // enable_seqscan=off makes the discriminator deterministic at any table
    // size: the range form can be pushed into the text_pattern_ops index, the
    // old column/param LIKE prefix cannot.
    const client = await pool.connect();
    try {
      await client.query(`SET enable_seqscan = off`);
      const newPlan = (
        await client.query<{ "QUERY PLAN": string }>(
          `EXPLAIN (COSTS OFF)
           SELECT resource_id FROM idempotency_keys
            WHERE merchant_id = $1 AND endpoint = 'transactions.authorize'
              AND key ~>=~ $2 AND key ~<~ $3 AND key LIKE $4 AND resource_id IS NOT NULL`,
          [merchantId, keyPrefix, keyPrefixUpper, `paylink:${LA}:%:authorize`],
        )
      ).rows.map((r) => r["QUERY PLAN"]).join("\n");
      assert.match(newPlan, /idx_idempotency_keys_paylink_like/, `expected index scan, got:\n${newPlan}`);
      assert.doesNotMatch(newPlan, /Seq Scan on idempotency_keys/, `expected no seq scan, got:\n${newPlan}`);
      // The key range reaches the index as an Index Cond (not just a filter),
      // which is what the old run-time LIKE prefix could never achieve.
      assert.match(newPlan, /Index Cond:[\s\S]*~>=~[\s\S]*paylink/, `expected a key-range index cond, got:\n${newPlan}`);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
});
