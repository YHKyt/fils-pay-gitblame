import assert from "node:assert/strict";
import test from "node:test";
import { attemptFor, isDefinitiveFailure } from "./idempotencyIntent.js";

function counter(): () => string {
  let n = 0;
  return () => `key-${++n}`;
}

test("re-submitting the same request after a lost response reuses the key", () => {
  const mint = counter();
  const first = attemptFor(null, '{"amountFils":500}', mint);
  const retry = attemptFor(first, '{"amountFils":500}', mint);
  assert.equal(retry.key, first.key);
});

test("editing the amount and back again does not rotate the key (no per-keystroke rotation)", () => {
  const mint = counter();
  const first = attemptFor(null, '{"amountFils":500}', mint);
  // Typing "5000" then deleting the last 0 never reaches attemptFor: only
  // what is actually submitted decides the key.
  const resubmitted = attemptFor(first, '{"amountFils":500}', mint);
  assert.equal(resubmitted.key, "key-1");
});

test("submitting a different amount mints a new key", () => {
  const mint = counter();
  const first = attemptFor(null, '{"amountFils":500}', mint);
  const second = attemptFor(first, '{"amountFils":400}', mint);
  assert.notEqual(second.key, first.key);
  assert.equal(second.request, '{"amountFils":400}');
});

test("after a definitive answer (attempt cleared) the same request is a new intent", () => {
  const mint = counter();
  const first = attemptFor(null, "{}", mint);
  const next = attemptFor(null, "{}", mint);
  assert.notEqual(next.key, first.key);
});

test("only HTTP 4xx answers are definitive; network errors, 5xx, 429 and in-progress are not", () => {
  assert.equal(isDefinitiveFailure({ statusCode: 402, code: "declined" }), true);
  assert.equal(isDefinitiveFailure({ statusCode: 422, code: "idempotency_key_reused" }), true);
  assert.equal(isDefinitiveFailure({ statusCode: 409, code: "invalid_state" }), true);
  assert.equal(isDefinitiveFailure({ statusCode: 409, code: "request_in_progress" }), false);
  assert.equal(isDefinitiveFailure({ statusCode: 429, code: "rate_limited" }), false);
  assert.equal(isDefinitiveFailure({ statusCode: 502, code: "acquirer_error" }), false);
  assert.equal(isDefinitiveFailure(new TypeError("Failed to fetch")), false);
  assert.equal(isDefinitiveFailure(new DOMException("aborted", "AbortError")), false);
});
