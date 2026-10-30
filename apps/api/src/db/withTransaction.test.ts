/**
 * withTransaction: when the work fails and the ROLLBACK then fails too (the
 * connection died), the caller must see the error that caused the rollback,
 * not "Client ... is not queryable", and the broken client must be released
 * with an error so pg destroys it instead of reusing it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "./withTransaction.js";

function fakePool() {
  const released: unknown[] = [];
  const client = {
    async query(sql: string) {
      if (sql === "ROLLBACK") {
        throw new Error("Client has encountered a connection error and is not queryable");
      }
      return { rows: [] };
    },
    release(err?: unknown) {
      released.push(err);
    },
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, released };
}

test("a failed ROLLBACK does not hide the original error", async () => {
  const { pool, released } = fakePool();
  const original = new Error("duplicate key value violates unique constraint");
  const origConsoleError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      withTransaction(pool, async (_client: PoolClient) => {
        throw original;
      }),
      (err) => err === original,
    );
  } finally {
    console.error = origConsoleError;
  }
  assert.equal(released.length, 1);
  assert.ok(released[0] instanceof Error, "broken client must be released with an error so pg destroys it");
});

test("a normal failure still rolls back and releases the client for reuse", async () => {
  const released: unknown[] = [];
  const sqls: string[] = [];
  const client = {
    async query(sql: string) {
      sqls.push(sql);
      return { rows: [] };
    },
    release(err?: unknown) {
      released.push(err);
    },
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const original = new Error("boom");
  await assert.rejects(
    withTransaction(pool, async () => {
      throw original;
    }),
    (err) => err === original,
  );
  assert.deepEqual(sqls, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(released, [undefined]);
});
