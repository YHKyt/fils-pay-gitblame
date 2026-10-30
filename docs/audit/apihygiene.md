# API hygiene — findings

Branch `agent/apihygiene`. Test file: `apps/api/src/apiHygiene.test.ts` (runs against a real, migrated Postgres via `DATABASE_URL`). Each fix was proven by reverting the changed source files to the parent commit, running the test (fails), restoring the fix and running it again (passes).

## H-LOG: payment-link tokens written to the request log — Low/Medium

**Where:** `apps/api/src/app.ts:42` (`Fastify({ logger: true })`); public routes in `apps/api/src/routes/paymentLinks.ts:162,174`.
**Evidence:** `GET /v1/payment-links/SECRETTOKEN123abc` on the old code logs `"req":{"method":"GET","url":"/v1/payment-links/SECRETTOKEN123abc?x=1",...},"msg":"incoming request"`. A mistyped sub-path also logs `"msg":"Route GET:/v1/payment-links/<token>/nope not found"`.

- **What:** Fastify's default request serializer logs the full URL of every request. The payment-link token is in the URL path.
- **Why:** The token is a bearer secret. Whoever holds `/v1/payment-links/<token>` can read the link and pay it, so it must be treated like a password. Request logs are read and shipped far more widely than the database (log aggregators, support staff, screenshots in tickets).
- **Breaks:** Anyone with log access gets a working URL for every open link a customer opened. Same exposure for any future secret passed in a query string.
- **Fix:** `apps/api/src/lib/requestLogging.ts` adds a `req` serializer that logs the same fields as Fastify's default, but replaces the segment after `/v1/payment-links/` and the values of query keys that look secret (`token`, `secret`, `password`, `signature`, `otp`, `code`, `key`) with `[redacted]`. `app.ts` passes it in `logger.serializers`. `buildApp` gains an optional `logStream` (test seam only). This is the smallest change: a serializer only, no change to routing, log level or log format.
- **Test:** `payment-link tokens never reach the request log` sends four requests with a random token and asserts the logged URLs are redacted and that the token string appears nowhere in the log. Fail-before: `+ []` vs the expected redacted list (old code ignores the stream and printed the token to stdout). Pass-after: `ok 1`.

## H-HDR: no security headers, no `Cache-Control: no-store` (FP-207 marked Done but absent) — Low

**Where:** `apps/api/src/app.ts` (no `onSend` hook anywhere); `docs/incidents/postmortem-2026-05.md:122` lists "`Cache-Control: no-store` on the hosted link page — FP-207 — Done".
**Evidence:** Old code, `GET /v1/payment-links/<token>` headers: only `content-type`, `content-length`, `date`, `connection`. A repository-wide search finds no `no-store`, `nosniff` or `Cache-Control` in any app.

- **What:** API responses carry no `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options` or `Cache-Control`.
- **Why:** Every response is per-merchant or per-link data (transactions, balances, link details, session state). Without `no-store` a browser or shared proxy may keep them. Without `nosniff` a browser may sniff a JSON/CSV response as HTML. The FP-207 action item was closed without the header ever being sent.
- **Breaks:** Payment-link details and dashboard data can be served from a shared or back-button cache to the next user of the device. Defence-in-depth headers are missing.
- **Fix:** One `onSend` hook in `buildApp` sets `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` on every response, and `Cache-Control: no-store` unless a route already set its own `Cache-Control`. No new dependency (no helmet). One hook covers authenticated, public-link, error and 404 responses.
- **Test:** `security headers on authenticated, public-link and health responses` checks `/v1/transactions` (401), `/v1/payment-links/nosuchtoken` (404), `/healthz` and an unknown route. Fail-before: `expected: 'nosniff'`, actual `undefined`. Pass-after: `ok 2`.

## H-404: unknown routes return Fastify's default error shape — Low

**Where:** `apps/api/src/app.ts` (no `setNotFoundHandler`); the shape contract is in `apps/api/src/lib/errors.ts:1-7` and `apps/api/src/plugins/errorHandler.ts`.
**Evidence:** Old code, `GET /v1/nope` returns `{"message":"Route GET:/v1/nope not found","error":"Not Found","statusCode":404}`.

- **What:** Every other error is `{ error: "<code>", message }`, but unknown routes return Fastify's built-in body, with `error` set to the human phrase `"Not Found"` and an extra `statusCode` key.
- **Why:** Clients switch on `error` as a stable machine code. The default 404 handler also logs the full URL, which repeats the H-LOG leak for a mistyped payment-link sub-path.
- **Breaks:** Integrations that branch on `error` see a non-code value; the API is inconsistent with its own contract.
- **Fix:** `notFoundHandler` in `plugins/errorHandler.ts`, registered with `app.setNotFoundHandler`, returns `404 { error: "not_found", message: "route not found" }` and does not echo or log the URL. Smallest change: one handler, next to the existing error handler.
- **Test:** `unknown routes use the uniform { error, message } shape`. Fail-before: actual `error: 'Not Found', message: 'Route GET:/v1/does-not-exist not found', statusCode: 404`. Pass-after: `ok 3`. The log test also covers `/v1/payment-links/<token>/nope`.

## Reported only (not in this lane): refund validation errors use a different shape — Low

**Where:** `apps/api/src/payments/refundValidation.ts:14-45`, returned as the HTTP body by `apps/api/src/payments/processRefund.ts:111-113` and `apps/api/src/routes/refunds.ts:70`.
**Evidence:** The existing test `apps/api/src/refunds/initiateMerchantRefund.test.ts:198-199` asserts status 422 with body `{ ok: false, code: "refund_amount_invalid" }`; `processRefund.test.ts:431` asserts `{ ok: false, code: "transaction_not_refundable", status: "voided" }`.

- **What / Why:** Refund validation failures reach the client as `{ ok, code, ... }` instead of the uniform `{ error, message }`. A client checking `body.error` sees nothing.
- **Fix (suggested, for the refunds owner):** map the validation result to `{ error: code, message, ...details }` before it is stored on the idempotency key and sent. Not changed here because refunds and idempotency belong to the other team member's lane, and the stored idempotent replay body must change together with it.
