# ops/

The FilsPay stack: Postgres, apps/api, apps/settlement (daemon),
apps/reporting (consumer), the browser front end (apps/web and apps/admin
behind nginx), and the one-off `migrate` and `seed` jobs. The hosted demo
instance uses the same compose file with its own `ops/.env`.

## Quick start

```
cp ops/.env.example ops/.env   # then fill in the four required secrets
docker compose -f ops/docker-compose.yml up -d --build
```

One `up` does everything, in order: Postgres becomes healthy, `migrate`
applies the migrations, `seed` loads the demo data into an empty database,
then `api`, `web`, `settlement` and `reporting` start (the services wait for
`migrate`, and the api also waits for `seed`, to finish successfully).

| URL | What |
|---|---|
| `http://<host>:8080/dashboard` | merchant dashboard (apps/web) |
| `http://<host>:8080/pay/<token>` | public checkout (apps/web) |
| `http://<host>:8080/admin/` | admin console (apps/admin) |
| `http://<host>:8080/v1/...` | API, same origin as the two front ends |
| `http://127.0.0.1:3000/v1/...` | API, direct, loopback only (operators on the box) |

API clients (merchant integrations, automated tests) use the same public
origin as the browser: `https://<public origin>/v1/...`.

Ports are set with `WEB_HOST_PORT`, `API_HOST_PORT` and `POSTGRES_HOST_PORT`
in `ops/.env`. Postgres and the direct API port are bound to 127.0.0.1 only.

The api takes the client address from nginx's `X-Forwarded-For`
(`TRUST_PROXY=loopback,linklocal,uniquelocal`), so sessions record the
browser's address rather than the proxy's. Only private-range peers are
trusted, and the api port is not reachable from outside the host, so a
remote client cannot forge its address with that header.

## Redeploying

`docker compose -f ops/docker-compose.yml up -d --build` again. `migrate`
applies only new migrations. `seed` sees that the database already has
merchants, ledger entries or admin users, prints `seed: skipped` and exits
0: a redeploy never wipes live data.

To wipe everything and reseed on purpose (destroys every merchant, ledger
entry, admin user and everything that references them):

```
SEED_RESET=1 docker compose -f ops/docker-compose.yml run --rm seed
```

## One origin for the browser

apps/api has no CORS handling, and the dashboard and console are
cookie-authenticated. A front end served from any other origin than the API
cannot log in: the browser preflights every JSON call, `OPTIONS /v1/...`
gets a 404, and fetch fails. So the `web` service (nginx,
`nginx.web.conf`) serves both builds and proxies `/v1`, `/healthz` and
`/readyz` to the api on the same origin. Both builds use relative API URLs
(`VITE_API_BASE_URL=""`, `VITE_ADMIN_API_BASE_URL=""`); the admin console is
built with `--base=/admin/`. In development, `npm run dev -w @filspay/web`
and `npm run dev -w @filspay/admin` do the same through Vite's proxy
(`API_PROXY_TARGET`, default `http://localhost:3000`).

## HTTPS and cookies

With `NODE_ENV=production` the session cookies (merchant, admin and
impersonation) are `Secure` (`COOKIE_SECURE`, default `true` in production).
Browsers store a Secure cookie only from an HTTPS origin, or from plain
http on `localhost`. On a hosted box served over plain http the login
succeeds at the API but the browser drops the cookie, and the next page
bounces back to the login screen.

So the hosted box must be reached over HTTPS. On Dilmune Cloud (or any
host), terminate TLS in front of the `web` service's port 8080: the
provider's HTTPS endpoint or load balancer if it offers one, otherwise a
TLS reverse proxy on the box (for example Caddy with an automatic
certificate) forwarding to `127.0.0.1:8080`. Then set `CHECKOUT_BASE_URL`
to that `https://` origin; payment-link URLs are built from it. Open only 443
(and 80 for the certificate challenge) in the host firewall; 8080 is
published on all interfaces so a provider load balancer can reach it.

`COOKIE_SECURE=false` makes the cookies work over plain http. It sends
session tokens in clear text, so it is acceptable only for a throwaway demo
on a private network, never on a public box. It is not set anywhere in this
stack.

## Logging in: the OTP decision (open, for the team)

Merchant and admin login are password + one-time code. This codebase has no
delivery channel for the code (no email or SMS sender). With
`NODE_ENV=production` the api neither returns nor logs it, so on the hosted
box nobody can complete a browser login as things stand. Options:

