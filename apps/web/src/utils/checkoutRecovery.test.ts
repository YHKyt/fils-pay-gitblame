import assert from "node:assert/strict";
import test from "node:test";
import { bahrainDateTime } from "../format.js";
import type { PaymentLinkPublicDto, PublicPaymentLinkStatus } from "../types.js";
import { endsCheckoutAttempt, isOutcomeUnknown, resolveLostPayment } from "./checkoutRecovery.js";

function link(status: PublicPaymentLinkStatus): PaymentLinkPublicDto {
  return {
    token: "tok",
    amountFils: 4_750,
    currency: "BHD",
    merchantDisplayName: "Shop",
    reference: null,
    description: null,
    status,
    expiresAt: "2026-12-31T00:00:00.000Z",
  };
}

const noSleep = async () => {};

test("timeouts, network errors and non-502 5xx leave the outcome unknown; 4xx and 502 do not", () => {
  assert.equal(isOutcomeUnknown(new DOMException("The operation was aborted.", "AbortError")), true);
  assert.equal(isOutcomeUnknown(new TypeError("Failed to fetch")), true);
  assert.equal(isOutcomeUnknown({ statusCode: 500 }), true);
  assert.equal(isOutcomeUnknown({ statusCode: 504 }), true);
  assert.equal(isOutcomeUnknown({ statusCode: 502 }), false);
  assert.equal(isOutcomeUnknown({ statusCode: 402 }), false);
  assert.equal(isOutcomeUnknown({ statusCode: 409 }), false);
});

test("a lost response whose payment went through resolves to the receipt, not a re-pay", async () => {
  const statuses: PublicPaymentLinkStatus[] = ["processing", "processing", "paid"];
  let calls = 0;
  const result = await resolveLostPayment(async () => link(statuses[calls++]!), { attempts: 5, delayMs: 0, sleep: noSleep });
  assert.equal(result.kind, "paid");
  assert.equal(calls, 3);
});

test("a link still active after the lost response may be paid again", async () => {
  const result = await resolveLostPayment(async () => link("active"), { attempts: 3, delayMs: 0, sleep: noSleep });
  assert.equal(result.kind, "retryable");
});

test("expired/canceled meanwhile is closed", async () => {
  const result = await resolveLostPayment(async () => link("expired"), { attempts: 3, delayMs: 0, sleep: noSleep });
  assert.equal(result.kind, "closed");
});

test("still processing (or unreadable) after every poll is unknown, never 'retryable'", async () => {
  let calls = 0;
  const processing = await resolveLostPayment(
    async () => {
      calls += 1;
      return link("processing");
    },
    { attempts: 4, delayMs: 0, sleep: noSleep },
  );
  assert.equal(processing.kind, "unknown");
  assert.equal(calls, 4);

  const failing = await resolveLostPayment(
    async () => {
      throw new TypeError("Failed to fetch");
    },
    { attempts: 2, delayMs: 0, sleep: noSleep },
  );
  assert.equal(failing.kind, "unknown");
});

test("Paid at is rendered in Asia/Bahrain (UTC+3), not the viewer's zone", () => {
  assert.equal(bahrainDateTime("2026-10-29T09:00:05.000Z"), "2026-10-29 12:00:05 (Bahrain time)");
  // Crosses midnight in Bahrain while still the previous day in UTC.
  assert.equal(bahrainDateTime("2026-10-28T22:30:00.000Z"), "2026-10-29 01:30:00 (Bahrain time)");
  assert.equal(bahrainDateTime(null), "—");
});

// Regression: the checkout rotated its Idempotency-Key on every 4xx, so a
// "payment in flight" 409 made the next Pay authorize the card a second
// time under a new key, orphaning the first authorization.
test("an in-flight 409 keeps the checkout key; a decline or a closed link ends the attempt", () => {
  assert.equal(endsCheckoutAttempt({ statusCode: 409, code: "payment_link_processing" }), false);
  assert.equal(endsCheckoutAttempt({ statusCode: 409, code: "request_in_progress" }), false);
  assert.equal(endsCheckoutAttempt({ statusCode: 429, code: "rate_limited" }), false);
  assert.equal(endsCheckoutAttempt({ statusCode: 500, code: "internal_error" }), false);
  assert.equal(endsCheckoutAttempt(new TypeError("Failed to fetch")), false);
  assert.equal(endsCheckoutAttempt({ statusCode: 402, code: "card_declined" }), true);
  assert.equal(endsCheckoutAttempt({ statusCode: 409, code: "payment_link_already_paid" }), true);
  assert.equal(endsCheckoutAttempt({ statusCode: 410, code: "payment_link_expired" }), true);
});
