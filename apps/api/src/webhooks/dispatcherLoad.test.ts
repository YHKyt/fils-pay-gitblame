/**
 * Load / concurrency tests for the webhook dispatcher: overlapping
 * runDispatchPass calls, slow and hanging receivers (injected transports),
 * LISTEN/NOTIFY handling and graceful shutdown. Requires DATABASE_URL to
 * point at a real, migrated Postgres.
 *
 * Step B is global (it attempts every due delivery platform-wide), so every
 * assertion here is scoped to this test's own unique receiver URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { loadConfig } from "../config.js";
import { createWebhookEndpoint } from "./create.js";
import { runDispatchPass } from "./dispatcher.js";
import { WEBHOOK_DELIVERY_ID_HEADER } from "./headers.js";
import type { WebhookTransport, WebhookTransportRequest, WebhookTransportResponse } from "./transport.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("dispatcherLoad.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

function makeConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    DATABASE_URL: databaseUrl,
    NODE_ENV: "test",
    INTERNAL_API_TOKEN: "test-internal-token",
    WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
    WEBHOOK_MAX_ATTEMPTS: "3",
    WEBHOOK_BACKOFF_BASE_MS: "60000",
    WEBHOOK_BACKOFF_CAP_MS: "600000",
    WEBHOOK_REQUEST_TIMEOUT_MS: "5000",
    ...overrides,
  });
}

const config = makeConfig();
const pool = new Pool({ connectionString: databaseUrl, max: 10 });

test.after(async () => {
  await pool.end();
});

async function createMerchant(label: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Dispatcher Load Merchant ${label} ${randomUUID()}`, 250],
  );
  return result.rows[0]!.id;
}

async function createEndpoint(merchantId: string, url: string): Promise<string> {
  const created = await createWebhookEndpoint(pool, config, {
    merchantId,
    url,
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });
  return created.id;
}

async function enqueueCaptured(merchantId: string) {
  return enqueueEvent(pool, {
    eventType: "transaction.captured",
    aggregateType: "transaction",
    aggregateId: randomUUID(),
    payload: { merchantId, amountCapturedFils: 1_000, feeFils: 25, newStatus: "captured", capturedTotalFils: 1_000 },
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

/** Transport that records every request to `url` and answers 200; requests
 *  to other URLs (other test files' leftovers) also get 200. */
function recordingTransport(url: string, sent: WebhookTransportRequest[], hook?: (req: WebhookTransportRequest) => Promise<void>): WebhookTransport {
  return async (req): Promise<WebhookTransportResponse> => {
    if (req.url === url) {
      sent.push(req);
      if (hook) await hook(req);
    }
    return { statusCode: 200, body: "ok" };
  };
}

async function deliveryStatuses(endpointId: string): Promise<Array<{ id: string; status: string; attempt_count: number }>> {
  const r = await pool.query<{ id: string; status: string; attempt_count: number }>(
    `SELECT id, status, attempt_count FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at, id`,
    [endpointId],
  );
  return r.rows;
}

test("load: many events across several concurrent passes are each delivered exactly once", async () => {
  const merchantId = await createMerchant("many");
  const url = `https://load-many-${randomUUID()}.example.test/hook`;
  const endpointId = await createEndpoint(merchantId, url);
  for (let i = 0; i < 60; i += 1) await enqueueCaptured(merchantId);

  const sent: WebhookTransportRequest[] = [];
  const transport = recordingTransport(url, sent, () => new Promise((r) => setTimeout(r, 2)));
  await Promise.all(Array.from({ length: 6 }, () => runDispatchPass(pool, transport, config)));
  await runDispatchPass(pool, transport, config);

  const ids = sent.map((r) => r.headers[WEBHOOK_DELIVERY_ID_HEADER]);
  assert.equal(new Set(ids).size, 60);
  assert.equal(ids.length, 60, "no delivery may be sent twice");
  const rows = await deliveryStatuses(endpointId);
  assert.equal(rows.length, 60);
  assert.ok(rows.every((r) => r.status === "succeeded" && r.attempt_count === 1));
});

test("a slow send early in a pass's batch must not let the lease on the rows still queued behind it lapse into a second send", async () => {
  // Step B attempts its batch sequentially. A row queued behind slow sends
  // waits (batch position x request timeout) before it is sent; once that
  // exceeds the claim lease another pass (second replica) may claim and send
  // it. Waiting out the real 30 s lease is too slow for a unit test, so the
  // lease lapse is simulated by moving the queued rows' next_attempt_at into
  // the past while the first send is still hanging.
  const merchantId = await createMerchant("lease");
  const url = `https://load-lease-${randomUUID()}.example.test/hook`;
  const endpointId = await createEndpoint(merchantId, url);
  for (let i = 0; i < 3; i += 1) await enqueueCaptured(merchantId);

  const sent: WebhookTransportRequest[] = [];
  const firstSendStarted = deferred();
  const releaseFirstSend = deferred();
  let blocked = false;
  const slowTransport = recordingTransport(url, sent, async () => {
    if (!blocked) {
      blocked = true;
      firstSendStarted.resolve();
      await releaseFirstSend.promise;
    }
  });

  const passOne = runDispatchPass(pool, slowTransport, config);
  await firstSendStarted.promise;
  const inFlightId = sent[0]!.headers[WEBHOOK_DELIVERY_ID_HEADER];

  // Time passes: every queued (not yet sent) row's lease has lapsed.
  await pool.query(
    `UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 second'
      WHERE endpoint_id = $1 AND status = 'pending' AND delivery_event_id <> $2`,
    [endpointId, inFlightId],
  );

  // A second replica's pass picks up whatever is claimable now.
  await runDispatchPass(pool, slowTransport, config);
  releaseFirstSend.resolve();
  await passOne;

  const ids = sent.map((r) => r.headers[WEBHOOK_DELIVERY_ID_HEADER]);
  assert.equal(new Set(ids).size, 3, "all three deliveries sent");
  assert.equal(ids.length, 3, `no delivery may be sent twice, got ${ids.length} sends`);
  const rows = await deliveryStatuses(endpointId);
  assert.ok(rows.every((r) => r.attempt_count === 1), JSON.stringify(rows));
});

