import assert from "node:assert/strict";
import { test } from "node:test";
import { bhdDisplay as bhd, groupThousands, pageTitle } from "./format.js";

test("bhdDisplay groups thousands in the whole-dinar part", () => {
  assert.equal(bhd(136518147), "136,518.147 BHD");
  assert.equal(bhd(-1234567), "-1,234.567 BHD");
  assert.equal(bhd(999999), "999.999 BHD");
  assert.equal(bhd(0), "0.000 BHD");
});

test("groupThousands leaves non-numeric text alone", () => {
  assert.equal(groupThousands("1000000"), "1,000,000");
  assert.equal(groupThousands("abc"), "abc");
});

test("pageTitle appends the product name", () => {
  assert.equal(pageTitle("Transactions"), "Transactions · FilsPay");
});
