/**
 * h3 lane report (Step A isolation): Step A cast the outbox payload's
 * merchantId to uuid (and settlement.paid's netPayoutFils to bigint) inside
 * one query. A single event with a malformed value made that query raise on
 * every pass, so no merchant got a webhook delivery created again. Real
 * Postgres.
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
  throw new Error("dispatcherPoisonEvent.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 3 });

test.after(async () => {
  await pool.end();
});

test("one malformed outbox event does not stop delivery creation for everyone", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Poison Event Merchant ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const url = `https://poison-${randomUUID()}.example.test/hook`;
  const endpoint = await createWebhookEndpoint(pool, config, {
    merchantId,
    url,
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });

  // Raw inserts: the malformed values a buggy producer could write.
  const poison = await pool.query<{ id: string }>(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
     VALUES ('transaction.captured', 'transaction', $1, '{"merchantId": "", "newStatus": "captured"}'::jsonb),
            ('settlement.paid', 'settlement_batch', $1, $2::jsonb)
     RETURNING id`,
    [randomUUID(), JSON.stringify({ merchantId, netPayoutFils: "12.5x", settlementBatchId: randomUUID() })],
  );
  try {
    const transactionId = randomUUID();
    await enqueueEvent(pool, {
      eventType: "transaction.captured",
      aggregateType: "transaction",
      aggregateId: transactionId,
      payload: { merchantId, amountCapturedFils: 1_000, feeFils: 25, newStatus: "captured", capturedTotalFils: 1_000 },
    });

    const sent: string[] = [];
    const transport: WebhookTransport = async (req) => {
      if (req.url === url) sent.push((JSON.parse(req.body) as { data: { transactionId: string } }).data.transactionId);
      return { statusCode: 200, body: "ok" };
    };
    const errorLog = console.error;
    console.error = () => {};
    try {
      for (let i = 0; i < 50 && sent.length === 0; i += 1) {
        await runDispatchPass(pool, transport, config).catch(() => undefined);
      }
    } finally {
      console.error = errorLog;
    }
    assert.deepEqual(sent, [transactionId], "the valid event was never delivered");
    const deliveries = await pool.query(`SELECT 1 FROM webhook_deliveries WHERE endpoint_id = $1`, [endpoint.id]);
    assert.equal(deliveries.rowCount, 1, "only the valid event gets a delivery");
  } finally {
    await pool.query(`DELETE FROM outbox_events WHERE id = ANY($1::bigint[])`, [poison.rows.map((r) => r.id)]);
  }
});
