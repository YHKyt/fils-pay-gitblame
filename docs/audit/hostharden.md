# Hosting hardening: public edge, box sizing, restart and recovery

The app is hosted publicly on one Dilmune server (1 vCPU, 2 GB RAM for the whole stack; the api held to 0.5 vCPU and 512 MB) from `ops/`. Judges run automated tests and load tests against it, and anyone can reach it. This round threat-modelled the anonymous surface, fixed what broke, sized the stack for the box, and measured capacity, overload and crash recovery on a stack run exactly as hosted. Branch `agent/hostharden`.

How it was run: `docker compose -p hh -f ops/docker-compose.yml -f ops/compose.box-sim.yml up -d --build` with its own ports and volumes. `compose.box-sim.yml` pins every service to one host CPU, so the whole stack shares one CPU as on the box, and the api is capped at 0.5 of it by the main compose file. All traffic went through the public nginx origin, from one client address (as a judge's load runner would). The judge suite ran with `DATABASE_URL` for OTP retrieval.

## Threat model of the anonymous surface

| Route | What an outsider could do | Protection before | Now |
|---|---|---|---|
| `POST /v1/auth/login`, `/v1/admin/auth/login` | brute-force passwords; burn CPU (argon2 hash for every attempt, even an unknown account); lock out a known account | per-account lockout after 10 wrong passwords (15 min) | + 5 r/s per address (burst 60), 16 logins in flight box-wide, 64 KiB body |
| `POST /v1/auth/otp/verify`, `/otp/resend` | guess the 6-digit code | 5 attempts per challenge, carried across resends; resend 30 s throttle; needs the password first | + the auth limits above |
| `POST /v1/merchants` (signup) | create junk merchants; argon2 per request | none | + the auth limits above |
| `POST /v1/payment-links/:token/pay` | flood checkout; junk transactions with declined cards | Idempotency-Key required; unknown token is a cheap 404 | + 100 r/s per address, 50 pays in flight box-wide, 64 KiB body |
| `GET /v1/payment-links/:token` | token guessing | long random token | + general API limits |
| `POST /v1/acquirer/callbacks` | forge callbacks | HMAC signature with timestamp | + general API limits |
| `/healthz`, `/readyz` | cheap request flood | none | + general API limits |
| any route | slowloris; giant bodies; many sockets | nginx defaults: 60 s header/body timeouts, 1024 connections per worker, 10 MiB bodies | 10 s header, 20 s body, 30 s send/keep-alive; 256 connections per address, 8192 per worker; 64 KiB on public routes |
| any route | exhaust the box | none | 500 r/s per address; 80 API requests in flight box-wide |

## HH1. A fresh `docker compose up` fails: the seed deadlocks with the reporting consumer — High

**Where:** `ops/docker-compose.yml` (`reporting` and `settlement` `depends_on`).

**Evidence:** three fresh `docker compose -p hh -f ops/docker-compose.yml up -d` runs on an empty volume, three failures: `service "seed" didn't complete successfully: exit 1`, seed log `error: deadlock detected` (40P01). Postgres: the seed's `TRUNCATE TABLE ledger_entries, ..., outbox_events, ... CASCADE` waits for AccessExclusiveLock while the reporting consumer's `SELECT ... FROM outbox_events WHERE (xact_id, id) > ...` holds AccessShareLock and waits on the seed. After the fix: two of two fresh runs come up and every service is healthy.

- **What:** `reporting` and `settlement` waited only for `migrate`, so they started together with `seed`.
- **Why:** the seed always truncates the tables it fills (even an empty database) and the consumer polls one of them as soon as it starts.
- **Breaks:** the first deploy of the hosted box. The seed exits 1 and the api, which waits for a successful seed, never starts: no API at all.
- **Fix:** both services also wait for `seed: service_completed_successfully`. Two lines each, compose only. A redeploy still works: the seed prints `seed: skipped` and exits 0.
- **Test:** the fresh `up` runs above (3/3 fail before, 2/2 pass after; every later fresh `up` in this round passed too).

## HH2. A lost connection on a checked-out pg client crashes the api — Medium

**Where:** `apps/api/src/db/pool.ts`.

**Evidence:** `apps/api/src/db/pool.checkedOutClientError.test.ts`. Before: `not ok 1`, `failureType: 'uncaughtException'`, `Error: Connection terminated unexpectedly`. After: `ok 1`, and the existing `pool.test.ts` still passes. On the compose stack, an immediate Postgres restart (`pg_ctl stop -m immediate`) under checkout load killed the api (`Unhandled 'error' event ... Emitted 'error' event on Client instance`, restart count 1 to 2). After the fix the same test leaves the api running (restart count unchanged) and it serves again 7 s after Postgres went down.

- **What:** the pool-level `error` listener only covers idle clients; pg-pool detaches it while a client is checked out. A checked-out client whose connection dies between two statements emits `error` on itself, with no listener.
- **Why:** an unhandled `error` event is an uncaught exception in Node, and the process exits.
- **Breaks:** a database blip (restart, failover) also took the API down and dropped every in-flight request, on top of the outage itself.
- **Fix:** every client gets an `error` listener (logs) when the pool creates it (`pool.on("connect", ...)`). The caller's next query on that client still fails and `withTransaction` releases it as broken. Five lines; no behaviour change while the database is up.
- **Test:** the new test checks out a client, opens a transaction, terminates its backend from a second connection, and asserts no uncaught exception and a working pool afterwards.

## HH3. No abuse limits at the public edge: a login flood answers 500, slow clients hold sockets for a minute — High

**Where:** `ops/nginx.web.conf`, `ops/nginx.main.conf` (new), `ops/Dockerfile.web`.

**Evidence:** the same probes (`ops/e2e/load/abuse-probes.mjs`, 100 loops for 15 s from one address; a separate client reads a payment link straight from the api every 250 ms) against the old config (`git show fix/money-parsing:ops/nginx.web.conf` in a second nginx on the same stack) and the new one:

| Probe | Old config | New config |
|---|---|---|
| login flood, unknown accounts | 36 req/s reach argon2; 460 x 401 and **84 x 500** (`Connection terminated due to connection timeout`, pool connections starved behind the argon2 queue) | 104 x 401 reach the api in 15 s, 43,977 x 429 answered by nginx in ~30 ms; 0 x 500 |
| admin login flood | 483 x 401, all at the api | 77 x 401, 47,548 x 429 |
| signup flood | 16,384 requests at the api | 76 at the api, 48,314 x 429 |
| pay flood, unknown links | 5,937 at the api; the other client's reads p95 281 ms | 1,477 at the api, 44,368 x 429; the other client's reads p95 49 ms |
| 1,000 slowloris sockets | 936 still held after 30 s (60 s default timeout); 64 refused (1024 connections per worker) | all 1,000 closed after a median 10.5 s; healthz answered meanwhile in 83 ms |
| 1 MB body on pay / login / signup | parsed by the api (404 / 400) | 413 JSON at nginx |

The judge suite before and after: 173 passed, 0 failed, 0 skipped, and nginx logged no 429 for it (the one 429 in its run is the api's own OTP `too_many_attempts`, which the suite expects).

- **What:** nginx proxied everything to the api with no request or connection limits and default timeouts.
- **Why:** every login, including one for a nonexistent account, runs an argon2 hash (about 19 MiB, tens of ms of CPU) on libuv's four-thread pool. A flood queues hashes there, and the SCRAM hashing of new Postgres connections waits behind them until the 5 s connect timeout fires: 500s on logins and anything else that needed a new connection.
- **Breaks:** one script could take the 0.5 vCPU api down for everyone (other teams, judges' tests), and a few thousand idle sockets could fill nginx.
- **Fix (ops only, no app code):**
  - Per client address: 500 r/s for all API traffic (burst 1000), 5 r/s for logins, OTP verify/resend and signup (burst 60), 100 r/s for checkout pay (burst 500), 256 open connections. `nodelay`: a spike within the burst passes at once, anything beyond gets 429 at once. A queue (`delay`) was measured first and only turned the excess into 6 s logins.
  - Whole box (one counter for everybody): 80 API requests in flight, 50 pays, 16 logins. Past them nginx answers 429 at once instead of letting the api queue grow.
  - Timeouts: header 10 s, body 20 s between reads, send and keep-alive 30 s, `reset_timedout_connection`; 64 KiB bodies on the public routes (10 MiB stays for KYC uploads); `worker_connections 8192`.
  - JSON bodies for nginx's own 429, 413 and 502/503/504 (with `Retry-After`), the api's `{ error, message }` shape.
  - Real client address from `X-Forwarded-For` only when the peer is on a private network (a TLS proxy on the box or a provider load balancer), `real_ip_recursive on`, so the per-address limits are per client and not one bucket for everybody behind the proxy. A direct public client cannot choose its address.
  - Keep-alive connections from nginx to the api (`upstream ... keepalive 32`).
- **Sizing:** the judge suite makes about 190 requests in 11 s, at most 54 req/s, 10 auth and 6 pay requests in one second; each limit leaves 10x headroom or more. The per-address checkout rate (100 r/s) is above the box's real checkout capacity (about 47/s), so a load test from one address reaches the box's limit before nginx's.
- **Test:** the table above, and the judge suite on the new config before and after the load tests.

## HH4. The stack was not sized for the 1 vCPU / 2 GB box — Medium

**Where:** `ops/docker-compose.yml`, `ops/compose.box-sim.yml` (new).

**Evidence:** the compose file set no CPU limit on any service and no memory limit on Postgres, and Node's heap limit was not tied to the container's. The api could take the whole CPU from Postgres, nginx and settlement, and the memory caps did not bound the box. After the fix, `docker inspect`: api `NanoCpus=500000000`, `Memory=536870912`; caps sum to 1.47 GB. Measured under every load test below: api at most 186 MiB of 512, Postgres at most 294 MiB of 512, nginx 9 MiB of 64.

- **What / Why:** the earlier sizing targeted a 0.5 vCPU box with separate per-container memory caps only.
- **Breaks:** the rubric requires the api at 0.5 vCPU / 512 MB on a 1 vCPU / 2 GB box; without the CPU cap an api under load starves the database it depends on.
- **Fix:** api `cpus: 0.5` and `NODE_OPTIONS=--max-old-space-size=384`; reporting a 160 MB heap; Postgres `mem_limit: 512m`, `max_connections=60`, `shared_buffers=128MB`, `effective_cache_size=384MB`, `work_mem=4MB`. The api's sessions get `statement_timeout=30s` and `idle_in_transaction_session_timeout=60s` through the connection URL (`options=-c ...`, verified with `SHOW`), so a runaway query or an abandoned transaction cannot hold a connection and its locks. The pool stays at the code default (5): with FB1 (no connection held across the acquirer call) 5 and 40 connections measured the same checkout throughput (22.4/s at 40 users each).
- **Test:** every measurement in this note ran under these limits.

## HH5. A hung api is never restarted, and most services had no healthcheck — Medium

**Where:** `ops/docker-compose.yml`, `ops/healthcheck.mjs` (new), `ops/Dockerfile.node`.

**Evidence:** `SIGSTOP` on the api's server process during a 40-user checkout load: the process stays alive and answers nothing. `restart: unless-stopped` only acts when a process exits, and Docker never restarts a container for being unhealthy, so before this the api stayed down for good. After: the healthcheck failed three times, killed the server, the restart policy started a new one, and the api served again 59 s after the hang (restart count 1 to 2), with no money row out of place (see recovery below).

- **What:** only Postgres had a healthcheck.
- **Fix:** healthchecks on api, web, settlement and reporting. For the api, `ops/healthcheck.mjs` probes `/healthz` with a 4 s timeout and, after three failures in a row, kills the server process so the restart policy replaces it. The one-off `migrate` and `seed` jobs keep no restart policy on purpose (restarting a finished job would loop).
- **Test:** the hang test above; `docker compose ps` shows every long-running service `(healthy)` after each fresh `up`.

## Capacity (the checkout scenario)

`ops/e2e/load/checkout-sweep.mjs`. Each virtual user loops: `GET /v1/payment-links/:token` (the checkout page's read), then `POST /v1/payment-links/:token/pay` with a fresh Idempotency-Key, on a link nobody else pays, through the public origin, for 30 s per step. After every step the database is checked: each 200 has exactly one captured transaction for the full amount, the link records it, no link has two captures, and every ledger group balances.

Final configuration, fresh data (the seed plus the steps before it):

| Users | Checkouts/s | p50 | p95 | p99 | Errors | Correctness (wrong rows / duplicate tx / links with two captures / unbalanced ledger groups) |
|---|---|---|---|---|---|---|
| 10 | 18.2 | 547 ms | 748 ms | 792 ms | 0 | 0 / 0 / 0 / 0 |
| 20 | 34.5 | 569 ms | 783 ms | 837 ms | 0 | 0 / 0 / 0 / 0 |
| 30 | 44.8 | 660 ms | 874 ms | 962 ms | 0 | 0 / 0 / 0 / 0 |
| 40 | 46.9 | 840 ms | 1,105 ms | 1,212 ms | 0 | 0 / 0 / 0 / 0 |
| 50 | 45.8 | 1,075 ms | 1,337 ms | 1,435 ms | 0 | 0 / 0 / 0 / 0 |
| 60 | 51.2 | 960 ms | 1,278 ms | 1,500 ms | 14% of attempts got 429, retried | 0 / 0 / 0 / 0 |
| 100 | 45.7 | 1,103 ms | 1,448 ms | 1,591 ms | 49% of attempts got 429, retried | 0 / 0 / 0 / 0 |
| 200 | 34.1 | 1,564 ms | 1,901 ms | 2,026 ms | 79% of attempts got 429, retried | 0 / 0 / 0 / 0 |

Latencies are for completed checkouts. From 60 users up, a user turned away with 429 waits the `Retry-After` second and retries the same checkout (a first version of the load script moved on to a new link at once instead, and spent the whole link list in seconds; its overload rows are not used). No step had a 5xx or a network error.

Our estimate: **the box serves about 30 concurrent checkout users at p95 under 0.9 s (45 checkouts/s), and up to 50 at p95 1.1 to 1.3 s (46-47 checkouts/s), with no errors and every payment correct.** Earlier runs of the same steps on a busier, larger dataset gave p95 0.94 s at 30 and 1.48 s at 40, so we quote 40 users at p95 under 1.5 s as the safe figure. About 0.5 s of every checkout is the acquirer simulator's own latency (two calls of 100 to 400 ms). The limit is the shared CPU (api plus Postgres), not memory or connections.

Past 50 pays in flight the excess is turned away at once with a JSON 429 (`rate_limited`): no 5xx and no wrong payment at any step up to 200 users, throughput stays at 34-51 checkouts/s, and the admitted checkouts keep a p95 under 2 s instead of growing without bound.

> Note — this table was measured with `compose.box-sim.yml` pinning the stack to one CPU of a larger multi-core build host, which is faster per-core than the actual hosted droplet. On the real live DigitalOcean droplet (1 vCPU shared, api capped to 0.5 vCPU), the measured ceiling is **~18 checkouts/s with a clean knee at ~10 concurrent users (p95 ~1 s, ≈0 errors to 20 users)** — see `docs/handover-pitch/stress-report.md`. The box-sim 45/s figure above does not transfer to this box; the ~18/s live figure is the one to quote for the hosted deployment. Both agree on perfect correctness (0 wrong rows / 0 duplicate tx / 0 double captures / 0 unbalanced ledger) and 0 × 5xx under overload.

Capacity falls as the data grows (see "Reported, not fixed" below): on a stack with 46,000 idempotency rows the same 40-user step did 20 to 28 checkouts/s instead of 41 to 45.

Other measured loads (60 s, one address, public origin):

| Load | req/s | p50 | p95 | 5xx | memory api / Postgres |
|---|---|---|---|---|---|
| realistic mix, 50 users (dashboard reads 35%, checkout views 20%, pays 15%, healthz 15%, link creates 7%, logins 8%) | 117 | 9 ms | 2.3 s | 0 | 182 / 273 MiB |
| same mix, 100 users | 187 | 122 ms | 3.0 s | 0 | 184 / 284 MiB |
| same mix, 200 users | 189 | 625 ms | 3.7 s | 0 | 185 / 294 MiB |
| `/healthz`, 100 users | 198 (rest 429) | 500 ms | 502 ms | 0 | 186 MiB |
| login with unknown accounts, 100 users | 2,706 (all but 360 answered 429 by nginx) | 20 ms | 27 ms | 0 | 175 MiB |

The p95 in the mixes is the logins (argon2 on 0.5 vCPU) and the pays; dashboard reads stayed at p95 78 ms with 50 users.

## Overload, restart and recovery

Each test ran the 40-user checkout load for 60 s and broke one thing 20 s in; a poller watched the containers and the public origin every second. Afterwards the database was checked (`ops/e2e/load/money-invariants.sql`): unbalanced ledger groups, paid links without a matching capture, links with two captures, captured transactions without ledger entries, refunds above captured.

| Break | Restart | Back after | What clients saw meanwhile | Money rows |
|---|---|---|---|---|
| `kill -9` the api server | restart policy (count 0 to 1) | 10 s | JSON 503 `service_unavailable` from nginx | all invariants 0 |
| Postgres immediate shutdown (crash, no checkpoint) | restart policy restarts Postgres; the api stays up (HH2) | 7 s | 500 `internal_error` from the api while the database was down | all invariants 0 |
| api hung (`SIGSTOP`) | healthcheck kill, then restart policy (HH5) | 59 s | requests timed out, then 503 | all invariants 0 |
| api out of memory (limit lowered to 150 MB under a 100-user mix) | kernel OOM kill (`OOMKilled=true`), restart policy, six times until the limit went back to 512 MB | healthy within seconds of the limit being restored | 503 JSON for 4,723 requests, no 500 | all invariants 0 |
| 200-user checkout load (5x the knee) | none needed | n/a | 429 for the excess | all invariants 0 |

A crash can cut a payment off between "link marked paid" and "capture recorded". By design (`paymentLinks/pay.ts`) such a link reads `processing` and refuses another pay, so the customer is never charged twice, and the authorization is left for the merchant. After the crash tests 58 links were in that state. Five minutes later, once the dead attempt's claim went stale, the merchant's `POST /v1/transactions/:id/capture` captured all 58 (200 each), after which every invariant was 0. A link whose crash came before "paid" stays `reserved` until the 60 s lease runs out and can then be paid again (checked: 200, and the leftover authorization is voided).

The judge suite passed (173 passed, 0 failed, 0 skipped, no nginx 429) on the fresh stack before the final sweep, right after it, and right after all the crash tests. It failed one check (`FP-300/FP-240 the shop gets a refund.succeeded webhook`) only at the very end, after about 60,000 test payments on merchant A with four of the suite's own webhook endpoints registered: see the webhook backlog item below. The failure is not the limits (nginx logged no 429 for the suite's requests).

## What an attacker can still do

- **Many addresses.** All limits but the in-flight caps are per address. A botnet beats a 1 vCPU box whatever the config; the in-flight caps then keep the api answering what it admits, but most requests get 429.
- **Lock out a known account.** Ten wrong passwords lock a merchant or admin account for 15 minutes, from any address, at 5 r/s. That is the price of the per-account lockout. On the judging box, raise `LOGIN_MAX_FAILED_ATTEMPTS` if the demo accounts must stay usable.
- **Take the whole checkout capacity from one address.** The per-address pay rate is above the box's capacity on purpose (so a judge's single-address load test measures the box, not nginx). One address can therefore fill the 50 in-flight pays; other customers then get 429 until it stops.
- **Bypass the per-address limits if port 8080 is reachable directly behind Docker's userland proxy.** nginx believes `X-Forwarded-For` from private-network peers. If 8080 is published to the internet through a proxy that rewrites the source address to a private one, a client could choose its own address. Keep 8080 behind the firewall (ops/README.md says to open only 443 and 80).
- **Fill the database slowly.** Signups and declined-card pays still create rows, at most 5 and 100 per second per address.

## Checked, not changed

- **Reported, not fixed: checkout slows down as data grows (High for capacity).** `capturedAttemptExists` in `apps/api/src/paymentLinks/pay.ts`, run inside every pay's claim `UPDATE`, matches `idempotency_keys.key LIKE 'paylink:' || <link id> || ':%:authorize'`. The only index on the key is the unique `(merchant_id, endpoint, key)` under the database's default collation, which cannot serve a `LIKE`, and the pattern is built per row. EXPLAIN ANALYZE at 45,902 rows: `Seq Scan on idempotency_keys`, `Rows Removed by Filter: 45901`, 23 ms per pay, growing with every pay (two rows each). Measured: 40-user checkout throughput fell from 41-45/s on a fresh box to 20-28/s after about 20,000 pays. The fix needs a migration, which this round was not allowed: an index `(merchant_id, endpoint, key text_pattern_ops)` plus a range the planner can use next to the `LIKE`, for example `k.key ~>=~ ('paylink:' || id || ':') AND k.key ~<~ ('paylink:' || id || ';')`. Checked on the test stack: `Index Scan using ...` at 0.045 ms. `voidOtherLinkAuthorizations` has the same `LIKE` and the same fix.
- **Reported, not fixed: a webhook backlog delays fresh webhooks (Medium, owned by the dispatcher lane).** Every judge-suite run registers a webhook endpoint on merchant A pointing at `https://example.com/...`, which answers 405, so each delivery is retried with backoff up to 8 times. After the load tests (tens of thousands of payment events for merchant A), 8,258 deliveries were pending and the suite's fresh `refund.succeeded` delivery queued behind them, past the suite's 30 s wait. fixf2's note already lists the Step B ordering (a fresh webhook queues behind a backlog by `next_attempt_at`) as checked, not changed; this is the measured consequence on a box under load. Not changed here (dispatcher code is another lane's). On the judging box, delete or disable stale test endpoints after a load test.
- **Pool size.** Raised to 20 and 40 first: on the base before FB1 it took checkouts from 8/s (5 connections) to 36/s (20) and 47/s (40). After FB1 the pool no longer limits checkout (22.4/s at 40 users with 5 and with 40 connections on the same data), so the code default (5) is kept.
- **Database down gives 500, not 503.** While Postgres restarts, the api answers `500 internal_error`. A 503 would be more accurate but needs an error-handler change in the api; the outage lasted 7 s and no money row was affected.
- **Reporting consumer pool.** `apps/reporting` creates its pool the same way the api did before HH2, so a lost checked-out connection may exit it too. If it does, the restart policy brings it back and it resumes from its stored cursor; not tested separately and not changed.
- **Lockout as a denial of service.** Left as designed (above); the threshold is configurable.
- **OTP on the hosted box.** Owned by fixf2 (FB6); not touched.
