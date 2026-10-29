import assert from "node:assert/strict";
import { test } from "node:test";
import { signPayload, verifySignature } from "./sign.js";

const SECRET = "whsec_test_secret";

test("signPayload/verifySignature round-trip: valid signature, fresh timestamp", () => {
  const payload = { transactionId: "abc", amountCapturedFils: 4750 };
  const { signature } = signPayload(payload, SECRET);
  const result = verifySignature(payload, signature, SECRET);
  assert.deepEqual(result, { valid: true });
});

test("signature header format is t=<seconds>,v1=<hex>", () => {
  const { timestamp, signature } = signPayload({ a: 1 }, SECRET, 1_700_000_000);
  assert.equal(timestamp, 1_700_000_000);
  assert.match(signature, /^t=1700000000,v1=[0-9a-f]{64}$/);
});

// Regression: the dispatcher signed canonicalJson(payload) but sent
// JSON.stringify(payload). A receiver verifying the bytes it received (the
// only thing it can do) then failed whenever keys weren't already sorted.
test("the signature covers the exact bytes sent: a receiver verifies the raw body it got", () => {
  const body = JSON.stringify({ type: "transaction.captured", id: "evt_1", data: { b: 2, a: 1 } });
  const { signature } = signPayload(body, SECRET);
  assert.equal(verifySignature(body, signature, SECRET).valid, true);
  const reordered = JSON.stringify({ data: { a: 1, b: 2 }, id: "evt_1", type: "transaction.captured" });
  assert.equal(verifySignature(reordered, signature, SECRET).reason, "signature_mismatch");
});

test("rotation: a header carrying v1 for the new and old secret verifies against either", () => {
  const body = '{"a":1}';
  const t = Math.floor(Date.now() / 1000);
  const vNew = signPayload(body, "whsec_new", t).signature.split("v1=")[1];
  const vOld = signPayload(body, "whsec_old", t).signature.split("v1=")[1];
  const header = `t=${t},v1=${vNew},v1=${vOld}`;
  assert.equal(verifySignature(body, header, "whsec_old").valid, true);
  assert.equal(verifySignature(body, header, ["whsec_new"]).valid, true);
  assert.equal(verifySignature(body, header, "whsec_other").valid, false);
});

test("a different payload produces a different signature", () => {
  const a = signPayload({ amountFils: 100 }, SECRET, 1_700_000_000);
  const b = signPayload({ amountFils: 101 }, SECRET, 1_700_000_000);
  assert.notEqual(a.signature, b.signature);
});

test("verifySignature rejects a tampered payload (signature_mismatch)", () => {
  const payload = { amountFils: 100 };
  const { signature } = signPayload(payload, SECRET);
  const result = verifySignature({ amountFils: 999 }, signature, SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "signature_mismatch");
});

test("verifySignature rejects the wrong secret (signature_mismatch)", () => {
  const payload = { amountFils: 100 };
  const { signature } = signPayload(payload, SECRET);
  const result = verifySignature(payload, signature, "whsec_wrong_secret");
  assert.equal(result.valid, false);
  assert.equal(result.reason, "signature_mismatch");
});

test("verifySignature rejects a malformed header", () => {
  const payload = { amountFils: 100 };
  assert.equal(verifySignature(payload, "not-a-real-header", SECRET).reason, "malformed_header");
  assert.equal(verifySignature(payload, "t=abc,v1=deadbeef", SECRET).reason, "malformed_header");
  assert.equal(verifySignature(payload, "v1=deadbeef", SECRET).reason, "malformed_header");
});

test("verifySignature enforces the timestamp tolerance window", () => {
  const payload = { amountFils: 100 };
  const nowSeconds = 1_700_000_000;
  const { signature } = signPayload(payload, SECRET, nowSeconds - 400); // 400s stale, default tolerance 300s

  const result = verifySignature(payload, signature, SECRET, { now: nowSeconds });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "timestamp_out_of_tolerance");

  // A wider tolerance accepts the same signature.
  const withinWideTolerance = verifySignature(payload, signature, SECRET, {
    now: nowSeconds,
    toleranceSeconds: 1000,
  });
  assert.equal(withinWideTolerance.valid, true);
});

// YA: keep this test, it stops someone 'simplifying' to ===
test("verifySignature uses timingSafeEqualHex, not ===: a same-length wrong signature still returns signature_mismatch (not a thrown error)", () => {
  const payload = { amountFils: 100 };
  const { signature } = signPayload(payload, SECRET);
  const [tPart] = signature.split(",");
  const wrongSameLength = `${tPart},v1=${"0".repeat(64)}`;
  const result = verifySignature(payload, wrongSameLength, SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "signature_mismatch");
});
