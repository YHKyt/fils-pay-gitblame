import assert from "node:assert/strict";
import { test } from "node:test";
import type { DashboardMe } from "../types.js";
import { isRoleAllowed } from "./roleGate.js";

const merchant = { id: "m1", displayName: "Shop", onboardingStatus: "approved" };

const owner: DashboardMe = { merchantUserId: "u1", email: "o@x.test", role: "owner", merchant };
const support: DashboardMe = { ...owner, role: "support" };
const impersonating = (role: DashboardMe["role"]): DashboardMe => ({
  merchantUserId: null,
  email: null,
  role,
  merchant,
  impersonation: { grantId: "g1", expiresAt: "2026-10-29T12:00:00.000Z", readOnly: true },
});

test("a merchant user sees controls their role allows", () => {
  assert.equal(isRoleAllowed(owner, ["owner", "finance"]), true);
  assert.equal(isRoleAllowed(support, ["owner", "finance"]), false);
});

test("an unresolved me shows the control (the server decides)", () => {
  assert.equal(isRoleAllowed(null, ["owner"]), true);
});

test("a read-only impersonation session never sees write controls, whatever its role", () => {
  assert.equal(isRoleAllowed(impersonating("support"), ["owner", "finance"]), false);
  assert.equal(isRoleAllowed(impersonating("owner"), ["owner", "finance"]), false);
  assert.equal(isRoleAllowed(impersonating("support"), ["support"]), false);
});
