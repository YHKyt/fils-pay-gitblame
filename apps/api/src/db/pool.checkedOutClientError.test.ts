import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../config.js";
import { createPool } from "./pool.js";

// The pool-level 'error' listener (pool.test.ts) only covers IDLE clients:
// pg-pool detaches its listener while a client is checked out. A checked-out
// client whose connection dies between two statements (Postgres restarted,
// the backend terminated) emits 'error' on the client itself; with no
// listener that is an uncaught exception and the whole api process exits.
// Reproduced on the compose stack: an immediate Postgres restart under
// checkout load killed the api ("Unhandled 'error' event ... Connection
// terminated unexpectedly") on top of the outage.
const databaseUrl = process.env.DATABASE_URL;

test(
  "a checked-out client whose connection dies does not crash the process",
  { skip: databaseUrl ? false : "DATABASE_URL not set" },
  async () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl!,
      NODE_ENV: "test",
      WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
      PG_POOL_MAX: "2",
    });
    const pool = createPool(config);
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown): void => {
      uncaught.push(err);
    };
    process.on("uncaughtException", onUncaught);
    try {
      const client = await pool.connect();
      await client.query("BEGIN");
      const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      // Kill the checked-out client's backend from a second connection, while
      // the client sits between statements (as during an awaited call).
      await pool.query("SELECT pg_terminate_backend($1)", [rows[0]!.pid]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      client.release(true);

      assert.deepEqual(uncaught.map(String), []);
      // The pool replaces the dead connection and keeps working.
      const ok = await pool.query<{ one: number }>("SELECT 1 AS one");
      assert.equal(ok.rows[0]!.one, 1);
    } finally {
      process.off("uncaughtException", onUncaught);
      await pool.end();
    }
  },
);
