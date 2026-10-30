import assert from "node:assert/strict";
import { test } from "node:test";
import { safeReturnPath } from "./safeReturnPath.js";

const FALLBACK = "/merchants";

test("rejects anything that can leave this origin", () => {
  for (const bad of [
    "//evil.example",
    "//evil.example/merchants",
    "/\\evil.example",
    "/\\/evil.example",
    "\\\\evil.example",
    "https://evil.example/merchants",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "/\t/evil.example",
    "/\n/evil.example",
    " /merchants",
    "merchants",
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
  assert.equal(safeReturnPath("/merchants?q=acme#list", FALLBACK), "/merchants?q=acme#list");
  assert.equal(safeReturnPath("/settlement", FALLBACK), "/settlement");
});

test("never returns to the login page itself", () => {
  assert.equal(safeReturnPath("/login", FALLBACK), FALLBACK);
  assert.equal(safeReturnPath("/merchants/../login", FALLBACK), FALLBACK);
});
