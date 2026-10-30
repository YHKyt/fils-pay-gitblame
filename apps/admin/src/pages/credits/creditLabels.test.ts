import assert from "node:assert/strict";
import { test } from "node:test";

import { creditReasonText, merchantName, shortId } from "./creditLabels.js";

test("reason text joins the category and the typed note", () => {
  assert.equal(creditReasonText("goodwill", "agreed on the call"), "Goodwill — agreed on the call");
});

test("reason text is the category alone when there is no note", () => {
  assert.equal(creditReasonText("goodwill", null), "Goodwill");
  assert.equal(creditReasonText("goodwill", "   "), "Goodwill");
});

test("short id is the first eight characters", () => {
  assert.equal(shortId("9972daab-1111-2222-3333-444455556666"), "9972daab");
});

test("merchant name is null until the lookup has it", () => {
  const names = new Map([["m1", "Gulf Coffee"]]);
  assert.equal(merchantName(names, "m1"), "Gulf Coffee");
  assert.equal(merchantName(names, "m2"), null);
});
