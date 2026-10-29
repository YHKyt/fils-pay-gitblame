import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAdjustmentAmountFils } from "./adjustmentCsvParsing.js";

// Regression for the "CSV import is 10x off" finance report (Evidence 02):
// BHD is a 3-decimal currency, 1 BD = 1000 fils. The parser must read the
// amount at 3 decimals, not 2 ("cents"). Before the fix, "4.75" parsed to
// 475 fils (0.475 BD) instead of 4750 fils — every imported amount 10x small.

test("4.75 BD parses to 4750 fils (not 475)", () => {
  assert.equal(parseAdjustmentAmountFils("4.75"), 4750);
});

test("4.750 and 4.75 are the same amount", () => {
  assert.equal(parseAdjustmentAmountFils("4.750"), parseAdjustmentAmountFils("4.75"));
});

test("full 3-decimal precision is kept", () => {
  assert.equal(parseAdjustmentAmountFils("4.755"), 4755);
  assert.equal(parseAdjustmentAmountFils("0.001"), 1);
});

test("whole numbers and negatives (signed adjustments)", () => {
  assert.equal(parseAdjustmentAmountFils("10"), 10000);
  assert.equal(parseAdjustmentAmountFils("-2.500"), -2500);
});
