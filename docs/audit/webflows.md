# Merchant dashboard flows (WF1-WF8)

Scope: apps/web merchant dashboard end to end (login, payment links,
webhooks, settlement and overview views) and the API routes behind it, plus
the deploy path that serves the dashboard. Regression tests:
`apps/web/src/api/sameOrigin.test.ts`, `apps/web/src/utils/paymentLinkStatus.test.ts`
(WF2 case) and `apps/api/src/routes/webflows.test.ts` (WF2-WF7). Every test
below was run against the old code (fails) and the fix (passes).

## WF1. The dashboard cannot reach the API, locally or hosted — Critical

**Where:** `apps/web/src/api/client.ts:3`, `apps/web/vite.config.ts`, `ops/docker-compose.yml` (no web service).
**Evidence:** `curl -i -X OPTIONS http://localhost:3317/v1/auth/login -H "Origin: http://localhost:5317" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type"` -> `HTTP/1.1 404 Not Found`, `{"message":"Route OPTIONS:/v1/auth/login not found",...}`, no `Access-Control-*` headers. In the browser the login form showed "Failed to fetch". `grep -ri cors apps/api/src` finds nothing; `@fastify/cors` is not installed.

- **What:** The dashboard called the API on another origin (`http://localhost:3000` from `:5173`, the hard-coded default) with `credentials: "include"` and a JSON body. The API has no CORS handling at all, so every such request is preflighted, the preflight 404s, and the browser blocks the call. Nobody could sign in, and the public checkout (`/pay/:token`, same app) could not load or pay a link. The hosted stack had no way to serve apps/web at all; serving the bundle from any other host fails the same way.
- **Why:** The code comments assume "CORS is locked to the two origins in config"; that config never existed.
- **Breaks:** The whole merchant dashboard and the customer checkout, in development and in any deployment.
- **Fix:** Make the dashboard same-origin instead of adding CORS. The client defaults to relative URLs (`""`), Vite's dev and preview servers proxy `/v1` to the API (`API_PROXY_TARGET`, default `http://localhost:3000`), and a new `web` compose service (`ops/Dockerfile.web` + `ops/nginx.web.conf`) serves the built bundle from nginx with `/v1` proxied to `api:3000`, SPA fallback, a 10 MiB body limit (KYC uploads are up to 8 MiB) and `/` redirected to `/dashboard`. Same-origin keeps the session cookie first-party and adds no new attack surface; CORS with credentials would have had to be configured and audited per origin. `ops/README.md` documents it, and notes that `NODE_ENV=production` makes the cookie `Secure`, so the hosted dashboard needs HTTPS.
- **Test:** `sameOrigin.test.ts`: (1) the client calls `/v1/auth/me`, not `http://localhost:3000/v1/auth/me` (old: `actual: 'http://localhost:3000/v1/auth/me'`); (2) a real Vite dev server built from `vite.config.ts` forwards `POST /v1/auth/login` with its cookie to a stub API (old: `404 !== 200`). Hosted path: built the `web` image and ran it against a local API; `GET /v1/auth/me` through nginx -> 401 from the API, login + OTP verify -> 200, `/v1/auth/me` -> 200 with the merchant, and in a browser at `http://127.0.0.1:18080/dashboard/login` the seeded finance user signed in and the transactions page loaded 25 rows.

## WF2. A link stuck in a lapsed reservation cannot be canceled but can still be paid — High

**Where:** `apps/api/src/paymentLinks/cancel.ts:15`, `apps/web/src/utils/paymentLinkStatus.ts:22`.
**Evidence:** link set to `status='reserved', reserved_at = now() - 1 hour`: public read `status: active`; `DELETE .../payment-links/:id` -> `409 {"error":"not_cancelable","message":"status: reserved"}`; then `POST /v1/payment-links/:token/pay` -> `200 {"status":"paid","amountFils":5000,...}`.

