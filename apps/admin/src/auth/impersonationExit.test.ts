import assert from "node:assert/strict";
import { test } from "node:test";
import { forgetGrantAfterEndFailure } from "./impersonationExit.js";

test("a 404 from the end call means the grant is already gone: forget it", () => {
  assert.equal(forgetGrantAfterEndFailure({ statusCode: 404, code: "impersonation_grant_not_found" }), true);
});

test("network errors, 5xx and 401 keep the banner: the grant may still be live", () => {
  assert.equal(forgetGrantAfterEndFailure(new TypeError("Failed to fetch")), false);
  assert.equal(forgetGrantAfterEndFailure({ statusCode: 500 }), false);
  assert.equal(forgetGrantAfterEndFailure({ statusCode: 401 }), false);
  assert.equal(forgetGrantAfterEndFailure(null), false);
});