1. **`OTP_DEV_EXPOSE=true` on a demo/judging box only.** The login response
   then carries `devOtpCode`; the merchant
   login page displays it. Anyone who knows a
   password can log in without a second factor, so this must never be set
   on a box holding real merchants. It is off by default
   (`OTP_DEV_EXPOSE=${OTP_DEV_EXPOSE:-false}` in compose).
2. **Operator reads the code from the database** for each demo login (the
   challenge rows store only a salted hash, so the operator re-keys the
   newest pending challenge to a known code, as `ops/e2e/judge-suite.mjs`
   does with `DATABASE_URL`). Keeps the second factor; needs shell access.
3. **Build a delivery channel** (email via a provider). The real fix; not
   in scope for the handover.

API-key traffic (`Authorization: Bearer fp_...`) needs no OTP; the seed
prints one key per demo merchant.

## Acquirer simulator failure rate

The simulator declines a random fraction of approved cards
(`ACQUIRER_FAILURE_RATE`, code default 0.02). Compose sets it to 0, so demos
and automated tests are deterministic. Set it in `ops/.env` to exercise the
failure path.

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | the stack |
| `.env.example` | the settings each host supplies in `ops/.env` (gitignored); four are required |
| `.env.docker` | shared non-secret service settings (`NODE_ENV`, `PORT`), loaded via `env_file` |
| `Dockerfile.node` | one image (`filspay-node:${IMAGE_TAG:-local}`) for api, reporting, migrate and seed |
| `Dockerfile.go` | multi-stage build of `apps/settlement` |
| `Dockerfile.web` | builds apps/web and apps/admin, serves both from nginx |
| `nginx.web.conf` | nginx site: SPA fallbacks for `/` and `/admin/`, `/v1` proxied to the api |

## Database

Every service and job connects as the `filspay` role with the password from
`POSTGRES_PASSWORD` in `ops/.env`. There is no default password: compose
refuses to start without one. The password is fixed when the Postgres
volume is first created; changing it later also needs `ALTER ROLE` inside
the database.

Known limitation: one role owns the whole database and every service uses
it, so the api, the reporting consumer and the settlement daemon each have
full rights (including DDL) on every table. Per-service roles with narrow
grants are the follow-up; they need a migration that creates the roles and
grants, and per-service passwords in `ops/.env`.

`sslmode=disable` is used on the compose network. That network stays on
the host, but it is still plaintext between containers; use TLS if the
database ever moves to another machine.

The settlement worker can be given a second connection string,
`PGCONN_SETTLEMENT`; `DATABASE_URL` takes precedence when both are set.

## Required settings per service

| Service | Needs | Where it comes from in compose |
|---|---|---|
| all | `DATABASE_URL` | built from `POSTGRES_PASSWORD` (`ops/.env`) |
| api, seed | `WEBHOOK_SECRET_ENCRYPTION_KEY`, `ACQUIRER_CALLBACK_SIGNING_SECRET`, `SETTLEMENT_INTERNAL_TOKEN` | `ops/.env` (required; the image sets `NODE_ENV=production`, and the api config refuses to load without them) |
| api, reporting | `NODE_ENV=production`, `PORT` | `.env.docker` via `env_file` |
| api | `SETTLEMENT_INTERNAL_URL`, `CHECKOUT_BASE_URL`, `ACQUIRER_FAILURE_RATE`, `OTP_DEV_EXPOSE` | `environment:` |
| settlement | `SETTLEMENT_INTERNAL_TOKEN` | `ops/.env`; no default, `daemon` exits without it; must match the api |
| reporting | (nothing else) | runs `worker` by default |

## Resource sizing

The hosted demo box is 0.5 vCPU / 2 GB RAM / 2 GB disk. Memory caps: api
512 MB, reporting 256 MB, settlement 128 MB, web 64 MB; measured at idle
after a first boot: api ~90 MB, reporting ~70 MB, settlement ~3 MB, nginx
~14 MB, Postgres ~50 MB.

Disk: one Node image is built and shared by four services (it was four
identical 542 MB images), the settlement image is ~25 MB and the web image
~74 MB (nginx plus the two static bundles). `Dockerfile.go` deletes the Go build
and module caches in the layer that creates them, and the Node images drop
the npm cache. Images use `node:22-slim`: on `node:20` the argon2 prebuilt
binary segfaults during `npm ci`, which then falls back to node-gyp and
fails (no python in the slim image).

KYC uploads are stored in the `filspay_kyc` volume (`/app/data/kyc`), so
they survive container rebuilds.
