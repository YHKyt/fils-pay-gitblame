import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { creditFeeReversalLabel } from "./format.js";

// The server reverses the fee at the dated fee_schedules rate in force on the
// effective date, less the volume-tier bonus (apps/api/src/admin/credits.ts;
// apps/api/src/admin/credits.test.ts "the fee reversal uses the dated
// fee_schedules rate ..."). The form used to label the box with
// merchants.mdr_bps: 2.50% for a merchant charged 1.80% by its schedule, so
// the operator approved a reversal of one size while being shown another.
test("the credit form's fee-reversal label names the effective date, not merchants.mdr_bps", () => {
  const label = creditFeeReversalLabel("2026-09-15");
  assert.match(label, /2026-09-15/);
  assert.match(label, /fee schedule/);
  assert.doesNotMatch(label, /%/);
  assert.match(creditFeeReversalLabel(""), /the effective date/);

  const page = readFileSync(new URL("./pages/merchants/MerchantDetailPage.tsx", import.meta.url), "utf8");
  const form = page.slice(page.indexOf("checked={creditReverseFee}"));
  const label0 = form.slice(0, form.indexOf("</label>"));
  assert.doesNotMatch(label0, /mdrBps/, "the reversal box still quotes merchants.mdr_bps");
  assert.match(label0, /creditFeeReversalLabel\(creditEffectiveDate\)/);
});
