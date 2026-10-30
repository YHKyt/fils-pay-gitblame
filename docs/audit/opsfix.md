# Hosting and operations findings (ops/, seed entry point)

Every finding below was reproduced by booting `ops/docker-compose.yml` on a
clean Docker host (project `filspay-opsfix`) or by a test, and verified
fixed the same way. Final check: `docker compose down -v`, then `up -d
--build` on an empty volume, then `node ops/e2e/judge-suite.mjs` through
the web origin (`BASE_URL=WEB_URL=http://127.0.0.1:<web port>`,
`ADMIN_URL=.../admin`): 91 passed, 0 failed, 0 skipped.

## O1. A redeploy wipes live data: the seed job truncates on every `up` — High

**Where:** `ops/docker-compose.yml` (`seed` service), `db/seed/index.ts`, `db/seed/generate.ts` (`TRUNCATE ... CASCADE`).
**Evidence:** `db/seed/guard.test.ts`, test 1. On the old `index.ts` the CLI reseeded a populated database and the pre-existing merchant row was gone (`The input did not match the regular expression /seed: skipped/`); with the fix it passes. Live compose check: a second `up --force-recreate` printed `seed: skipped: ...` and the payment-link and refund counts from the first run were unchanged (4 and 7 before and after).

- **What:** the compose file runs `npm run seed` on every `up`, and the header says the hosted box runs this same file. The seed TRUNCATEs merchants, ledger_entries, admin_users and others with CASCADE, which also empties every table that references them (sessions, API keys, refunds, webhook endpoints, payment links). Comments in compose, `generate.ts` and the RUNBOOK claimed it "only truncates its own fixture tables" and is "safe against a shared staging database". That is false.
- **Why:** there was no check of what the target database already holds, and no environment guard.
- **Breaks:** every redeploy of the hosted app deletes every real merchant, the whole ledger and every admin account, and replaces them with demo data. The RUNBOOK note that "staging-2 got reset this way" is this bug.
- **Fix:** `db/seed/guard.ts` checks whether merchants, ledger_entries or admin_users have any row. If so, the CLI prints `seed: skipped` and exits 0, unless `SEED_RESET=1`. An empty database (first boot) is still seeded, so the judges' tests have demo merchants. The guard sits in the CLI, not in `generate()`, because the self-verify step deliberately re-runs `generate()` to prove determinism. Exit 0 on skip keeps compose's dependency chain (api waits for seed) working on a redeploy. False comments corrected.
- **Test:** `db/seed/guard.test.ts`: (1) runs the real CLI against a populated database and checks a pre-existing merchant survives; (2) `checkSeedTarget` decisions for populated, populated with `SEED_RESET=1`, `SEED_RESET=true` (refused: only `1` counts) and empty.

## O2. A fresh `docker compose up` cannot boot the stack — High

**Where:** `ops/Dockerfile.node`, `ops/docker-compose.yml`.
**Evidence:** clean build and boot of the original files (reproduced first by the e2e worker, re-checked here).

- **What and why, one blocker at a time:**
  1. `FROM node:20-slim`: argon2 0.45.1's prebuilt binary segfaults (exit 139) on node 20 during `npm ci`, the fallback to node-gyp fails because the slim image has no python, and the image does not build. Fixed with `node:22-slim`.
  2. The `seed` job had no secrets. The image sets `NODE_ENV=production` and the seed loads the api config, which then refuses to load (`SETTLEMENT_INTERNAL_TOKEN is required when NODE_ENV=production`). Fixed by giving `seed` the same required secrets as the api.
  3. api, settlement and reporting depended only on Postgres being healthy, so on a first boot they raced the migrations. They now wait for `migrate` to complete, and the api also waits for `seed`.
  4. KYC uploads go to `./data/kyc` under `/app`, which is owned by root while the service runs as `node`, so the first upload failed. The directory is now created with `node` ownership and mounted as the `filspay_kyc` volume (verified writable in the running container).
- **Breaks:** the app as handed over cannot be hosted.
- **Fix:** the four changes above. Smallest change each: one base image tag, three env lines, `depends_on` conditions, one `RUN mkdir/chown` and a volume.
- **Test:** clean boot: migrate exits 0, seed exits 0 (`all REAL assertions passed`), api, web, settlement daemon (`RunDailyBatch(...) processed`) and reporting worker all up. Judge suite 91/91.

## O3. The dashboard and admin console cannot log in when hosted (no CORS, wrong base URL) — High

**Where:** `ops/docker-compose.yml`, `ops/Dockerfile.web`, `ops/nginx.web.conf`, `apps/admin/src/api/client.ts`, `apps/admin/src/router.tsx`, `apps/admin/vite.config.ts`.
**Evidence:** apps/api registers no CORS plugin, so a cross-origin JSON call fails at the preflight (`OPTIONS /v1/...` -> 404). The admin client defaulted to `http://localhost:3000`. After the fix, a real browser logged in through `http://localhost:<web port>/admin/login` (password + OTP) and reached `/admin/merchants`, and through `/dashboard/login` to `/dashboard/transactions`.

