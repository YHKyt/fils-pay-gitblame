import assert from "node:assert/strict";
import { test } from "node:test";
import { bhd } from "./format.js";

test("bhd renders positive and zero amounts with three decimals", () => {
  assert.equal(bhd(4750), "4.750 BHD");
  assert.equal(bhd(0), "0.000 BHD");
});

test("bhd renders a negative refund event amount instead of throwing", () => {
  // Shape from GET /v1/transactions/:id/events for a 'refund_partial' event.
  assert.equal(bhd(-1500), "-1.500 BHD");
  assert.equal(bhd(-5), "-0.005 BHD");
});
