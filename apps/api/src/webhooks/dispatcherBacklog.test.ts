/**
 * The dispatcher under a backlog (perfload, "Webhook dispatcher"):
 *
 * - Step B sends at most STEP_B_BATCH_LIMIT (100) deliveries per pass, and
 *   the next pass waited for the next NOTIFY or poll tick, so a backlog
 *   drained at one batch per poll interval.
 * - Step A re-read every eligible outbox event on every pass (every 5 s and
 *   on every NOTIFY), so its cost grew with the whole outbox history. It now
 *   skips the prefix of the outbox that an earlier pass already fully
 *   handled, and these tests pin that the skip never loses an event: a
 *   lower id that commits late, and a disabled endpoint re-enabled later.
 *
 * Step B is global, so assertions are scoped to each test's own receiver
 * URL. Real Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool, type PoolClient } from "pg";
import { enqueueEvent } from "@filspay/events";
import { loadConfig } from "../config.js";
import { createWebhookEndpoint } from "./create.js";
import { runDispatchPass, startWebhookDispatcher } from "./dispatcher.js";
import type { WebhookTransport, WebhookTransportRequest } from "./transport.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("dispatcherBacklog.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function createMerchant(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Dispatcher Backlog Merchant ${randomUUID()}`],
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

async function enqueueCaptured(db: Pool | PoolClient, merchantId: string): Promise<void> {
  await enqueueEvent(db, {
    eventType: "transaction.captured",
    aggregateType: "transaction",
    aggregateId: randomUUID(),
    payload: { merchantId, amountCapturedFils: 1_000, feeFils: 25, newStatus: "captured", capturedTotalFils: 1_000 },
  });
}

/** Many events in one statement, through the same outbox table. */
async function enqueueMany(merchantId: string, count: number): Promise<void> {
  await pool.query(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
     SELECT 'transaction.captured', 'transaction', gen_random_uuid(),
            jsonb_build_object('merchantId', $1::text, 'amountCapturedFils', 1000, 'feeFils', 25,
                               'newStatus', 'captured', 'capturedTotalFils', 1000)
       FROM generate_series(1, $2)`,
    [merchantId, count],
  );
}

function recordingTransport(url: string, sent: WebhookTransportRequest[]): WebhookTransport {
  return async (req) => {
    if (req.url === url) sent.push(req);
    return { statusCode: 200, body: "ok" };
  };
}

async function deliveriesFor(endpointId: string): Promise<number> {
  const r = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM webhook_deliveries WHERE endpoint_id = $1`, [endpointId]);
  return r.rows[0]!.n;
}

async function drain(transport: WebhookTransport): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const { createdCount, attemptedCount } = await runDispatchPass(pool, transport, config);
    if (createdCount === 0 && attemptedCount === 0) return;
  }
  throw new Error("the dispatcher never ran out of work");
}

test("a backlog larger than one Step B batch drains without waiting for the next poll tick", async () => {
  const merchantId = await createMerchant();
  const url = `https://backlog-${randomUUID()}.example.test/hook`;
  await createEndpoint(merchantId, url);
  // Clear whatever earlier test files left due, so only this backlog remains.
  await drain(async () => ({ statusCode: 200, body: "ok" }));
  await enqueueMany(merchantId, 250);

  const sent: WebhookTransportRequest[] = [];
  // The poll tick is ten minutes away: only the one NOTIFY below starts work.
  const dispatcher = startWebhookDispatcher(pool, recordingTransport(url, sent), makeConfig({ WEBHOOK_POLL_INTERVAL_MS: "600000" }));
  try {
    await sleep(500); // LISTEN is up
    await pool.query(`SELECT pg_notify('outbox_events_channel', 'test')`);
    const deadline = Date.now() + 15_000;
    while (sent.length < 250 && Date.now() < deadline) await sleep(50);
    assert.equal(sent.length, 250, "the backlog stopped after one batch, waiting for the next trigger");
  } finally {
    await dispatcher.stop();
  }
});

/**
 * Runs `fn` with a pool whose Step A statement is first run under EXPLAIN
 * ANALYZE, and returns how many outbox_events rows that statement read.
 */