- **What:** A pay attempt that dies between claim and finalize leaves the row `reserved`. After `PAYMENT_LINK_RESERVATION_TIMEOUT_SECONDS` the pay endpoint reclaims it and the public read calls it `active`, but cancel only matched `status = 'active'`, and the dashboard hid the Cancel button for `reserved`.
- **Why:** Three places decide "is this link live": the pay claim and the public status both treat a lapsed reservation as active; cancel did not.
- **Breaks:** A merchant cannot withdraw a link (wrong amount, fraud, order canceled) while customers can still pay it, and there is no sweep job, so the row stays stuck.
- **Fix:** Cancel also matches `status = 'reserved' AND reserved_at < now() - timeout`, the pay claim's own predicate; a live reservation still answers 409. The dashboard offers Cancel on an unexpired `reserved` link and lets the API decide. Smallest change: one predicate and one helper.
- **Test:** `WF2` tests: old `409 !== 204`; fixed: cancel 204, the later pay is refused and no transaction exists; a live reservation still 409. Web helper: old `false !== true`.

## WF3. "Send test event" still posts to a deleted webhook endpoint — Medium

**Where:** `apps/api/src/webhooks/testSend.ts:41`.
**Evidence:** create endpoint, `DELETE` -> 204, `POST .../webhook-endpoints/:id/test` -> `200 {"statusCode":200,"responseBodyExcerpt":"ok",...}` and the receiver got 1 request.

- **What:** Endpoints are soft-deleted (`deleted_at`, migration 0080) and list, get and update all filter `deleted_at IS NULL`; the test-send lookup did not.
- **Why:** The soft-delete change missed this query.
- **Breaks:** A deleted endpoint (for example a URL the merchant no longer controls) still receives payloads signed with the endpoint's secret, against the documented "never sent to" contract.
- **Fix:** Add `AND deleted_at IS NULL`; the route answers 404 `webhook_endpoint_not_found`.
- **Test:** `WF3`: old `200 !== 404`; fixed 404 and the receiver saw no request.

## WF4. Webhook endpoint create/update accept an array URL and 500 on an unknown status — Medium

**Where:** `apps/api/src/webhooks/create.ts:18` (`validateWebhookUrl`), `apps/api/src/webhooks/update.ts:37`.
**Evidence:** `POST .../webhook-endpoints {"url":["http://127.0.0.1:53975/arr"]}` -> `201`, stored `url` = `{"http://127.0.0.1:53975/arr"}`; `PATCH {"status":"paused"}` -> `500 {"error":"internal_error"}`.

- **What:** `new URL([...])` stringifies the array and parses, so validation passed and pg stored an array literal. An unknown status reached the enum cast.
- **Why:** Request bodies are not schema-checked; the TypeScript types are not runtime checks.
- **Breaks:** An endpoint that can never be delivered to, created with 201; a server error for a client mistake.
- **Fix:** `validateWebhookUrl` requires a string; update accepts only `active` or `disabled`; both 400.
- **Test:** `WF4`: old `201 !== 400`; fixed 400 for array URL, unknown status and object URL, and the stored row is unchanged.

## WF5. `?limit=abc` on payment-link and delivery lists is a 500 — Low

**Where:** `apps/api/src/paymentLinks/query.ts:66`, `apps/api/src/webhooks/deliveries.ts:122`.
**Evidence:** `GET .../payment-links?limit=abc` -> 500; `GET .../webhook-endpoints/:id/deliveries?limit=abc` -> 500.

- **What / Why:** `parseInt("abc")` is `NaN`, `Math.min/Math.max` pass it through, and Postgres rejects `LIMIT NaN`.
- **Breaks:** A server error for a bad query string.
- **Fix:** A non-finite limit uses the default page size, the same guard the settlement batches list uses.
- **Test:** `WF5`: old `500 !== 200`; fixed 200 with the default page.

## WF6. Business profile PATCH values are unchecked — Low

