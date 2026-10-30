import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.js";

const base = { DATABASE_URL: "postgres://x/y" };

// Regression: Number.parseInt reads a leading integer and ignores the rest,
// so "15s" became a 15 ms poll (a busy loop against the database) and "1e3"
// became 1. A batch limit of 0 made every pass select LIMIT 0: the consumer
// ran forever, applied nothing, and the dashboards stopped updating with no
// error anywhere.
test("loadConfig refuses an interval or limit that is not a whole number", () => {
  for (const value of ["15s", "1e3", "15.5", "abc", " 15"]) {
    assert.throws(() => loadConfig({ ...base, REPORTING_POLL_INTERVAL_MS: value }), /REPORTING_POLL_INTERVAL_MS/, value);
    assert.throws(
      () => loadConfig({ ...base, REPORTING_CONSUMER_BATCH_LIMIT: value }),
      /REPORTING_CONSUMER_BATCH_LIMIT/,
      value,
    );
  }
});

test("loadConfig refuses a zero or negative interval, batch limit or pool size", () => {
  for (const value of ["0", "-1"]) {
    assert.throws(() => loadConfig({ ...base, REPORTING_POLL_INTERVAL_MS: value }), /REPORTING_POLL_INTERVAL_MS/);
    assert.throws(() => loadConfig({ ...base, REPORTING_CONSUMER_BATCH_LIMIT: value }), /REPORTING_CONSUMER_BATCH_LIMIT/);
    assert.throws(() => loadConfig({ ...base, PG_POOL_MAX: value }), /PG_POOL_MAX/);
  }
});

test("loadConfig keeps defaults and accepts plain positive integers", () => {
  assert.deepEqual(loadConfig(base), {
    databaseUrl: "postgres://x/y",
    pgPoolMax: 5,
    reportingPollIntervalMs: 15_000,
    consumerBatchLimit: 500,
  });
  const c = loadConfig({ ...base, REPORTING_POLL_INTERVAL_MS: "2000", REPORTING_CONSUMER_BATCH_LIMIT: "50", PG_POOL_MAX: "3" });
  assert.equal(c.reportingPollIntervalMs, 2000);
  assert.equal(c.consumerBatchLimit, 50);
  assert.equal(c.pgPoolMax, 3);
});
