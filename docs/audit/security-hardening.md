# Security hardening — adversarial sweep (branch `agent/sec`)

Adversarial security review of FilsPay (app + hosted config) against the
`fix/money-parsing` tip. Each real finding below is proven with a
fail-before / pass-after test or a before/after HTTP capture, fixed at the
source with the smallest change, and committed one per finding. Things
checked and found already safe are listed at the end as defence material.

Scope: our own code (`E:\reboot\fils-pay`) and the hosted config on our box
(139.59.82.16), reviewed read-only. No live service was changed from here;
config fixes land in the repo and are flagged for redeploy.

---

## SEC1. Checkout, dashboard and admin pages served with no anti-framing / baseline headers (clickjacking) — Medium

**What.** The HTML documents a person actually loads and clicks — the public
checkout (`/pay/:token`), the merchant dashboard (`/dashboard/...`) and the
admin console (`/admin/...`) — are served by the `web` nginx container
(`ops/nginx.web.conf`) with **no** `X-Frame-Options`, `Content-Security-Policy`,
`X-Content-Type-Options` or `Referrer-Policy`. Confirmed absent on the live
box: `curl -I https://139.59.82.16.sslip.io/dashboard` (and `/pay/...`,
`/admin/login`) returns `200` through `server: Caddy` → `server: nginx` with
none of these headers.

**Why.** With no `X-Frame-Options: DENY` / `frame-ancestors 'none'`, any
third-party page can embed these pages in an `<iframe>` and run a UI-redress
(clickjacking) overlay. The most serious case is the **unauthenticated**
checkout page: there is no SameSite cookie to blunt the attack, so a payer can
be tricked into submitting card details / confirming a payment through an
invisible frame. The API itself already sets these headers on its JSON
responses (`apps/api/src/app.ts` `onSend`), but those headers never reach the
HTML, which nginx serves directly — so the protection stopped exactly at the
surface a browser frames. `X-Content-Type-Options: nosniff` and a tight
`Referrer-Policy` are added alongside as cheap, non-breaking baseline.

**Breaks.** Nothing. `frame-ancestors 'none'` / `X-Frame-Options: DENY` only
forbid framing, which the app never relies on. The change is scoped to the two
HTML-serving `location` blocks and adds `add_header` lines next to the existing
`Cache-Control` (multiple `add_header` in one block all apply), so caching
behaviour is unchanged. A deliberately minimal CSP (`frame-ancestors` only, no
`default-src`) avoids breaking the Vite-built SPA's inline/module scripts.

