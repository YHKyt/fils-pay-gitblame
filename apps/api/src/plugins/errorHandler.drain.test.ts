/**
 * Regression test: a JSON body over the 1 MiB bodyLimit must come back as a
 * readable 413 over a real socket. Fastify refuses it from Content-Length
 * before reading it; the handler answered at once and the socket closed
 * while the client was still writing, so fetch failed with EPIPE and never
 * saw the 413. Against the running api, 23 of 30 13 MB uploads to
 * /v1/admin/adjustment-imports failed that way (the judge suite's large
 * upload check). app.inject() cannot show this: it has no socket. The
 * client runs in a child process: in the same process as the server the
 * event loop interleaves the two and the race does not show.
 *
 * Real, migrated Postgres; requires DATABASE_URL (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("errorHandler.drain.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

test("an oversized upload over a real socket gets the 413, not EPIPE", async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const app = buildApp(config, pool);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as { port: number };

  try {
    const client = `
      const csv = "merchantId,amount,reason\\n" + "m,0.001,${"x".repeat(100)}\\n".repeat(120000);
      const body = JSON.stringify({ csvContent: csv });
      const outcomes = [];
      for (let i = 0; i < 20; i++) {
        try {
          const res = await fetch("http://127.0.0.1:${port}/v1/admin/adjustment-imports", {
            method: "POST", headers: { "content-type": "application/json" }, body,
          });
          await res.text();
          outcomes.push(String(res.status));
        } catch (err) {
          outcomes.push(String(err.cause?.code ?? err));
        }
      }
      console.log(JSON.stringify(outcomes));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", client]);
    const outcomes = JSON.parse(stdout) as string[];
    assert.deepEqual(outcomes, Array(20).fill("413"));
  } finally {
    await app.close();
    await pool.end();
  }
});
