// Local PostgreSQL 17 for tests, without Docker or admin rights.
// Setup (once, in an empty directory outside the repo): npm i embedded-postgres@17.5.0-beta.15
// Run:   node start-postgres.mjs [dataDir]   (keep it running; Ctrl+C stops it)
import EmbeddedPostgres from "embedded-postgres";
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] ?? "./pgdata");
const pg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port: 5432, persistent: true });
if (!fs.existsSync(dir)) await pg.initialise();
await pg.start();
const c = pg.getPgClient();
await c.connect();
// The role the repo's dev config and tests expect.
await c.query(
  "DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='filspay') THEN CREATE ROLE filspay LOGIN SUPERUSER PASSWORD 'filspay_dev_password'; END IF; END$$",
);
await c.end();
console.log("postgres up on 127.0.0.1:5432, data in " + dir);
process.on("SIGINT", async () => { await pg.stop(); process.exit(0); });
setInterval(() => {}, 1 << 30);
