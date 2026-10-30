/**
 * Regression tests (PCI): the idempotency request_hash an authorization
 * stores must not let anyone who can read the database recover card data.
 *
 * It was sha256(canonicalJson({ amountFils, card, reference })): the whole
 * card, CVV included, and no key. The amount and reference are on the
 * transactions row, so with the PAN the CVV fell out of at most 1,000 sha256
 * calls, and with a known BIN, the expiry and the Luhn digit the PAN is a
 * small search too. That is stored card data, and a CVV must never be
 * stored, even hashed. Both POST /v1/transactions and the public
 * payment-link pay route authorize through the same code.
 *
 * Real, migrated Postgres; requires DATABASE_URL (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { canonicalJson } from "../payments/idempotency.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("authorizeCardHash.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

function testConfig(webhookSecretEncryptionKey: string) {
  return loadConfig({
    DATABASE_URL: databaseUrl,
    NODE_ENV: "test",
    ACQUIRER_FAILURE_RATE: "0",
    ACQUIRER_LATENCY_MIN_MS: "0",
    ACQUIRER_LATENCY_MAX_MS: "1",
    WEBHOOK_SECRET_ENCRYPTION_KEY: webhookSecretEncryptionKey,
  });
}

const config = testConfig("Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=");
// Another deployment: the same code with a different server secret.
const otherConfig = testConfig(Buffer.alloc(32, 7).toString("base64"));

const pool = new Pool({ connectionString: databaseUrl, max: 3 });
const app = buildApp(config, pool);
const otherApp = buildApp(otherConfig, pool);

test.after(async () => {
  await app.close();
  await otherApp.close();
  await pool.end();
});

type Card = { pan: string; expiryMonth: number; expiryYear: number; cvv: string };
const CARD: Card = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Unkeyed sha256 of each JSON form a request hash carrying this card could take. */
function plainCardHashes(amountFils: number, card: Card, reference: string | null): string[] {
  const panAndExpiry = { pan: card.pan, expiryMonth: card.expiryMonth, expiryYear: card.expiryYear };
  const forms: unknown[] = [
    { amountFils, card, reference }, // the old authorize body
    { amountFils, card },
    { card },
    card,
    { pan: card.pan, cvv: card.cvv },
    panAndExpiry,
    { amountFils, card: panAndExpiry, reference }, // CVV dropped but no key: the PAN is still searchable
  ];
  return forms.flatMap((form) => [sha256Hex(canonicalJson(form)), sha256Hex(JSON.stringify(form))]);
}

/** What someone holding the row, the amount, the reference and the PAN can do: try every CVV. */
function bruteForceCvv(requestHash: string, amountFils: number, reference: string | null): string | null {
  for (let i = 0; i < 1000; i++) {
    const cvv = String(i).padStart(3, "0");
    if (sha256Hex(canonicalJson({ amountFils, card: { ...CARD, cvv }, reference })) === requestHash) return cvv;
  }
  return null;
}

function assertNoCardData(requestHash: string, amountFils: number, reference: string | null): void {
  assert.match(requestHash, /^[0-9a-f]{64}$/);
  for (const plain of plainCardHashes(amountFils, CARD, reference)) {
    assert.notEqual(requestHash, plain, "request_hash is an unkeyed sha256 of JSON carrying the card");
  }
  assert.equal(bruteForceCvv(requestHash, amountFils, reference), null, "the CVV was recovered from request_hash");
}

async function approvedMerchant(): Promise<{ merchantId: string; rawKey: string }> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Card Hash Test ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const owner = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: owner.rows[0]!.id, label: "card-hash" });
  return { merchantId, rawKey: issued.rawKey };
}

function authorize(target: FastifyInstance, rawKey: string, idempotencyKey: string, payload: Record<string, unknown>) {
  return target.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": idempotencyKey },
    payload,
  });
}

async function storedRequestHash(merchantId: string, key: string): Promise<string> {
  const result = await pool.query<{ request_hash: string }>(
    `SELECT request_hash FROM idempotency_keys
      WHERE merchant_id = $1 AND endpoint = 'transactions.authorize' AND key = $2`,
    [merchantId, key],
  );
  assert.equal(result.rows.length, 1, `one idempotency row for ${key}`);
  return result.rows[0]!.request_hash;
}

test("POST /v1/transactions: request_hash is no plain hash of the card, and the CVV cannot be brute-forced from it", async () => {
  const { merchantId, rawKey } = await approvedMerchant();
  const key = randomUUID();
  const res = await authorize(app, rawKey, key, { amountFils: 4750, card: CARD, reference: "order-1" });
  assert.equal(res.statusCode, 201, res.body);

  assertNoCardData(await storedRequestHash(merchantId, key), 4750, "order-1");
});

