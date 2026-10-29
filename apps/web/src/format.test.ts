import assert from "node:assert/strict";
import { test } from "node:test";
import { bahrainDateTime, bahrainTime, bhd, dateTime, dayStartIso, localDateTimeToIso } from "./format.js";

test("bhd renders positive and zero amounts with three decimals", () => {
  assert.equal(bhd(4750), "4.750 BHD");
  assert.equal(bhd(0), "0.000 BHD");
});

test("bhd renders a negative refund event amount instead of throwing", () => {
  // Shape from GET /v1/transactions/:id/events for a 'refund_partial' event.
  assert.equal(bhd(-1500), "-1.500 BHD");
  assert.equal(bhd(-5), "-0.005 BHD");
});

// The assertions below hold in any browser zone: the helpers must never
// read the viewer's local timezone (try TZ=America/New_York).
test("dateTime renders the instant in Asia/Bahrain, not the browser zone", () => {
  assert.equal(dateTime("2026-10-29T21:30:00.000Z"), "2026-10-30 00:30:00");
  assert.equal(dateTime("2026-10-29T09:00:05.000Z"), "2026-10-29 12:00:05");
  assert.equal(dateTime(null), "—");
  assert.equal(dateTime("not a date"), "—");
});

test("bahrainTime and bahrainDateTime use the same Bahrain wall clock", () => {
  assert.equal(bahrainTime("2026-10-29T21:30:00.000Z"), "00:30:00");
  assert.equal(bahrainDateTime("2026-10-29T09:00:05.000Z"), "2026-10-29 12:00:05 (Bahrain time)");
  assert.equal(bahrainDateTime(undefined), "—");
});

test("dayStartIso is Bahrain midnight, so a from/to day is a Bahrain business day", () => {
  assert.equal(dayStartIso("2026-10-29"), "2026-10-28T21:00:00.000Z");
  assert.equal(dayStartIso("2026-11-01"), "2026-10-31T21:00:00.000Z");
  assert.equal(dayStartIso(""), undefined);
  assert.equal(dayStartIso("garbage"), undefined);
});

test("localDateTimeToIso reads a datetime-local value as Bahrain wall time", () => {
  assert.equal(localDateTimeToIso("2026-10-29T12:00"), "2026-10-29T09:00:00.000Z");
  assert.equal(localDateTimeToIso("2026-10-29T00:15:30"), "2026-10-28T21:15:30.000Z");
  assert.equal(localDateTimeToIso(""), null);
});
