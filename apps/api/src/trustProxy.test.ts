/**
 * Behind the compose nginx, request.ip (recorded on every session) must be
 * the browser's address from X-Forwarded-For, but only when the peer is a
 * trusted proxy. No database needed: the pool is never queried.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const baseEnv = {
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
};

async function ipSeen(env: NodeJS.ProcessEnv, remoteAddress: string): Promise<string> {
  const pool = new Pool({ connectionString: baseEnv.DATABASE_URL });
  const app = buildApp(loadConfig(env), pool);
  app.get("/__test/ip", async (request) => ({ ip: request.ip }));
  try {
    const res = await app.inject({
      method: "GET",
      url: "/__test/ip",
      remoteAddress,
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    return (res.json() as { ip: string }).ip;
  } finally {
    await app.close();
    await pool.end();
  }
}

const COMPOSE_TRUST = "loopback,linklocal,uniquelocal";

test("TRUST_PROXY: a request through nginx on the compose network records the browser's address", async () => {
  assert.equal(await ipSeen({ ...baseEnv, TRUST_PROXY: COMPOSE_TRUST }, "172.18.0.5"), "203.0.113.7");
});

test("TRUST_PROXY: a public peer cannot forge its address with X-Forwarded-For", async () => {
  assert.equal(await ipSeen({ ...baseEnv, TRUST_PROXY: COMPOSE_TRUST }, "198.51.100.9"), "198.51.100.9");
});

test("TRUST_PROXY unset: X-Forwarded-For is ignored", async () => {
  assert.equal(await ipSeen(baseEnv, "172.18.0.5"), "172.18.0.5");
});