async function outboxRowsReadByStepA(fn: (p: Pool) => Promise<unknown>): Promise<number> {
  let rowsRead = -1;
  const sumOutbox = (node: Record<string, unknown>): number => {
    let n = 0;
    if (node["Relation Name"] === "outbox_events") {
      n += Number(node["Actual Rows"] ?? 0) * Number(node["Actual Loops"] ?? 1) + Number(node["Rows Removed by Filter"] ?? 0) * Number(node["Actual Loops"] ?? 1);
    }
    for (const child of (node["Plans"] as Record<string, unknown>[] | undefined) ?? []) n += sumOutbox(child);
    return n;
  };
  const measuringPool = {
    async connect(): Promise<PoolClient> {
      const client = await pool.connect();
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
      (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
        const sql = typeof args[0] === "string" ? args[0] : "";
        if (/FROM outbox_events oe/.test(sql) && /webhook_deliveries/.test(sql)) {
          const plan = await query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, args[1]);
          const root = (plan.rows[0]!["QUERY PLAN"] as Array<{ Plan: Record<string, unknown> }>)[0]!.Plan;
          rowsRead = sumOutbox(root);
        }
        return query(...args);
      };
      return client;
    },
    query: pool.query.bind(pool),
  } as unknown as Pool;
  await fn(measuringPool);
  return rowsRead;
}

test("a steady-state pass does not re-read the outbox history", async () => {
  const merchantId = await createMerchant();
  const url = `https://history-${randomUUID()}.example.test/hook`;
  await createEndpoint(merchantId, url);
  await enqueueMany(merchantId, 3_000);
  const ok: WebhookTransport = async () => ({ statusCode: 200, body: "ok" });
  await drain(ok);
  await runDispatchPass(pool, ok, config);
  // A production outbox has planner statistics (autovacuum); a table filled
  // a moment ago in a fresh test database may not have them yet.
  await pool.query("ANALYZE outbox_events");

  // One new event since the last pass: Step A should look at roughly that.
  await enqueueCaptured(pool, merchantId);
  const read = await outboxRowsReadByStepA((p) => runDispatchPass(p, ok, config));
  assert.ok(read >= 0, "the Step A statement was not seen");
  assert.ok(read < 200, `Step A read ${read} outbox rows to find one new event`);
});

test("an event that commits after a higher id was already handled is still delivered", async () => {
  const merchantId = await createMerchant();
  const url = `https://late-${randomUUID()}.example.test/hook`;
  const endpointId = await createEndpoint(merchantId, url);
  const ok: WebhookTransport = async () => ({ statusCode: 200, body: "ok" });

  const late = await pool.connect();
  try {
    await late.query("BEGIN");
    await enqueueCaptured(late, merchantId); // lower id, not committed yet
    await enqueueCaptured(pool, merchantId); // higher id, committed
    await drain(ok);
    assert.equal(await deliveriesFor(endpointId), 1);
    await late.query("COMMIT");
  } finally {
    late.release();
  }
  await drain(ok);
  assert.equal(await deliveriesFor(endpointId), 2, "the late-committing event was skipped");
});

test("events from while an endpoint was disabled are delivered once it is re-enabled", async () => {
  const merchantId = await createMerchant();
  const url = `https://reenable-${randomUUID()}.example.test/hook`;
  const endpointId = await createEndpoint(merchantId, url);
  const ok: WebhookTransport = async () => ({ statusCode: 200, body: "ok" });

  await enqueueCaptured(pool, merchantId);
  await drain(ok);
  assert.equal(await deliveriesFor(endpointId), 1);

  await pool.query(`UPDATE webhook_endpoints SET status = 'disabled' WHERE id = $1`, [endpointId]);
  await enqueueCaptured(pool, merchantId);
  // Other endpoints keep the dispatcher busy meanwhile.
  const other = await createMerchant();
  await createEndpoint(other, `https://other-${randomUUID()}.example.test/hook`);
  await enqueueCaptured(pool, other);
  await drain(ok);
  assert.equal(await deliveriesFor(endpointId), 1);

  await pool.query(`UPDATE webhook_endpoints SET status = 'active' WHERE id = $1`, [endpointId]);
  await drain(ok);
  assert.equal(await deliveriesFor(endpointId), 2, "the event from the disabled period was never delivered");
});
