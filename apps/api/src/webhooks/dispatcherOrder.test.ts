/**
 * Ordering of one dispatch pass's webhooks (docs/audit/eventsbus.md,
 * "Webhooks for one transaction can arrive out of order").
 *
 * Step A inserts every new delivery of a pass with next_attempt_at = now(),
 * which is one value for the whole transaction. Step B claimed
 * `ORDER BY next_attempt_at ASC` with no tie-breaker, so Postgres was free to
 * hand the tied rows out in any order (in practice: physical order, which
 * the claim UPDATEs themselves keep rewriting). A merchant that keeps the
 * latest `status` it was sent then ended up with the wrong state.
 *
 * Requires DATABASE_URL to point at a real, migrated Postgres. Step B is
 * global, so assertions are scoped to this test's own receiver URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { loadConfig } from "../config.js";
import { createWebhookEndpoint } from "./create.js";
import { runDispatchPass } from "./dispatcher.js";
import type { WebhookTransport } from "./transport.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("dispatcherOrder.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  WEBHOOK_MAX_ATTEMPTS: "3",
  WEBHOOK_BACKOFF_BASE_MS: "60000",
  WEBHOOK_BACKOFF_CAP_MS: "600000",
  WEBHOOK_REQUEST_TIMEOUT_MS: "5000",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });

test.after(async () => {
  await pool.end();
});

/** The audit's scenario on one transaction, in the order it happened:
 *  partial capture 6,000, final capture 4,000, partial refund 3,000, full
 *  refund 7,000. Returns the expected `data.status` sequence. */
async function enqueueTransactionLifecycle(merchantId: string): Promise<string[]> {
  const transactionId = randomUUID();
  const events: Array<{ eventType: string; payload: Record<string, unknown>; status: string }> = [
    {
      eventType: "transaction.captured",
      payload: { merchantId, amountCapturedFils: 6_000, feeFils: 150, newStatus: "partially_captured", capturedTotalFils: 6_000 },
      status: "partially_captured",
    },
    {
      eventType: "transaction.captured",
      payload: { merchantId, amountCapturedFils: 4_000, feeFils: 100, newStatus: "captured", capturedTotalFils: 10_000 },
      status: "captured",
    },
    {
      eventType: "refund.succeeded",
      payload: { merchantId, refundId: randomUUID(), amountFils: 3_000, feeReversedFils: 75, refundedTotalFils: 3_000, newStatus: "partially_refunded" },
      status: "partially_refunded",
    },
    {
      eventType: "refund.succeeded",
      payload: { merchantId, refundId: randomUUID(), amountFils: 7_000, feeReversedFils: 175, refundedTotalFils: 10_000, newStatus: "refunded" },
      status: "refunded",
    },
  ];
  for (const e of events) {
    await enqueueEvent(pool, { eventType: e.eventType, aggregateType: "transaction", aggregateId: transactionId, payload: e.payload });
  }
  return events.map((e) => e.status);
}

test("one pass sends a transaction's webhooks in event order (tied next_attempt_at)", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Dispatcher Order Merchant ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const url = `https://order-${randomUUID()}.example.test/hook`;
  const endpoint = await createWebhookEndpoint(pool, config, {
    merchantId,
    url,
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });

  // Several transactions so a lucky physical order cannot pass by chance.
  const expected: string[][] = [];
  for (let i = 0; i < 5; i += 1) expected.push(await enqueueTransactionLifecycle(merchantId));

  const sent: Array<{ transactionId: string; status: string }> = [];
  const transport: WebhookTransport = async (req) => {
    if (req.url === url) {
      const body = JSON.parse(req.body) as { data: { transactionId: string; status: string } };
      sent.push({ transactionId: body.data.transactionId, status: body.data.status });
    }
    return { statusCode: 200, body: "ok" };
  };

  await runDispatchPass(pool, transport, config);

  // Every delivery of the pass was created with the same next_attempt_at:
  // the order has to come from the tie-breaker, not from distinct times.
  const created = await pool.query<{ n: string }>(
    `SELECT count(DISTINCT created_at)::text AS n FROM webhook_deliveries WHERE endpoint_id = $1`,
    [endpoint.id],
  );
  assert.equal(created.rows[0]!.n, "1", "all deliveries come from one Step A transaction");

  assert.equal(sent.length, 20);
  const byTransaction = new Map<string, string[]>();
  for (const s of sent) byTransaction.set(s.transactionId, [...(byTransaction.get(s.transactionId) ?? []), s.status]);
  for (const statuses of byTransaction.values()) {
    assert.deepEqual(statuses, expected[0], `webhooks sent out of event order: ${statuses.join(" -> ")}`);
  }
});

test("tied deliveries are claimed in event order even when their physical order is reversed", async () => {
  // On a fresh table the tied rows happen to come back in insertion order, so
  // the bug hides. In production Step A's inserts land wherever the heap has
  // free space (claim and outcome UPDATEs leave plenty of it), so tied rows'
  // physical order need not follow event order. This reproduces that: the
  // first pass's sends all throw (rows stay pending, attempt_count 0), then
  // the rows are put back to one shared next_attempt_at, rewritten newest
  // event first, so their physical order is the reverse of event order.
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Dispatcher Order Merchant ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const url = `https://order-reversed-${randomUUID()}.example.test/hook`;
  const endpoint = await createWebhookEndpoint(pool, config, {
    merchantId,
    url,
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });
  const expected = await enqueueTransactionLifecycle(merchantId);

  const throwing: WebhookTransport = async (req) => {
    if (req.url === url) throw new Error("receiver unreachable (test)");
    return { statusCode: 200, body: "ok" };
  };
  const errorLog = console.error;
  console.error = () => {};
  try {
    await runDispatchPass(pool, throwing, config);
  } finally {
    console.error = errorLog;
  }

  const rows = await pool.query<{ id: string }>(
    `SELECT id FROM webhook_deliveries WHERE endpoint_id = $1 AND status = 'pending' AND attempt_count = 0
      ORDER BY outbox_event_id DESC`,
    [endpoint.id],
  );
  assert.equal(rows.rows.length, 4);
  const tiedAt = new Date(Date.now() - 60_000);
  for (const r of rows.rows) {
    await pool.query(`UPDATE webhook_deliveries SET next_attempt_at = $2 WHERE id = $1`, [r.id, tiedAt]);
  }

  const sent: string[] = [];
  const transport: WebhookTransport = async (req) => {
    if (req.url === url) sent.push((JSON.parse(req.body) as { data: { status: string } }).data.status);
    return { statusCode: 200, body: "ok" };
  };
  await runDispatchPass(pool, transport, config);

  assert.deepEqual(sent, expected, `webhooks sent out of event order: ${sent.join(" -> ")}`);
});
