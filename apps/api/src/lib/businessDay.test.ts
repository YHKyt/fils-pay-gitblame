import assert from "node:assert/strict";
import { test } from "node:test";
import { latestClosableBusinessDate } from "./businessDay.js";

// Regression: the run-batch guard allowed yesterday from the very instant of
// Asia/Bahrain midnight (21:00Z). A capture stamped 23:59:59.999 Bahrain time
// and still committing then was missed by the close and never re-scanned.
test("yesterday is not closable until the grace after Bahrain midnight has passed", () => {
  const midnightBahrain = Date.parse("2026-10-28T21:00:00.000Z"); // 2026-10-29 00:00 Asia/Bahrain
  assert.equal(latestClosableBusinessDate(midnightBahrain - 1), "2026-10-27");
  assert.equal(latestClosableBusinessDate(midnightBahrain), "2026-10-27");
  assert.equal(latestClosableBusinessDate(midnightBahrain + 2 * 60 * 1000 - 1), "2026-10-27");
  assert.equal(latestClosableBusinessDate(midnightBahrain + 2 * 60 * 1000), "2026-10-28");
});

test("the Bahrain date, not the UTC date, decides", () => {
  // 22:00Z on the 28th is 01:00 on the 29th in Bahrain: the 28th is over.
  assert.equal(latestClosableBusinessDate(Date.parse("2026-10-28T22:00:00.000Z")), "2026-10-28");
  assert.equal(latestClosableBusinessDate(Date.parse("2026-10-29T10:00:00.000Z")), "2026-10-28");
});
