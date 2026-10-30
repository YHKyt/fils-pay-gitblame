import assert from "node:assert/strict";
import test from "node:test";
import { attemptFor, isDefinitiveFailure } from "./idempotencyIntent.js";

function counter(): () => string {
  let n = 0;
  return () => `key-${++n}`;
}

const credit = (baseAmountFils: number) =>
  JSON.stringify(["merchant-1", { baseAmountFils, reasonCode: "goodwill", effectiveDate: "2026-10-30" }]);

test("a credit re-submitted after a timeout or a 5xx keeps its Idempotency-Key", () => {
  const mint = counter();
  const first = attemptFor(null, credit(40_000), mint);
  // The page keeps the attempt because the failure was not definitive.
  assert.equal(isDefinitiveFailure(new TypeError("Failed to fetch")), false);
  assert.equal(isDefinitiveFailure({ statusCode: 503, code: "unavailable" }), false);
  assert.equal(attemptFor(first, credit(40_000), mint).key, first.key);
});

test("changing the amount, or the merchant, is a new intent with a new key", () => {
  const mint = counter();
  const first = attemptFor(null, credit(40_000), mint);
  assert.notEqual(attemptFor(first, credit(41_000), mint).key, first.key);
  const otherMerchant = JSON.stringify(["merchant-2", JSON.parse(credit(40_000))[1]]);
  assert.notEqual(attemptFor(first, otherMerchant, mint).key, first.key);
});

test("after a success or a definitive 4xx the page clears the attempt, so the same form is a new credit", () => {
  const mint = counter();
  const first = attemptFor(null, credit(40_000), mint);
  assert.equal(isDefinitiveFailure({ statusCode: 400, code: "invalid_request" }), true);
  assert.equal(isDefinitiveFailure({ statusCode: 409, code: "request_in_progress" }), false);
  assert.notEqual(attemptFor(null, credit(40_000), mint).key, first.key);
});
