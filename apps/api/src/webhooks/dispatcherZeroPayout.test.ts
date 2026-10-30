/**
 * settlement.paid is enqueued for every paid batch, including ones with
 * nothing to pay out (the reporting read model needs it to show the batch
 * as paid: judgeprep JP5, eventsbus.md). Merchants must not get a "payout"
 * webhook for every empty day, so the dispatcher creates no delivery for a
 * settlement.paid whose netPayoutFils is zero or negative.
 *
 * Requires DATABASE_URL to point at a real, migrated Postgres. Step B is
 * global, so assertions are scoped to this test's own endpoint and URL.
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
  throw new Error("dispatcherZeroPayout.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
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

async function paidBatchEvent(merchantId: string, batchDate: string, netPayoutFils: number): Promise<string> {
  const batch = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at, paid_at)
     VALUES ($1, $2, 'paid', $3, 0, $3, now(), now()) RETURNING id`,
    [merchantId, batchDate, netPayoutFils],
  );
  const batchId = batch.rows[0]!.id;
  // The payload payout_notify.go enqueues.
  await enqueueEvent(pool, {
    eventType: "settlement.paid",
    aggregateType: "settlement_batch",
    aggregateId: batchId,
    payload: { merchantId, batchId, batchDate, netPayoutFils },
  });
  return batchId;
}

test("no payout webhook for a paid batch with zero or negative net; a positive one is still sent", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Dispatcher Zero Payout Merchant ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const url = `https://zero-payout-${randomUUID()}.example.test/hook`;
  const endpoint = await createWebhookEndpoint(pool, config, {
    merchantId,
    url,
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });

  const zeroBatch = await paidBatchEvent(merchantId, "2026-05-04", 0);
  const negativeBatch = await paidBatchEvent(merchantId, "2026-05-05", -1_250);
  const positiveBatch = await paidBatchEvent(merchantId, "2026-05-06", 9_750);

  const sent: Array<{ settlementBatchId: string; netPayoutFils: number }> = [];
  const transport: WebhookTransport = async (req) => {
    if (req.url === url) sent.push((JSON.parse(req.body) as { data: { settlementBatchId: string; netPayoutFils: number } }).data);
    return { statusCode: 200, body: "ok" };
  };
  await runDispatchPass(pool, transport, config);
  await runDispatchPass(pool, transport, config);

  assert.deepEqual(
    sent.map((d) => d.settlementBatchId),
    [positiveBatch],
    `only the positive payout may be sent, got ${JSON.stringify(sent)}`,
  );
  const deliveries = await pool.query<{ batch_id: string }>(
    `SELECT oe.aggregate_id AS batch_id FROM webhook_deliveries wd
       JOIN outbox_events oe ON oe.id = wd.outbox_event_id
      WHERE wd.endpoint_id = $1`,
    [endpoint.id],
  );
  assert.deepEqual(deliveries.rows.map((r) => r.batch_id), [positiveBatch], "no delivery row for a zero/negative payout");

  const disbursements = await pool.query<{ settlement_batch_id: string }>(
    `SELECT settlement_batch_id FROM settlement_payout_disbursements WHERE settlement_batch_id = ANY($1::uuid[])`,
    [[zeroBatch, negativeBatch]],
  );
  assert.equal(disbursements.rows.length, 0);
});
