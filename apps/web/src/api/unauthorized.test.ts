import assert from "node:assert/strict";
import { test } from "node:test";
import { request, signalsExpiredSession, UNAUTHORIZED_EVENT } from "./client.js";

// A 401 from a data route means the merchant session ended mid-use; a 401
// from the sign-in flow (or the anonymous /me probe) is normal and must not
// bounce the login screen.

test("a 401 from a data route signals an expired session", () => {
  assert.equal(signalsExpiredSession(401, "/v1/transactions?limit=20"), true);
  assert.equal(signalsExpiredSession(401, "/v1/merchants/abc/payment-links"), true);
});

test("auth routes never signal an expired session", () => {
  for (const path of [
    "/v1/auth/login",
    "/v1/auth/otp/verify",
    "/v1/auth/otp/resend",
    "/v1/auth/me",
    "/v1/auth/logout",
  ]) {
    assert.equal(signalsExpiredSession(401, path), false, path);
  }
});

test("other failures never signal an expired session", () => {
  assert.equal(signalsExpiredSession(403, "/v1/transactions"), false);
  assert.equal(signalsExpiredSession(500, "/v1/transactions"), false);
});

async function eventsFor(path: string, status: number): Promise<number> {
  const target = new EventTarget();
  let fired = 0;
  target.addEventListener(UNAUTHORIZED_EVENT, () => {
    fired += 1;
  });
  const g = globalThis as unknown as { window?: unknown; fetch: typeof fetch };
  const realWindow = g.window;
  const realFetch = g.fetch;
  g.window = target;
  g.fetch = (async () =>
    new Response(JSON.stringify({ error: "unauthenticated" }), { status })) as typeof fetch;
  try {
    await request(path).catch(() => undefined);
  } finally {
    g.fetch = realFetch;
    g.window = realWindow;
  }
  return fired;
}

test("request() dispatches the event on a data-route 401 only", async () => {
  assert.equal(await eventsFor("/v1/settlement/batches", 401), 1);
  assert.equal(await eventsFor("/v1/auth/me", 401), 0);
  assert.equal(await eventsFor("/v1/settlement/batches", 403), 0);
});