**Fix.** `ops/nginx.web.conf` — add to `location /admin/` and `location /`:
`X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, each
`always`. Requires a `web` container redeploy to take effect (config-only, no
image rebuild of the app).

**Also recommended (box config, not in repo — for ops):** the Caddy TLS edge
(`/home/dilmune/caddy/Caddyfile`) sends no `Strict-Transport-Security`. Add
`header Strict-Transport-Security "max-age=31536000; includeSubDomains"` to the
site block so the HTTPS-only posture is pinned in the browser. Left as an ops
action because the Caddyfile is managed on the box, outside this repo, and the
brief forbids changing the live box from here.

**Test.** `ops/nginx.web.conf` validated with `nginx -t` (syntax OK). HTTP
before/after, same config mounted into `nginx:1.27-alpine`:
- base conf, `GET /dashboard` → `200`, **no** `X-Frame-Options`.
- fixed conf, `GET /dashboard`, `GET /pay/<token>`, `GET /admin/login` → `200`
  with `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`.

---

## SEC2. `OTP_DEV_EXPOSE` can leak the OTP in the login response on a production box — Medium

**What.** `otpDevExpose` returns the freshly generated OTP in the body of
`POST /v1/auth/login` and `POST /v1/admin/auth/login` (`routes/auth.ts`,
`routes/adminAuth.ts`, the `devOtpCode` field). Before this change
`loadConfig` honoured `OTP_DEV_EXPOSE=true` **in every environment**, so a
production box whose env set that flag (templated env, copy-paste from a dev
`.env`, debugging left on) would hand the second factor to anyone who can POST
a login — defeating OTP entirely.

**Why.** The OTP is the second authentication factor. Returning it in the HTTP
response to the unauthenticated caller means possession of the password (or
even just the ability to trigger a login for a known account) yields the OTP
directly. The codebase already forces the safe value in production for the
analogous `acquirerCallbackRequireSignature` flag; `otpDevExpose` was the one
dev-convenience security flag that a prod env var could still switch on. (Live
box currently has `OTP_DEV_EXPOSE=false`, so this is latent, not active — the
fix removes the footgun.)

**Breaks.** Nothing in production (the OTP was never meant to be exposed
there). The dev/test convenience is unchanged: the flag still works, and still
defaults on, when `NODE_ENV` is `development` or `test`.

**Fix.** `apps/api/src/config.ts` — force `otpDevExpose = false` whenever
`nodeEnv === "production"`, regardless of the `OTP_DEV_EXPOSE` env var, mirroring
the `acquirerCallbackRequireSignature` posture.

**Test.** `apps/api/src/config.otpDevExposeProd.new.test.ts`:
- fail-before: `NODE_ENV=production` + `OTP_DEV_EXPOSE=true` → `otpDevExpose`
  was `true` (test fails on unfixed `config.ts`).
- pass-after: same input → `false`; dev/test with the flag still `true`.

---

## Checked, confirmed safe (verification notes)

Each item below was examined and found already correct; recorded so a reviewer
can see the surface was covered.

**AuthZ / IDOR / tenant scoping (full sweep of every `/v1` merchant route).**
Every merchant endpoint that takes an `:id` or body id runs SQL with a
`merchant_id = $n` predicate bound to `request.merchantAuth.merchantId` (or a
preceding merchant-scoped ownership check). Verified: transactions
(`transactions/query.ts` `WHERE id=$1 AND merchant_id=$2`), events, CSV export,
refunds (`refunds/initiateMerchantRefund.ts`, `payments/processRefund.ts`),
payment links, settlements/batches, webhooks/endpoints/deliveries/replay,
KYC/onboarding, analytics, reporting + saved filters, API keys. `merchantAuth`
is never set from path/body (`auth/requireMerchantAuth.ts`). `reporting/scope.ts`
`resolveReportMerchantId` only widens to a merchant it owns via
`merchant_split_children` (fails safe to the caller's own id otherwise), not an
IDOR. `transactions/lookup.ts` / `receipt.ts` are unscoped but have **no
callers** (latent only — noted so a future route doesn't wire them up without a
`merchant_id` predicate).

**Admin impersonation (the "middleware authoritative" trap in CLAUDE.md).**
CLAUDE.md claims the handler relies on a `super_admin` middleware gate. In fact
`/v1/admin/merchants/:id/impersonate` carries `requireAdminSession` only (any
admin role, by documented design), but it is safe because the grant is
view-only two ways: `lookupImpersonationGrant` always maps to merchant role
`support`, and `requireMerchantAuth` hard-blocks any non-GET/HEAD request from
an `admin_impersonation` actor (403). So impersonation cannot write regardless
of role. The earlier `super_admin → owner` escalation is already closed.

**Admin role gates.** Every money-adjacent admin route chains
`requireAdminRole("finance","super_admin")` after `requireAdminSession`
(`routes/admin*.ts`); `requireAdminRole` re-reads `request.adminAuth` server-side
and 403s on mismatch. UI `RequireRole` is a convenience layered on top, not the
boundary.

**OTP entropy (the "Math.random for OTP" trap in CLAUDE.md).** CLAUDE.md is
stale: `lib/random.ts` uses `crypto.randomInt`, and OTP salts use
`crypto.randomBytes`. No `Math.random` on any token/OTP path.

**Session fixation (S7) / tokens / cookies.** `promoteSession` and
`promoteAdminSession` rotate the token on OTP verify, so the pre-OTP cookie is
dead after login (no fixation). Tokens are `crypto` 32-byte, stored only as
sha256. Cookies are `HttpOnly`, `SameSite=Lax`, `Secure` (defaults to on in
production). Logout revokes server-side. Sessions re-check merchant/admin
`status='active'` on every request.

**OTP brute force / lockout.** Per-challenge `attempt_count` reserved by an
atomic conditional UPDATE **before** comparing (no parallel-guess bypass);
hitting `max_attempts` revokes the pending session. `otp/resend` carries the
guess count over and is throttled under a row lock (no budget reset). Password
login uses a per-account atomic `reserveLoginAttempt` lockout + a fixed dummy
argon2 hash for timing, generic `invalid_credentials` in every failure case.

**Password hashing.** argon2id at OWASP-min params (`auth/passwords.ts`);
`verifyPassword` returns false on malformed hashes.

**Injection (SQL / command / path) — full sweep.** No user-controlled string
reaches a SQL string: all values are `$n`-bound; the few interpolations are
fixed internal constants (`loginLockout.ts` `${table}` from a 2-value union,
`capturedAttemptExists` table alias + placeholder name, dispatcher channel
constants) or whitelist-checked columns (`analytics/query.ts`
`ALLOWED_BREAKDOWN_COLUMNS`). LIKE search inputs are wildcard-escaped
(`replace(/[\\%_]/g, "\\$&")`) then bound (`transactions/query.ts`,
`admin/merchants.ts`). No production `child_process`/`exec`/`os/exec`. Only
request-derived filesystem path is KYC storage, whose single variable segment
is a server-issued UUID (`assertOwnMerchant`) + a sha256 filename; reads go by
DB-stored `storage_key`. Webhook archive replay is entirely DB/JSONB, scoped by
`merchant_id`. Go `ExportSchemeFile` path is an operator CLI flag, not
request-reachable.

**SSRF (webhooks + acquirer).** `webhooks/urlPolicy.ts` blocks loopback,
RFC1918/ULA, link-local incl. `169.254.169.254`, CGNAT, 6to4/Teredo/NAT64/
IPv4-mapped tricks, single-label and `.local/.internal` names. `transport.ts`
re-checks at send time **and** pins the connect-time resolved address via a
guarded `lookup` (blocks DNS-rebinding / TTL-0), with `redirect: "manual"` so a
3xx can't bounce to an internal host. Enabled in production.

**Webhook / acquirer-callback signing + replay.** HMAC-SHA256 over the raw
bytes, constant-time compare (`timingSafeEqualHex`), `t=<unix>,v1=<hex>` with a
±300s freshness window (replay protection), multi-secret for rotation. Acquirer
callback is signature-authenticated (unsigned rejected in production,
`acquirerCallbackRequireSignature` forced `true` when `NODE_ENV=production`) and
idempotent on `callbackId`.

**Money-safety as security.** Amounts must be positive safe integers ≤
`MAX_AMOUNT_FILS` (`parsePositiveAmountFils`); currency must be BHD if present
(`assertBhdCurrency`). Refunds can't exceed `refundableFils`, reject zero/negative,
and require a refundable status (`refundValidation.ts`). Payment-link pay takes
the amount from the link row (never the request), ignores client `submittedAt`
for expiry, and uses atomic claim→lease→finalize so only the finalize winner
captures (no double-charge). CSV export cells are formula-injection-escaped.

**Config / headers / error shape.** API sets `X-Content-Type-Options`,
`Referrer-Policy`, `X-Frame-Options: DENY`, `Cache-Control: no-store` on JSON
responses. 500s return `{error:"internal_error"}` with no stack/pg detail; 404
never echoes the URL (payment-link token). `NODE_ENV` parsing is strict (unknown
value refuses boot). Body limits enforced (nginx `client_max_body_size`, per-route
64k on auth/pay, Fastify bodyLimit with graceful 413 drain). `rejectNul` plugin.

**Hosted config (read-only review of 139.59.82.16).** Postgres and the api are
published on `127.0.0.1` only; only `web` (80/443 via Caddy) is public.
`TRUST_PROXY=loopback,linklocal,uniquelocal` (not `true`), nginx `real_ip`
trusts private peers only with `real_ip_recursive`. Live env: `NODE_ENV=production`,
`OTP_DEV_EXPOSE=false`, `ACQUIRER_FAILURE_RATE=0`. Secrets required at boot
(compose `${VAR:?}`), none observed in responses/logs. Per-address rate limits
on auth/pay/connections + whole-box in-flight caps (`nginx.web.conf`).

**Dependencies.** `npm audit` shows no high/critical — only moderate advisories
(esbuild/vite dev-server, fast-uri, fastify HTTP/2 trailer DoS, react-router).
Per the brief, not churning the lockfile for lows/moderates.
