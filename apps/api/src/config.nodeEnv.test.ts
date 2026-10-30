/**
 * h2 lane report: an unrecognised NODE_ENV ("Production", "prod") was read
 * as development, and NODE_ENV unset turned on otpDevExpose, so the login
 * response carried the OTP. Now an unknown value refuses to boot and the
 * OTP is only exposed by default when NODE_ENV says development or test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.js";

const base = {
  DATABASE_URL: "postgres://unused",
  SETTLEMENT_INTERNAL_TOKEN: "t",
  ACQUIRER_CALLBACK_SIGNING_SECRET: "s",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
};

test("an unknown NODE_ENV refuses to boot instead of running as development", () => {
  for (const NODE_ENV of ["Production", "prod", "PRODUCTION", "staging"]) {
    assert.throws(() => loadConfig({ ...base, NODE_ENV }), /NODE_ENV/, NODE_ENV);
  }
});

test("NODE_ENV unset does not expose the OTP unless asked", () => {
  assert.equal(loadConfig({ ...base }).otpDevExpose, false);
  assert.equal(loadConfig({ ...base, OTP_DEV_EXPOSE: "true" }).otpDevExpose, true);
  assert.equal(loadConfig({ ...base, NODE_ENV: "development" }).otpDevExpose, true);
  assert.equal(loadConfig({ ...base, NODE_ENV: "test" }).otpDevExpose, true);
  assert.equal(loadConfig({ ...base, NODE_ENV: "production" }).otpDevExpose, false);
});

test("the OTP notifier logs the code only when otpDevExpose is on", async () => {
  const { sendOtpCode } = await import("./auth/notifier.js");
  const lines: Record<string, unknown>[] = [];
  const logger = { info: (obj: Record<string, unknown>) => lines.push(obj) };
  const recipient = { merchantUserId: "u1", email: "e@x" };
  sendOtpCode(logger, loadConfig({ ...base }), recipient, "123456");
  sendOtpCode(logger, loadConfig({ ...base, NODE_ENV: "development" }), recipient, "654321");
  assert.equal(lines[0]!.code, undefined, "NODE_ENV unset logged the OTP");
  assert.equal(lines[1]!.code, "654321");
});
