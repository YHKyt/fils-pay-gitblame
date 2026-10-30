import { test } from "node:test";
import assert from "node:assert/strict";
import { uuid } from "./uuid.js";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("uuid returns a v4-shaped string", () => {
  assert.match(uuid(), V4);
});

test("uuid is unique across calls", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) seen.add(uuid());
  assert.equal(seen.size, 1000);
});

test("uuid falls back when randomUUID is missing (insecure http context)", () => {
  const original = globalThis.crypto.randomUUID;
  try {
    // Simulate a non-secure context: crypto.randomUUID is undefined there,
    // but crypto.getRandomValues is still present.
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    });
    assert.match(uuid(), V4);
  } finally {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: original,
      configurable: true,
    });
  }
});
