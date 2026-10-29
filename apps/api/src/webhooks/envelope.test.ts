/**
 * buildEnvelope is the field-by-field mapper between an internal
 * outbox_events row and the public webhook body merchants integrate
 * against. Pure — no database needed.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { buildEnvelope } from "./envelope.js";

test("settlement.paid maps to the documented public data shape", () => {
  const deliveryEventId = randomUUID();
  const batchId = randomUUID();
  const merchantId = randomUUID();
  const createdAt = new Date("2026-09-09T21:05:00.000Z");

  const envelope = buildEnvelope(deliveryEventId, {
    eventType: "settlement.paid",
    aggregateId: batchId,
    payload: { merchantId, batchId, batchDate: "2026-09-09", netPayoutFils: 471_300 },
    createdAt,
  });

  assert.deepEqual(envelope, {
    id: deliveryEventId,
    type: "settlement.paid",
    createdAt: "2026-09-09T21:05:00.000Z",
    data: {
      settlementBatchId: batchId,
      merchantId,
      batchDate: "2026-09-09",
      netPayoutFils: 471_300,
    },
  });
});

// MK: was refund.created before the rename
test("buildEnvelope rejects an event type it has no mapping for", () => {
  assert.throws(
    () =>
      buildEnvelope(randomUUID(), {
        eventType: "settlement.batch_closed",
        aggregateId: randomUUID(),
        payload: {},
        createdAt: new Date(),
      }),
    /unsupported event type/,
  );
});

test("refund.succeeded maps processRefund's outbox payload to the public shape", () => {
  const deliveryEventId = randomUUID();
  const transactionId = randomUUID();
  const merchantId = randomUUID();
  const refundId = randomUUID();

  const envelope = buildEnvelope(deliveryEventId, {
    eventType: "refund.succeeded",
    aggregateId: transactionId,
    payload: {
      merchantId,
      refundId,
      amountFils: 4_000,
      feeReversedFils: 100,
      refundedTotalFils: 4_000,
      newStatus: "partially_refunded",
    },
    createdAt: new Date("2026-10-01T09:00:00.000Z"),
  });

  assert.deepEqual(envelope, {
    id: deliveryEventId,
    type: "refund.succeeded",
    createdAt: "2026-10-01T09:00:00.000Z",
    data: {
      refundId,
      transactionId,
      merchantId,
      amountFils: 4_000,
      feeReversedFils: 100,
      refundedTotalFils: 4_000,
      status: "partially_refunded",
    },
  });
});