**Where:** `apps/api/src/onboarding/businessProfile.ts` (`updateBusinessProfile`).
**Evidence:** `PATCH .../business-profile` with `{"legalName":null}`, `{"businessType":"corp"}`, `{"country":"BHR"}` -> 500 each; `{"legalName":5}` -> 200, stored `"5"`.

- **What / Why:** Only the keys were validated (an earlier fix); values went straight into NOT NULL, CHECK and CHAR(2) columns.
- **Breaks:** Server errors on bad input; required KYC fields could be blanked (`""`) or set to non-strings.
- **Fix:** Values must be strings (null only for `addressLine2`/`postalCode`), required fields non-empty, `businessType` one of the CHECK values, `country` two capital letters; otherwise 400.
- **Test:** `WF6`: old `500 !== 400`; fixed 400 for each bad value, a valid patch still 200 and the row unchanged by the rejected ones.

## WF7. Non-string text fields accepted on payment-link create and API key issue — Low

**Where:** `apps/api/src/paymentLinks/create.ts:47`, `apps/api/src/routes/apiKeys.ts:40`.
**Evidence:** `POST .../payment-links` with `reference: ["r"]`, `description: {"a":1}` or `expiresAt: ["2027-01-01T00:00:00Z"]` -> 201; `POST .../api-keys` with `label: ["a","b"]` or `{"x":1}` -> 201.

- **What / Why:** pg serialises arrays as Postgres array literals and objects as JSON text; `new Date([...])` parses a one-element array.
- **Breaks:** Garbage references on links merchants reconcile against, garbage key labels.
- **Fix:** Those fields must be strings (or absent/null); `expiresAt` must be a string.
- **Test:** `WF7` (two tests): old `201 !== 400`; fixed 400 and nothing stored.

## WF8. Hosted payment links point at localhost:5173 — Medium

**Where:** `ops/docker-compose.yml` (api `environment:`), `apps/api/src/config.ts:252`.
**Evidence:** the api without `CHECKOUT_BASE_URL` returns `"url":"http://localhost:5173/pay/plink_..."` for a new link; compose never set the variable.

- **What / Why:** The checkout base URL defaults to Vite's dev port.
- **Breaks:** Every link a merchant copies from the hosted dashboard is unusable for customers.
- **Fix:** Compose sets `CHECKOUT_BASE_URL: ${CHECKOUT_BASE_URL:-http://localhost:8080}` (the `web` service); the public hostname goes in `ops/.env` (documented in `.env.example`).
- **Test:** `docker compose config` renders `CHECKOUT_BASE_URL: http://localhost:8080` by default and the override when set.

## Reported, not fixed (other lanes)

- apps/admin has the same cross-origin problem as WF1 (`apps/admin/src/api/client.ts:3` defaults to `http://localhost:3000`, no Vite proxy, not in compose). Admin is teammate B's lane; the same proxy pattern applies.
- `GET /v1/admin/merchants?limit=abc` and the admin credits list parse `limit` the same way as WF5 (`apps/api/src/routes/adminMerchants.ts:105`, `adminCredits.ts:52`, `admin/merchants.ts:108`). **Checked, not a bug:** both routes already drop a non-finite `parseInt` result (`Number.isFinite(limit) ? limit : undefined`) since the files were added, so the list query gets the default page size, the same outcome as the WF5 fix. By request on a super_admin session: `limit=abc`, `limit=`, `limit=12abc`, `limit=-5`, `limit=1.5`, `limit=99999` and `limit=abc&limit=2` on `/v1/admin/merchants`, and `limit=abc`, `limit=`, `limit=-1`, `limit=abc&limit=2` on `/v1/admin/credits`, each 200. No change.
- Behind the new nginx proxy, `request.ip` (recorded on login sessions, `routes/auth.ts:95`) is the proxy's address; Fastify `trustProxy` would be needed to record the client. Auth lane.
- A KYC-approved merchant can PATCH `legalName`/`registrationNumber` without any re-review (`onboarding/businessProfile.ts`, documented as intentional). Worth a product decision; KYC lane.
