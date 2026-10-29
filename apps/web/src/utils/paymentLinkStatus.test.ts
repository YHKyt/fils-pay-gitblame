import assert from "node:assert/strict";
import test from "node:test";
import { canCancelPaymentLink, paymentLinkDisplayStatus } from "./paymentLinkStatus.js";

const NOW = new Date("2026-10-29T09:00:00.000Z");

test("an active link past its expiry is shown as expired and cannot be canceled", () => {
  const link = { status: "active" as const, expiresAt: "2026-10-29T08:59:59.999Z" };
  assert.equal(paymentLinkDisplayStatus(link, NOW), "expired");
  assert.equal(canCancelPaymentLink(link, NOW), false);
});

test("expiry is inclusive: expires_at == now is expired (same <= as the API)", () => {
  const link = { status: "active" as const, expiresAt: NOW.toISOString() };
  assert.equal(paymentLinkDisplayStatus(link, NOW), "expired");
});

test("an active link before its expiry stays active and can be canceled", () => {
  const link = { status: "active" as const, expiresAt: "2026-10-29T09:00:00.001Z" };
  assert.equal(paymentLinkDisplayStatus(link, NOW), "active");
  assert.equal(canCancelPaymentLink(link, NOW), true);
});

test("terminal and reserved statuses are shown as stored", () => {
  const past = "2026-01-01T00:00:00.000Z";
  assert.equal(paymentLinkDisplayStatus({ status: "paid", expiresAt: past }, NOW), "paid");
  assert.equal(paymentLinkDisplayStatus({ status: "canceled", expiresAt: past }, NOW), "canceled");
  assert.equal(paymentLinkDisplayStatus({ status: "reserved", expiresAt: past }, NOW), "reserved");
  assert.equal(canCancelPaymentLink({ status: "paid", expiresAt: past }, NOW), false);
});
