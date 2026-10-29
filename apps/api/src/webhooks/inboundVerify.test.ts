/**
 * Unit tests for the inbound acquirer-callback signature verifier. Pure
 * function, no database — the route-level behavior it drives is covered in
 * routes/acquirerCallbacks.test.ts.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { verifyAcquirerCallbackSignature } from "./inboundVerify.js";

const SECRET = "acqsec_test_secret";
const NOW = Math.floor(Date.now() / 1000);

/** The header the acquirer would send for these exact body bytes. */
function acquirerHeader(rawBody: string, secret: string, timestamp = NOW): string {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

const RAW = JSON.stringify({ callbackId: "acqcb_1", outcome: "cleared" });

test("a correctly-signed callback verifies", () => {
  assert.deepEqual(verifyAcquirerCallbackSignature(RAW, acquirerHeader(RAW, SECRET), SECRET), { valid: true });
});

test("verification covers the raw bytes: same JSON, different key order/whitespace is a mismatch", () => {
  const header = acquirerHeader(RAW, SECRET);
  const reordered = '{"outcome":"cleared","callbackId":"acqcb_1"}';
  assert.equal(verifyAcquirerCallbackSignature(reordered, header, SECRET).reason, "signature_mismatch");
  // ...and a body serialized differently from how we'd re-serialize it still verifies.
  const spaced = '{ "callbackId": "acqcb_1", "outcome": "cleared" }';
  assert.equal(verifyAcquirerCallbackSignature(spaced, acquirerHeader(spaced, SECRET), SECRET).valid, true);
});

test("a tampered payload is rejected (signature_mismatch)", () => {
  const header = acquirerHeader(RAW, SECRET);
  const tampered = JSON.stringify({ callbackId: "acqcb_1", outcome: "confirmed_fraud" });
  const result = verifyAcquirerCallbackSignature(tampered, header, SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "signature_mismatch");
});

test("the wrong secret is rejected (signature_mismatch)", () => {
  const result = verifyAcquirerCallbackSignature(RAW, acquirerHeader(RAW, "acqsec_someone_elses_secret"), SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "signature_mismatch");
});

test("a malformed header is rejected (malformed_header)", () => {
  assert.equal(verifyAcquirerCallbackSignature(RAW, "not-a-real-header", SECRET).reason, "malformed_header");
  assert.equal(verifyAcquirerCallbackSignature(RAW, "t=abc,v1=deadbeef", SECRET).reason, "malformed_header");
  assert.equal(verifyAcquirerCallbackSignature(RAW, "v1=deadbeef", SECRET).reason, "malformed_header");
});

test("an unsigned callback is rejected by default", () => {
  assert.deepEqual(verifyAcquirerCallbackSignature(RAW, undefined, SECRET), {
    valid: false,
    reason: "missing_signature",
  });
  // Only an explicit opt-out (unsigned sandbox) lets it through.
  assert.deepEqual(verifyAcquirerCallbackSignature(RAW, undefined, SECRET, false), { valid: true });
});

test("a stale (replayed) callback is rejected", () => {
  const result = verifyAcquirerCallbackSignature(RAW, acquirerHeader(RAW, SECRET, NOW - 3600), SECRET);
  assert.equal(result.reason, "timestamp_out_of_tolerance");
});

test("key rotation: callbacks signed with either the current or previous secret verify", () => {
  const rotating = "acqsec_new,acqsec_old";
  assert.equal(verifyAcquirerCallbackSignature(RAW, acquirerHeader(RAW, "acqsec_new"), rotating).valid, true);
  assert.equal(verifyAcquirerCallbackSignature(RAW, acquirerHeader(RAW, "acqsec_old"), rotating).valid, true);
  assert.equal(verifyAcquirerCallbackSignature(RAW, acquirerHeader(RAW, "acqsec_retired"), rotating).valid, false);
});

test("an empty secret never verifies anything", () => {
  assert.equal(verifyAcquirerCallbackSignature(RAW, acquirerHeader(RAW, ""), "").valid, false);
});