test("requests that differ only in the CVV store the same request_hash; the PAN and expiry still count", async () => {
  const { merchantId, rawKey } = await approvedMerchant();
  const cards: Record<string, Card> = {
    base: CARD,
    otherCvv: { ...CARD, cvv: "999" },
    otherPan: { ...CARD, pan: "5555555555554444" },
    otherExpiry: { ...CARD, expiryYear: 2031 },
  };
  const hashes: Record<string, string> = {};
  for (const [name, card] of Object.entries(cards)) {
    const key = randomUUID();
    const res = await authorize(app, rawKey, key, { amountFils: 4750, card, reference: "order-2" });
    assert.equal(res.statusCode, 201, `${name}: ${res.body}`);
    hashes[name] = await storedRequestHash(merchantId, key);
  }

  assert.equal(hashes.otherCvv, hashes.base, "the CVV changed request_hash, so request_hash is derived from the CVV");
  assert.notEqual(hashes.otherPan, hashes.base);
  assert.notEqual(hashes.otherExpiry, hashes.base);
});

test("request_hash is keyed by a server secret: another deployment's secret gives another hash", async () => {
  const { merchantId, rawKey } = await approvedMerchant();
  const body = { amountFils: 4750, card: CARD, reference: "order-3" };
  const [here, there] = [randomUUID(), randomUUID()];
  assert.equal((await authorize(app, rawKey, here, body)).statusCode, 201);
  assert.equal((await authorize(otherApp, rawKey, there, body)).statusCode, 201);

  assert.notEqual(
    await storedRequestHash(merchantId, here),
    await storedRequestHash(merchantId, there),
    "the same request hashed the same under two server secrets: anyone can recompute it",
  );
});

test("idempotency still holds: same key and card replays; another amount, card, expiry or reference conflicts", async () => {
  const { merchantId, rawKey } = await approvedMerchant();
  let acquirerCalls = 0;
  const realAuthorize = app.acquirer.authorize.bind(app.acquirer);
  app.acquirer.authorize = async (req) => {
    acquirerCalls += 1;
    return realAuthorize(req);
  };
  try {
    const key = randomUUID();
    const body = { amountFils: 4750, card: CARD, reference: "order-4" };
    const first = await authorize(app, rawKey, key, body);
    assert.equal(first.statusCode, 201, first.body);
    const transactionId = first.json().id as string;

    const replay = await authorize(app, rawKey, key, body);
    assert.equal(replay.statusCode, 201, replay.body);
    assert.equal(replay.json().id, transactionId);

    // The server keeps nothing derived from the CVV, so a retry that differs
    // only there is the same request: it replays, it does not authorize again.
    const cvvOnly = await authorize(app, rawKey, key, { ...body, card: { ...CARD, cvv: "999" } });
    assert.equal(cvvOnly.statusCode, 201, cvvOnly.body);
    assert.equal(cvvOnly.json().id, transactionId);

    const changed: Record<string, unknown>[] = [
      { ...body, amountFils: 4751 },
      { ...body, card: { ...CARD, pan: "5555555555554444" } },
      { ...body, card: { ...CARD, expiryMonth: 11 } },
      { ...body, reference: "order-5" },
    ];
    for (const payload of changed) {
      const res = await authorize(app, rawKey, key, payload);
      assert.equal(res.statusCode, 422, `${JSON.stringify(payload)} -> ${res.body}`);
      assert.equal(res.json().error, "idempotency_key_reused");
    }

    assert.equal(acquirerCalls, 1, "the acquirer is called once for the key");
    const count = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM transactions WHERE merchant_id = $1`, [
      merchantId,
    ]);
    assert.equal(count.rows[0]!.c, 1);
  } finally {
    app.acquirer.authorize = realAuthorize;
  }
});

test("payment-link pay: the authorization's request_hash carries no card data either", async () => {
  const { merchantId } = await approvedMerchant();
  const token = `card-hash-${randomUUID()}`;
  const link = await pool.query<{ id: string }>(
    `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
     VALUES ($1, $2, 4750, now() + interval '1 hour', 'merchant_api_key', gen_random_uuid())
     RETURNING id`,
    [merchantId, token],
  );
  const idempotencyKey = randomUUID();
  const res = await app.inject({
    method: "POST",
    url: `/v1/payment-links/${token}/pay`,
    headers: { "idempotency-key": idempotencyKey },
    payload: { card: CARD },
  });
  assert.equal(res.statusCode, 200, res.body);

  const requestHash = await storedRequestHash(merchantId, `paylink:${link.rows[0]!.id}:${idempotencyKey}:authorize`);
  assertNoCardData(requestHash, 4750, null);
});