- **What:** the webflows fix (already merged) serves apps/web behind nginx with `/v1` proxied on the same origin. The admin console was still not hosted, and if it had been, every call would have gone cross-origin.
- **Why:** there is no CORS handling (by design: adding credentialed CORS would widen the attack surface), so the front ends must share the API's origin.
- **Breaks:** no one can use the admin console on the hosted box (KYC review, settlement runs, credits).
- **Fix:** the same web image also builds apps/admin with `--base=/admin/` and a relative API base URL; nginx serves it at `/admin/` with its own SPA fallback. The router takes its basename from the build base, so dev is unchanged. The console's "view as merchant" link points at `/dashboard` on the same origin. In dev, the console now proxies `/v1` through Vite, as apps/web already does. One proxy, not a second one.
- **Test:** judge suite "web + admin bundles" section (admin page and every asset 200); manual browser login on both apps.

## O4. Behind the proxy every session records nginx's address — Low

**Where:** `apps/api/src/app.ts` (`Fastify({ logger: true })`), `apps/api/src/config.ts`.
**Evidence:** `apps/api/src/trustProxy.test.ts`. Old code: `expected: '203.0.113.7'`, `actual: '172.18.0.5'`. Fixed: 3/3 pass. In the running stack, new sessions record the client address seen by nginx instead of the nginx container's address.

- **What:** `sessions.ip_address` and `admin_sessions.ip_address` come from `request.ip`, which without `trustProxy` is the socket peer, i.e. nginx.
- **Why:** Fastify ignores `X-Forwarded-For` unless told which peers to trust.
- **Breaks:** the login audit trail is useless for investigations (every login from the same internal IP).
- **Fix:** a `TRUST_PROXY` setting passed to Fastify's `trustProxy`; unset means trust nobody (unchanged default). Compose sets `loopback,linklocal,uniquelocal`, and binds the api's direct port to 127.0.0.1, so only the compose network (nginx) can supply the header; a remote client cannot forge its address. Never `true`.
- **Test:** `trustProxy.test.ts`: trusted private peer -> forwarded address; public peer with a forged header -> its own address; unset -> header ignored.

## O5. Committed database password and one all-powerful role — Low

**Where:** `ops/docker-compose.yml` (`filspay_dev_password` in six places), `ops/README.md`.

- **What:** the Postgres password was hard-coded in the tracked compose file, which the hosted box runs. Every service connects as the same owner role.
- **Breaks:** anyone with the repository knows the hosted database password; any compromised service has DDL rights on every table.
- **Fix:** the password is now `${POSTGRES_PASSWORD:?}` from the gitignored `ops/.env` (one YAML anchor builds `DATABASE_URL` for every service); compose refuses to start without it. `.env.example` lists it. The single role is documented as a known limitation with the follow-up (per-service roles need a migration with grants), not changed here: it is a larger change than this finding warrants.
- **Test:** `docker compose config` without `POSTGRES_PASSWORD` fails with `set in ops/.env`; the stack boots with it.

## O6. Judge tests flake: the simulator declines 2% of good cards at random — Low

**Where:** `apps/api/src/config.ts` (`ACQUIRER_FAILURE_RATE`, default 0.02), `ops/docker-compose.yml`.

- **What / Breaks:** on the hosted stack, roughly one approved-card payment in fifty fails with a random decline, so an automated test of the checkout fails intermittently.
- **Fix:** compose sets `ACQUIRER_FAILURE_RATE=${ACQUIRER_FAILURE_RATE:-0}`; documented in `ops/README.md`. The code default is unchanged.

## O7. The OTP cannot be obtained on the hosted box — open decision

**Where:** `apps/api/src/config.ts` (`otpDevExpose`), `apps/api/src/routes/auth.ts`, `adminAuth.ts`.

- **What:** login is password + OTP, there is no delivery channel in this codebase, and in production the code is neither returned nor logged. Nobody can complete a browser login on the hosted box.
- **Decision left to the team** (documented in `ops/README.md`, "Logging in"): `OTP_DEV_EXPOSE=true` on a demo/judging box only (removes the second factor), operator re-keys the pending challenge from the database, or build a delivery channel. Compose passes `OTP_DEV_EXPOSE=${OTP_DEV_EXPOSE:-false}`; it is not silently enabled.

## O8. Wrong operational docs — Low

**Where:** `docs/RUNBOOK.md`, `ops/README.md`, `apps/web/src/api/client.ts`.

- `SHARP_CACHE=0` is read by nothing (grep of the repository). Thumbnails are generated once at upload, so paging through them does not run sharp. The RUNBOOK now says so.
- The RUNBOOK and README said re-running the seed is a safe reset on a shared database (see O1); corrected, with `SEED_RESET=1`.
- The web client comment "CORS is locked to the two origins in config" was false: the api has no CORS handling and no origins in config. Replaced with the real constraint.
- `ops/README.md` now documents the one-origin layout, HTTPS and `COOKIE_SECURE` (Secure cookies are dropped over plain http on a non-localhost host, so the hosted box needs TLS in front of port 8080), image sizes and memory caps measured on the running stack.

## Noted, not changed

- The seed prints every demo merchant's live-format API key (`fp_live_...`) to stdout, which lands in `docker logs` on the hosted box. Acceptable for demo data; never run the seed against real data (O1 now prevents that by default).
