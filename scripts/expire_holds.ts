#!/usr/bin/env -S npx tsx
/**
 * Nightly janitor: a hold that's never captured or released just sits in
 * the table past its expires_at forever — nothing else in the platform
 * ever deletes a holds row (authorize.ts inserts one, capture.ts/void.ts
 * release one; nothing sweeps one). Run once a night from cron/the host's
 * own scheduler.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx scripts/expire_holds.ts
 */
import { pathToFileURL } from "node:url";
import { Client, type Pool } from "pg";

/**
 * Flips holds that are still 'active' and past expires_at to 'expired' in
 * one statement, as the handover and migration 0005's status CHECK describe.
 * Holds are never deleted. It used to SELECT the expired ids and then DELETE
 * them: on a night with nothing expired the empty id list built
 * `DELETE FROM holds` with no WHERE and wiped every hold, and a hold
 * captured between the SELECT and the DELETE was deleted anyway.
 */
export async function expireHolds(db: Client | Pool): Promise<number> {
  const result = await db.query(`UPDATE holds SET status = 'expired' WHERE status = 'active' AND expires_at < now()`);
  return result.rowCount ?? 0;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("expire_holds: DATABASE_URL environment variable is not set");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const expired = await expireHolds(client);
    console.log(`expire_holds: marked ${expired} abandoned hold(s) expired`);
  } finally {
    await client.end();
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
