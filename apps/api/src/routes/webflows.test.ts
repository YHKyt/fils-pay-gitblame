/**
 * Regression tests for the merchant dashboard flows (docs/audit/webflows.md,
 * WF2 onwards): payment-link cancel, webhook endpoint management, list
 * pagination and the business profile, all through `app.inject(...)` against
 * a real, migrated Postgres. Requires `DATABASE_URL`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("webflows.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  PAYMENT_LINK_RESERVATION_TIMEOUT_SECONDS: "60",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function approvedMerchant(label: string) {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name) VALUES ($1) RETURNING id`, [
    `Webflows ${label} ${randomUUID()}`,
  ]);
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const key = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label });
  const rawSession = randomToken(32);
  await pool.query(
    `INSERT INTO sessions (merchant_user_id, token_hash, authenticated, expires_at)
     VALUES ($1, $2, true, now() + interval '1 hour')`,
    [u.rows[0]!.id, sha256Hex(rawSession)],
  );
  return {
    merchantId,
    auth: { authorization: `Bearer ${key.rawKey}` },
    cookie: { cookie: `${config.cookieName}=${rawSession}` },
  };
}

async function createLink(merchantId: string, auth: Record<string, string>) {
  const res = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/payment-links`,
    headers: auth,
    payload: { amountFils: 5000, expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json<{ id: string; token: string }>();
}

test("WF2: a link stuck in a lapsed reservation can be canceled, and then cannot be paid", async () => {
  const { merchantId, auth } = await approvedMerchant("stale-reserved");
  const link = await createLink(merchantId, auth);
  // A payer's attempt crashed between claim and finalize 10 minutes ago.
  await pool.query(`UPDATE payment_links SET status = 'reserved', reserved_at = now() - interval '10 minutes' WHERE id = $1`, [
    link.id,
  ]);

  const publicView = await app.inject({ method: "GET", url: `/v1/payment-links/${link.token}` });
  assert.equal(publicView.json().status, "active");

  const cancel = await app.inject({
    method: "DELETE",
    url: `/v1/merchants/${merchantId}/payment-links/${link.id}`,
    headers: auth,
  });
  assert.equal(cancel.statusCode, 204, cancel.body);

  const pay = await app.inject({
    method: "POST",
    url: `/v1/payment-links/${link.token}/pay`,
    headers: { "idempotency-key": randomUUID() },
    payload: { card: CARD },
  });
  assert.notEqual(pay.statusCode, 200, `a canceled link must not take money: ${pay.body}`);
  const txns = await pool.query(`SELECT 1 FROM transactions WHERE merchant_id = $1`, [merchantId]);
  assert.equal(txns.rowCount, 0);
});

test("WF2: a live reservation (payment in flight) still cannot be canceled", async () => {
  const { merchantId, auth } = await approvedMerchant("live-reserved");
  const link = await createLink(merchantId, auth);
  await pool.query(`UPDATE payment_links SET status = 'reserved', reserved_at = now() WHERE id = $1`, [link.id]);
  const cancel = await app.inject({
    method: "DELETE",
    url: `/v1/merchants/${merchantId}/payment-links/${link.id}`,
    headers: auth,
  });
  assert.equal(cancel.statusCode, 409, cancel.body);
  assert.equal(cancel.json().error, "not_cancelable");
});

async function withReceiver<T>(fn: (url: string, hits: string[]) => Promise<T>): Promise<T> {
  const http = await import("node:http");
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    req.resume();
    req.on("end", () => {
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    return await fn(`http://127.0.0.1:${port}`, hits);
  } finally {
    server.close();
  }
}

test("WF3: test-send refuses a deleted webhook endpoint and sends nothing", async () => {
  const { merchantId, auth } = await approvedMerchant("wh-deleted");
  await withReceiver(async (base, hits) => {
    const created = await app.inject({
      method: "POST",
      url: `/v1/merchants/${merchantId}/webhook-endpoints`,
      headers: auth,
      payload: { url: `${base}/hook` },
    });
    assert.equal(created.statusCode, 201, created.body);
    const { id } = created.json<{ id: string }>();
    const del = await app.inject({ method: "DELETE", url: `/v1/merchants/${merchantId}/webhook-endpoints/${id}`, headers: auth });
    assert.equal(del.statusCode, 204);

    const sent = await app.inject({
      method: "POST",
      url: `/v1/merchants/${merchantId}/webhook-endpoints/${id}/test`,
      headers: auth,
    });
    assert.equal(sent.statusCode, 404, sent.body);
    assert.equal(sent.json().error, "webhook_endpoint_not_found");
    assert.deepEqual(hits, []);
  });
});

test("WF4: webhook endpoint create/update reject a non-string url and an unknown status with 400", async () => {
  const { merchantId, auth } = await approvedMerchant("wh-validate");
  const arrayUrl = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/webhook-endpoints`,
    headers: auth,
    payload: { url: ["http://127.0.0.1:9/hook"] },
  });
  assert.equal(arrayUrl.statusCode, 400, arrayUrl.body);
  assert.equal(arrayUrl.json().error, "invalid_url");
  const stored = await pool.query(`SELECT url FROM webhook_endpoints WHERE merchant_id = $1`, [merchantId]);
  assert.equal(stored.rowCount, 0);

  const created = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/webhook-endpoints`,
    headers: auth,
    payload: { url: "http://127.0.0.1:9/hook" },
  });
  assert.equal(created.statusCode, 201, created.body);
  const { id } = created.json<{ id: string }>();

  const badStatus = await app.inject({
    method: "PATCH",
    url: `/v1/merchants/${merchantId}/webhook-endpoints/${id}`,
    headers: auth,
    payload: { status: "paused" },
  });
  assert.equal(badStatus.statusCode, 400, badStatus.body);
  assert.equal(badStatus.json().error, "invalid_request");

  const badUrl = await app.inject({
    method: "PATCH",
    url: `/v1/merchants/${merchantId}/webhook-endpoints/${id}`,
    headers: auth,
    payload: { url: { href: "http://127.0.0.1:9/x" } },
  });
  assert.equal(badUrl.statusCode, 400, badUrl.body);
  const after = await pool.query<{ url: string; status: string }>(`SELECT url, status FROM webhook_endpoints WHERE id = $1`, [id]);
  assert.deepEqual(after.rows[0], { url: "http://127.0.0.1:9/hook", status: "active" });
});

test("WF5: a non-numeric limit on the payment-link and delivery lists uses the default page size, not a 500", async () => {
  const { merchantId, auth } = await approvedMerchant("limit");
  await createLink(merchantId, auth);
  const links = await app.inject({ method: "GET", url: `/v1/merchants/${merchantId}/payment-links?limit=abc`, headers: auth });
  assert.equal(links.statusCode, 200, links.body);
  assert.equal(links.json<{ paymentLinks: unknown[] }>().paymentLinks.length, 1);

  const created = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/webhook-endpoints`,
    headers: auth,
    payload: { url: "http://127.0.0.1:9/hook" },
  });
  const { id } = created.json<{ id: string }>();
  const deliveries = await app.inject({
    method: "GET",
    url: `/v1/merchants/${merchantId}/webhook-endpoints/${id}/deliveries?limit=abc`,
    headers: auth,
  });
  assert.equal(deliveries.statusCode, 200, deliveries.body);
  assert.deepEqual(deliveries.json(), { deliveries: [], nextCursor: null });
});

test("WF6: business profile PATCH rejects invalid values with 400 and leaves the profile unchanged", async () => {
  const { merchantId, cookie } = await approvedMerchant("profile");
  await pool.query(
    `INSERT INTO merchant_business_profiles
       (merchant_id, legal_name, registration_number, business_type, contact_email, contact_phone, address_line1, city)
     VALUES ($1, 'Legal Co', 'CR-1', 'llc', 'a@example.test', '+97300000000', 'Road 1', 'Manama')`,
    [merchantId],
  );
  const url = `/v1/merchants/${merchantId}/business-profile`;
  for (const payload of [
    { legalName: null },
    { legalName: "" },
    { legalName: 5 },
    { businessType: "corp" },
    { country: "BHR" },
  ]) {
    const res = await app.inject({ method: "PATCH", url, headers: cookie, payload });
    assert.equal(res.statusCode, 400, `${JSON.stringify(payload)} -> ${res.statusCode} ${res.body}`);
    assert.equal(res.json().error, "invalid_request");
  }
  const ok = await app.inject({ method: "PATCH", url, headers: cookie, payload: { addressLine2: null, city: "Muharraq" } });
  assert.equal(ok.statusCode, 200, ok.body);
  const row = await pool.query(`SELECT legal_name, business_type, country, city FROM merchant_business_profiles WHERE merchant_id = $1`, [
    merchantId,
  ]);
  assert.deepEqual(row.rows[0], { legal_name: "Legal Co", business_type: "llc", country: "BH", city: "Muharraq" });
});
