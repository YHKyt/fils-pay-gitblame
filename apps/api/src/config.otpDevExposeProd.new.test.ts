/**
 * SEC: OTP_DEV_EXPOSE is a dev-only convenience that returns the OTP in the
 * login response (routes/auth.ts). It must never take effect in production,
 * even if an operator (or a leaked/templated env) sets OTP_DEV_EXPOSE=true on
 * a prod box — that would turn the login endpoint into one that leaks the
 * second factor to anyone who can POST /v1/auth/login. loadConfig now forces
 * otpDevExpose=false whenever NODE_ENV=production, regardless of the env var,
 * matching the posture acquirerCallbackRequireSignature already has.
 *
 * Before the fix the first assertion failed (prod + OTP_DEV_EXPOSE=true
 * yielded otpDevExpose=true).
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

test("production never exposes the OTP even when OTP_DEV_EXPOSE is explicitly set", () => {
  assert.equal(
    loadConfig({ ...base, NODE_ENV: "production", OTP_DEV_EXPOSE: "true" }).otpDevExpose,
    false,
    "a prod box with OTP_DEV_EXPOSE=true must still not return the OTP",
  );
  assert.equal(loadConfig({ ...base, NODE_ENV: "production", OTP_DEV_EXPOSE: "1" }).otpDevExpose, false);
  // The dev/test convenience is unchanged: the flag still works off production.
  assert.equal(loadConfig({ ...base, NODE_ENV: "development", OTP_DEV_EXPOSE: "true" }).otpDevExpose, true);
  assert.equal(loadConfig({ ...base, NODE_ENV: "test" }).otpDevExpose, true);
});
