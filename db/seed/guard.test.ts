/**
 * The seed must not wipe a database that already holds data unless
 * SEED_RESET=1 is set. Requires DATABASE_URL pointing at a migrated
 * Postgres; skipped otherwise.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { checkSeedTarget } from "./guard.js";

const databaseUrl = process.env.DATABASE_URL;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 2 }) : null;

after(async () => {
  await pool?.end();
});

test("seed CLI leaves a populated database alone without SEED_RESET=1", { skip: !pool, timeout: 180_000 }, async () => {
  const sentinel = await pool!.query<{ id: string }>(
    `INSERT INTO merchants (display_name) VALUES ('Live merchant (seed guard test)') RETURNING id`,
  );
  const id = sentinel.rows[0]!.id;
  try {
    const before = await pool!.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM merchants`);
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: databaseUrl };
    delete env.SEED_RESET;
    const run = spawnSync(process.execPath, ["--import", "tsx", "db/seed/index.ts"], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /seed: skipped/);

    const kept = await pool!.query(`SELECT 1 FROM merchants WHERE id = $1`, [id]);
    assert.equal(kept.rowCount, 1, "the seed truncated an existing merchant");
    const afterCount = await pool!.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM merchants`);
    assert.equal(afterCount.rows[0]!.n, before.rows[0]!.n);
  } finally {
    await pool!.query(`DELETE FROM merchants WHERE id = $1`, [id]);
  }
});

test("checkSeedTarget: populated needs SEED_RESET=1, empty is allowed", { skip: !pool }, async () => {
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO merchants (display_name) VALUES ('Live merchant (seed guard test)')`);
    assert.deepEqual(await checkSeedTarget(client, {}), { allowed: false, populated: true });
    assert.deepEqual(await checkSeedTarget(client, { SEED_RESET: "true" }), { allowed: false, populated: true });
    assert.deepEqual(await checkSeedTarget(client, { SEED_RESET: "1" }), { allowed: true, populated: true });

    await client.query(`TRUNCATE merchants, ledger_entries, admin_users CASCADE`);
    assert.deepEqual(await checkSeedTarget(client, {}), { allowed: true, populated: false });
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
