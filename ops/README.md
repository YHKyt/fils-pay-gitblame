# ops/

Local development stack for FilsPay: Postgres plus the three services that
talk to it directly (apps/api, apps/settlement, apps/reporting). The hosted
demo instance uses the same compose file with a different `.env`.

## Quick start

```
cp ops/.env.example ops/.env   # then fill in the three secrets
docker compose -f ops/docker-compose.yml up -d postgres
docker compose -f ops/docker-compose.yml run --rm migrate
docker compose -f ops/docker-compose.yml run --rm seed
docker compose -f ops/docker-compose.yml up api settlement reporting web
```

The merchant dashboard and public checkout (apps/web) are served by the
`web` service on port 8080: nginx serves the Vite build and proxies `/v1`
to the api on the same origin (`nginx.web.conf`). This is required, not a
convenience: apps/api sends no CORS headers, so a dashboard on any other
origin fails every call at the preflight (`OPTIONS /v1/...` -> 404) and
cannot log in. In development, `npm run dev -w @filspay/web` does the same
through Vite's proxy (`API_PROXY_TARGET`, default `http://localhost:3000`).

With `NODE_ENV=production` the session cookie is `Secure`, so the hosted
dashboard must be reached over HTTPS (or `localhost`); browsers drop a
Secure cookie set over plain http on any other host.

apps/admin is not part of this compose file; it is a Vite dev server
(`npm run dev -w @filspay/admin`) that calls apps/api over HTTP.

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | the stack |
| `.env.docker` | shared service settings, loaded by compose for every service |
| `Dockerfile.node` | image for api, reporting, migrate and seed (`node:20`, full install) |
| `Dockerfile.go` | multi-stage build of `apps/settlement` |
| `Dockerfile.web` | builds apps/web, serves it from nginx |
| `nginx.web.conf` | nginx site for `web`: SPA fallback, `/v1` proxied to the api |

`.env.example` lists the secrets every host must supply in `ops/.env` (gitignored).

## Database

Every service, plus the one-off `migrate`/`seed` jobs, connects with the
same `filspay` role and the same `DATABASE_URL`
(`postgres://filspay:filspay_dev_password@postgres:5432/filspay?sslmode=disable`).
One role keeps local setup to a single password instead of hand-rolling
per-service grants for a stack this size. `sslmode=disable` is safe here:
Postgres and every service run on the same Docker Compose bridge network,
which never carries traffic outside the host, so there's no untrusted hop
for a connection to cross.

The settlement worker can be given a second connection string,
`PGCONN_SETTLEMENT`, for its batch-close pool. It only takes effect when
`DATABASE_URL` is unset.

To reset the database to a clean, freshly-seeded state at any point, re-run
the `seed` job above — `db/seed/index.ts` truncates and regenerates its
fixture tables on every invocation; it doesn't need the volume removed
first.

## Required settings per service

| Service | Needs | Where it comes from in compose |
|---|---|---|
| api | `DATABASE_URL`, `SETTLEMENT_INTERNAL_URL` | `environment:` |
| api | `WEBHOOK_SECRET_ENCRYPTION_KEY`, `ACQUIRER_CALLBACK_SIGNING_SECRET`, `SETTLEMENT_INTERNAL_TOKEN` | `ops/.env` (required; compose refuses to start without them) |
| api, reporting | `NODE_ENV=production`, `PORT` | `.env.docker` via `env_file` |
| settlement | `DATABASE_URL` | `environment:` |
| settlement | `SETTLEMENT_INTERNAL_TOKEN` | `ops/.env` — no default; `daemon` exits without it; must match the api |
| reporting | `DATABASE_URL` | `environment:`; runs `worker` by default |

## Resource sizing

The hosted demo box is 0.5 vCPU / 2 GB RAM / 2 GB disk; the API container is
limited to 512 MB. Postgres defaults are fine at this size. The settlement
image is built on the box with `go build` from `Dockerfile.go`.

`Dockerfile.go` deletes the Go build and module caches in the same layer that
creates them, and `Dockerfile.node` drops the npm cache, so a first build fits
the 2 GB disk. The api has `mem_limit: 512m`. Postgres is published on
127.0.0.1 only.
