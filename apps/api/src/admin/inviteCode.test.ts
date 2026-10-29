import assert from "node:assert/strict";
import { test } from "node:test";
import { generateInviteCode } from "./inviteCode.js";

test("admin invite codes come from a CSPRNG, never Math.random", () => {
  const original = Math.random;
  Math.random = () => {
    throw new Error("Math.random must not be used for admin invite codes");
  };
  try {
    const code = generateInviteCode();
    assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  } finally {
    Math.random = original;
  }
});
