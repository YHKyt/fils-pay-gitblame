import assert from "node:assert/strict";
import { test } from "node:test";
import { actorDisplay, truncateMiddle } from "./format.js";

test("actorDisplay labels every actor id with its kind", () => {
  assert.equal(actorDisplay("merchant_session", "97ba2ab3-0000-4000-8000-000000000000"), "Dashboard user · #97BA2AB3");
  assert.equal(actorDisplay("merchant_api_key", "1c0ffee2-0000-4000-8000-000000000000"), "API key · #1C0FFEE2");
  assert.equal(actorDisplay("system", "97ba2ab3-0000-4000-8000-000000000000"), "System");
  assert.equal(actorDisplay("merchant_session", null), "Dashboard user");
});

test("truncateMiddle keeps the prefix and the tail of a long reference", () => {
  assert.equal(truncateMiddle("acq_5d1e2f3a-1b2c-4d5e-8f90-a1b2c3a8cf0d"), "acq_…3a8cf0d");
  assert.equal(truncateMiddle("acq_short"), "acq_short");
});
