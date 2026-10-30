// Drop and recreate one database, so a run never sees another run's rows.
// usage: node freshdb.cjs <repoDir> [dbName=filspay]
// Needs the local server from start-postgres.mjs (superuser postgres/postgres).
const { Client } = require(require("path").join(process.argv[2], "node_modules", "pg"));
const name = process.argv[3] || "filspay";
if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error("bad database name: " + name);
(async () => {
  const c = new Client({ connectionString: "postgres://postgres:postgres@127.0.0.1:5432/postgres" });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${name} OWNER filspay ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`);
  await c.end();
  console.log("fresh database " + name);
})().catch((e) => { console.error(e.message); process.exit(1); });
