import assert from "node:assert/strict";
import { test } from "node:test";
import { safeReturnPath } from "./safeReturnPath.js";

const FALLBACK = "/dashboard/overview";

test("rejects anything that can leave this origin", () => {
  for (const bad of [
    "//evil.example",
    "//evil.example/dashboard/transactions",
    "/\\evil.example",
    "/\\/evil.example",
    "\\\\evil.example",
    "https://evil.example/dashboard/transactions",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "/\t/evil.example",
    "/\n/evil.example",
    " /dashboard/transactions",
    "dashboard/transactions",
    "",
    null,
    undefined,
    42,
    { pathname: "/x" },
  ]) {
    assert.equal(safeReturnPath(bad, FALLBACK), FALLBACK, String(bad));
  }
});

test("keeps same-origin in-app paths with query and hash", () => {
  assert.equal(safeReturnPath("/dashboard/transactions?status=captured#top", FALLBACK), "/dashboard/transactions?status=captured#top");
  assert.equal(safeReturnPath("/dashboard/webhooks/abc", FALLBACK), "/dashboard/webhooks/abc");
});

test("refuses paths outside the dashboard area", () => {
  assert.equal(safeReturnPath("/login", FALLBACK), FALLBACK);
  assert.equal(safeReturnPath("/pay/tok123", FALLBACK), FALLBACK);
  assert.equal(safeReturnPath("/dashboardevil", FALLBACK), FALLBACK);
  assert.equal(safeReturnPath("/dashboard/../login", FALLBACK), FALLBACK);
});
