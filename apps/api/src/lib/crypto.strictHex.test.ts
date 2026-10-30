/**
 * h2 lane report: timingSafeEqualHex accepted a valid digest followed by
 * junk, because Buffer.from(_, "hex") stops at the first non-hex character.
 * Inbound webhook and acquirer signatures are compared with it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex, timingSafeEqualHex } from "./crypto.js";

test("a digest with trailing junk does not match", () => {
  const d = sha256Hex("payload");
  assert.equal(timingSafeEqualHex(d, d), true);
  assert.equal(timingSafeEqualHex(d, `${d}zz`), false);
  assert.equal(timingSafeEqualHex(d, `${d}z`), false);
  assert.equal(timingSafeEqualHex(d, `${d} `), false);
  assert.equal(timingSafeEqualHex(`${d}zz`, d), false);
  assert.equal(timingSafeEqualHex("", ""), false);
});
