import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCreditRequestInput } from "./creditRequestValidation.js";
import { AppError } from "../lib/errors.js";

/** Dates are computed relative to now, never hardcoded: a fixed calendar
 *  date in a test file silently becomes a different kind of date as the repo
 *  ages. */
function isoDaysFromToday(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function assertBadRequest(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, code);
    return true;
  });
}

const VALID = {
  baseAmountFils: 25_000,
  reasonCode: "goodwill",
  effectiveDate: isoDaysFromToday(0),
};

test("a well-formed body parses through with its fields normalised", () => {
  const draft = parseCreditRequestInput({
    ...VALID,
    memo: "  agreed with the merchant on the call  ",
    reverseFee: true,
  });
  assert.deepEqual(draft, {
    baseAmountFils: 25_000,
    reasonCode: "goodwill",
    memo: "agreed with the merchant on the call",
    reverseFee: true,
    effectiveDate: VALID.effectiveDate,
  });
});

test("memo and reverseFee are optional and default to null / false", () => {
  const draft = parseCreditRequestInput(VALID);
  assert.equal(draft.memo, null);
  assert.equal(draft.reverseFee, false);
});

test("an empty or whitespace-only memo normalises to null, not an empty string", () => {
  assert.equal(parseCreditRequestInput({ ...VALID, memo: "   " }).memo, null);
  assert.equal(parseCreditRequestInput({ ...VALID, memo: null }).memo, null);
});

test("the body itself must be a JSON object", () => {
  for (const body of [undefined, null, "nope", 42, [VALID]]) {
    assertBadRequest(() => parseCreditRequestInput(body), "invalid_request");
  }
});

test("the amount must be a positive integer number of fils", () => {
  for (const baseAmountFils of [0, -1, 12.5, "25000", null, undefined, Number.NaN, Infinity]) {
    assertBadRequest(() => parseCreditRequestInput({ ...VALID, baseAmountFils }), "invalid_amount");
  }
  assert.equal(parseCreditRequestInput({ ...VALID, baseAmountFils: 1 }).baseAmountFils, 1);
});

test("the reason code must be one of the three the schema allows", () => {
  for (const reasonCode of ["goodwill", "dispute_resolution", "correction"]) {
    assert.equal(parseCreditRequestInput({ ...VALID, reasonCode }).reasonCode, reasonCode);
  }
  for (const reasonCode of ["", "refund", "GOODWILL", 7, null, undefined]) {
    assertBadRequest(
      () => parseCreditRequestInput({ ...VALID, reasonCode }),
      "invalid_reason_code",
    );
  }
});

test("a memo longer than 500 characters is rejected", () => {
  assert.doesNotThrow(() => parseCreditRequestInput({ ...VALID, memo: "x".repeat(500) }));
  assertBadRequest(() => parseCreditRequestInput({ ...VALID, memo: "x".repeat(501) }), "invalid_memo");
  assertBadRequest(() => parseCreditRequestInput({ ...VALID, memo: 5 }), "invalid_memo");
});

test("reverseFee must be a boolean if it is present at all", () => {
  assertBadRequest(() => parseCreditRequestInput({ ...VALID, reverseFee: "yes" }), "invalid_request");
  assertBadRequest(() => parseCreditRequestInput({ ...VALID, reverseFee: 1 }), "invalid_request");
});

test("the effective date must be formatted YYYY-MM-DD", () => {
  for (const effectiveDate of ["", "2026/03/15", "15-03-2026", "2026-3-5", "today", 20260315, null]) {
    assertBadRequest(
      () => parseCreditRequestInput({ ...VALID, effectiveDate }),
      "invalid_effective_date",
    );
  }
});

test("a well-formed date that is not a real calendar day is rejected, not rolled over", () => {
  // The naive `new Date('2026-02-30')` accepts this and silently becomes
  // March 2nd, which would book the credit into the wrong month.
  for (const effectiveDate of ["2026-02-30", "2026-13-01", "2026-00-10", "2025-02-29", "2027-04-31"]) {
    assertBadRequest(
      () => parseCreditRequestInput({ ...VALID, effectiveDate }),
      "invalid_effective_date",
    );
  }
});

// YA: there's a 'not older than 35 days' test right below this one
test("the effective date is carried through exactly as given", () => {
  for (const offset of [0, -2]) {
    const effectiveDate = isoDaysFromToday(offset);
    assert.equal(
      parseCreditRequestInput({ ...VALID, effectiveDate }).effectiveDate,
      effectiveDate,
      "no timezone round-trip may shift the operator's chosen accounting date",
    );
  }
});

test("a future effective date is rejected, judged against the Asia/Bahrain business day", () => {
  assertBadRequest(
    () => parseCreditRequestInput({ ...VALID, effectiveDate: "2099-01-01" }),
    "invalid_effective_date",
  );
  assertBadRequest(
    () => parseCreditRequestInput({ ...VALID, effectiveDate: isoDaysFromToday(2) }),
    "invalid_effective_date",
  );
  // 2026-03-15 22:30 UTC is already 2026-03-16 01:30 in Bahrain: the 16th is
  // "today" there and is accepted; the 17th is tomorrow and is not.
  const lateUtcEvening = new Date("2026-03-15T22:30:00Z");
  assert.equal(
    parseCreditRequestInput({ ...VALID, effectiveDate: "2026-03-16" }, lateUtcEvening).effectiveDate,
    "2026-03-16",
  );
  assertBadRequest(
    () => parseCreditRequestInput({ ...VALID, effectiveDate: "2026-03-17" }, lateUtcEvening),
    "invalid_effective_date",
  );
});
