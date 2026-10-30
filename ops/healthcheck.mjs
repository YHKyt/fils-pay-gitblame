// Container healthcheck for the Node services (ops/docker-compose.yml).
//
//   node ops/healthcheck.mjs api        GET /healthz answers within 4 s
//   node ops/healthcheck.mjs reporting  the database answers SELECT 1
//
// Docker marks a container unhealthy but never restarts it for that, and
// `restart: unless-stopped` only acts when the process exits. A crashed api
// exits and is restarted; a hung one (event loop stuck, socket backlog full)
// would stay up and unanswering forever. So for the api, after three failed
// checks in a row, this script kills the server process; it then exits,
// and the restart policy brings up a fresh one.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";

const service = process.argv[2];
const FAILS_BEFORE_KILL = 3;
const stateFile = `/tmp/healthcheck-${service}`;
const entrypoints = { api: "apps/api/src/index.ts", reporting: "apps/reporting/src/index.ts" };

async function probe() {
  if (service === "api") {
    const res = await fetch("http://127.0.0.1:3000/healthz", { signal: AbortSignal.timeout(4_000) });
    return res.ok;
  }
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 4_000 });
  await client.connect();
  try {
    await client.query("SELECT 1");
  } finally {
    await client.end();
  }
  return true;
}

function readFails() {
  try {
    return Number(readFileSync(stateFile, "utf8")) || 0;
  } catch {
    return 0;
  }
}

function killServer() {
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    if (Number(pid) === process.pid) continue;
    let cmdline = "";
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue;
    }
    // The node process running the entrypoint (not npx, which then exits).
    if (cmdline.includes(entrypoints[service]) && !cmdline.includes("npm")) {
      try {
        process.kill(Number(pid), "SIGKILL");
        console.log(`healthcheck: killed hung ${service} process ${pid}`);
      } catch {
        // already gone
      }
    }
  }
}

let ok = false;
try {
  ok = await probe();
} catch {
  ok = false;
}
if (ok) {
  writeFileSync(stateFile, "0");
  process.exit(0);
}
const fails = readFails() + 1;
if (service === "api" && fails >= FAILS_BEFORE_KILL) {
  killServer();
  writeFileSync(stateFile, "0");
} else {
  writeFileSync(stateFile, String(fails));
}
process.exit(1);
