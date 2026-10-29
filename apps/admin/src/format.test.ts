import assert from "node:assert/strict";
import { test } from "node:test";
import { bahrainDate, bahrainInputToIso, date, dateTime, time, toBahrainInputValue } from "./format.js";

// Independent of the process/browser zone (try TZ=America/New_York).
test("dateTime/date/time render Asia/Bahrain wall time", () => {
  assert.equal(dateTime("2026-10-29T21:30:00.000Z"), "2026-10-30 00:30:00");
  assert.equal(date("2026-10-29T21:30:00.000Z"), "2026-10-30");
  assert.equal(time("2026-10-29T21:30:00.000Z"), "00:30:00");
  assert.equal(dateTime(null), "-");
  assert.equal(dateTime(null, "never"), "never");
});

test("bahrainDate is the Bahrain calendar date, not the UTC or browser one", () => {
  // 22:00Z on the 29th is already the 30th in Bahrain.
  const now = Date.parse("2026-10-29T22:00:00.000Z");
  assert.equal(bahrainDate(0, now), "2026-10-30");
  assert.equal(bahrainDate(-1, now), "2026-10-29");
  // 20:59Z is still the 29th in Bahrain.
  assert.equal(bahrainDate(0, Date.parse("2026-10-29T20:59:59.000Z")), "2026-10-29");
});

test("datetime-local values round-trip as Bahrain wall time", () => {
  assert.equal(toBahrainInputValue(new Date("2026-10-29T09:00:00.000Z")), "2026-10-29T12:00");
  assert.equal(bahrainInputToIso("2026-10-29T12:00"), "2026-10-29T09:00:00.000Z");
  assert.equal(bahrainInputToIso(""), null);
});
