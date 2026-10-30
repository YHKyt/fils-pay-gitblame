/**
 * The admin merchant list's `q` was spliced into `display_name ILIKE '%' ||
 * q || '%'` as a pattern, so `%` and `_` in it were wildcards: `q=%`
 * listed every merchant, `q=_` matched any one character, and a crafted
 * `%a%a%a…` pattern made the matcher backtrack over every name. The
 * transaction search already treats them as literal characters (query.ts);
 * this does the same. Real Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { listMerchantsForAdmin } from "./merchants.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("merchantsSearch.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 2 });

test.after(async () => {
  await pool.end();
});

async function merchant(name: string): Promise<void> {
  await pool.query(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250)`, [name]);
}

test("% and _ in the admin merchant search are literal characters, not wildcards", async () => {
  const tag = randomUUID().slice(0, 8);
  await merchant(`Search ${tag} 100% Cotton`);
  await merchant(`Search ${tag} Plain Shop`);
  await merchant(`Search ${tag} a_b Traders`);
  await merchant(`Search ${tag} axb Traders`);

  const pct = await listMerchantsForAdmin(pool, { q: "%", limit: 100 });
  assert.ok(pct.merchants.length > 0);
  for (const m of pct.merchants) {
    assert.ok(m.displayName.includes("%"), `q=% matched "${m.displayName}"`);
  }

  const under = await listMerchantsForAdmin(pool, { q: `${tag} a_b`, limit: 100 });
  assert.deepEqual(
    under.merchants.map((m) => m.displayName),
    [`Search ${tag} a_b Traders`],
  );

  // Backslash is the LIKE escape character: a literal one must still match.
  await merchant(`Search ${tag} back\\slash`);
  const back = await listMerchantsForAdmin(pool, { q: `${tag} back\\slash`, limit: 100 });
  assert.equal(back.merchants.length, 1);
});
