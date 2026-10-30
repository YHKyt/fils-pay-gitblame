/**
 * Regression test: capturing the rest of a partially captured transaction
 * that already has a refund must derive its status the way a refund does
 * (payments/refundState.ts), not report plain 'captured'.
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
import { recordKycReview } from "../onboarding/review.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("captureAfterRefund.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 3 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function approvedMerchant(): Promise<{ merchantId: string; rawKey: string }> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Capture After Refund Test ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const owner = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: owner.rows[0]!.id, label: "capture-after-refund" });
  return { merchantId, rawKey: issued.rawKey };
}

function post(rawKey: string, url: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload,
  });
}

for (const refundFils of [1_000, 4_000]) {
  test(`capturing the remainder after a ${refundFils} fils refund leaves the transaction partially_refunded`, async () => {
    const { rawKey } = await approvedMerchant();
    const auth = await post(rawKey, "/v1/transactions", { amountFils: 10_000, card: VALID_CARD, reference: "order-1" });
    assert.equal(auth.statusCode, 201, auth.body);
    const id = auth.json().id as string;

    const first = await post(rawKey, `/v1/transactions/${id}/capture`, { amountFils: 4_000 });
    assert.equal(first.statusCode, 200, first.body);
    const refund = await post(rawKey, "/v1/refunds", { transactionId: id, amountFils: refundFils });
    assert.equal(refund.statusCode, 200, refund.body);
    assert.equal(refund.json().transactionStatus, "partially_captured");

    // The old code answered status 'captured' with refundedFils > 0.
    const rest = await post(rawKey, `/v1/transactions/${id}/capture`, {});
    assert.equal(rest.statusCode, 200, rest.body);
    assert.equal(rest.json().capturedFils, 10_000);
    assert.equal(rest.json().refundedFils, refundFils);
    assert.equal(rest.json().status, "partially_refunded");

    const detail = await app.inject({ method: "GET", url: `/v1/transactions/${id}`, headers: { authorization: `Bearer ${rawKey}` } });
    assert.equal(detail.json().status, "partially_refunded");

    // Fully captured all the same: the hold is released and the timeline
    // records a full capture.
    const hold = await pool.query<{ status: string }>(`SELECT status FROM holds WHERE transaction_id = $1`, [id]);
    assert.equal(hold.rows[0]!.status, "released");
    const last = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM transaction_events WHERE transaction_id = $1 ORDER BY id DESC LIMIT 1`,
      [id],
    );
    assert.equal(last.rows[0]!.event_type, "captured");

    // The rest can still be refunded, which ends at 'refunded'.
    const final = await post(rawKey, "/v1/refunds", { transactionId: id, amountFils: 10_000 - refundFils });
    assert.equal(final.statusCode, 200, final.body);
    assert.equal(final.json().transactionStatus, "refunded");
  });
}

test("a full capture with no refund is still plain 'captured'", async () => {
  const { rawKey } = await approvedMerchant();
  const auth = await post(rawKey, "/v1/transactions", { amountFils: 5_000, card: VALID_CARD });
  const res = await post(rawKey, `/v1/transactions/${auth.json().id}/capture`, {});
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, "captured");
});
