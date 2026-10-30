import assert from "node:assert/strict";
import { test } from "node:test";
import { allocateRemainder, toFils } from "./fils.js";

// allocateRemainder used to count a weight's decimals from `w.toString()`
// and scale every weight with `toFixed(min(9, decimals))`. That reads the
// wrong scale for any weight JavaScript prints in exponent form and rounds
// away every digit past the ninth, so the shares were not proportional to
// the weights the caller passed.

test("a weight beyond nine decimals still counts (was rounded away)", () => {
  // 1e12 fils split 1 : 1.0000000004. Exact shares are
  // 499,999,999,900.00000002 and 500,000,000,099.99999998. toFixed(9) made
  // both weights 1.000000000 and paid 500,000,000,000 each, 100 fils off.
  const shares = allocateRemainder(toFils(1_000_000_000_000), [1, 1.0000000004]);
  assert.deepEqual(shares, [499_999_999_900, 500_000_000_100]);
});

test("tiny non-zero weights are not treated as zero (exponent form 1e-7)", () => {
  // `(1e-7).toString()` is "1e-7": no ".", so the old code scaled with 0
  // decimals, turned every weight into 0 and threw "weights must not all be zero".
  assert.deepEqual(allocateRemainder(toFils(10), [1e-7, 0]), [10, 0]);
  assert.deepEqual(allocateRemainder(toFils(10), [4e-10, 6e-10]), [4, 6]);
});

test("huge weights work (exponent form 1e21 used to throw a SyntaxError)", () => {
  assert.deepEqual(allocateRemainder(toFils(10), [1e21, 1e21]), [5, 5]);
  assert.deepEqual(allocateRemainder(toFils(3), [3e21, 0]), [3, 0]);
});

test("ordinary decimal weights are unchanged", () => {
  assert.deepEqual(allocateRemainder(toFils(10), [0.1, 0.2]), [3, 7]);
  assert.deepEqual(allocateRemainder(toFils(1_001), [3_333, 3_333, 3_334]), [334, 333, 334]);
  assert.deepEqual(allocateRemainder(toFils(3), [0.1, 0.2, 0.3]), [1, 1, 1]);
});
