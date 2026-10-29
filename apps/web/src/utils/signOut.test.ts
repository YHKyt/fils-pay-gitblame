import assert from "node:assert/strict";
import { test } from "node:test";
import { signOutLocallyRegardless } from "./signOut.js";

test("clears local state after a successful server logout", async () => {
  let cleared = false;
  const failure = await signOutLocallyRegardless(async () => {}, () => {
    cleared = true;
  });
  assert.equal(cleared, true);
  assert.equal(failure, null);
});

test("still clears local state, and does not throw, when the server logout fails", async () => {
  let cleared = false;
  const boom = new Error("network down");
  const failure = await signOutLocallyRegardless(
    async () => {
      throw boom;
    },
    () => {
      cleared = true;
    },
  );
  assert.equal(cleared, true);
  assert.equal(failure, boom);
});
