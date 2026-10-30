# ops/e2e — black-box judge suite

`judge-suite.mjs` drives a running FilsPay API over HTTP only, the way an
external automated test would: health, auth, API keys, payment links and
public checkout, expiry, refunds (partial, over-refund, idempotent replay,
concurrency), cross-merchant isolation, settlement close and integer-fils
checks on every money read, and optionally the web/admin bundles.

It needs Node 20+ and nothing else, except `pg` (already in the repo's
`node_modules`) when `DATABASE_URL` is used for OTP retrieval.

```
# local compose stack (ports as published by your compose override)
BASE_URL=http://127.0.0.1:3000 \
DATABASE_URL=postgres://filspay:filspay_dev_password@127.0.0.1:5432/filspay \
  node ops/e2e/judge-suite.mjs

# hosted instance: no DB access, OTPs typed in when prompted (TTY) or passed in
BASE_URL=https://<host> WEB_URL=https://<web-host> ADMIN_URL=https://<admin-host> \
  node ops/e2e/judge-suite.mjs
```

Exit code 0 means every check passed; each failure prints the status and
body it got.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `BASE_URL` | `http://localhost:3000` | API origin |
| `WEB_URL`, `ADMIN_URL` | unset (skipped) | origins serving the built web/admin bundles |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | seed `finance@filspay.test` | admin with `finance` or `super_admin` (settlement run-batch) |
| `MERCHANT_PASSWORD` | seed password | shared by both merchant owners |
| `MERCHANT_A_NAME` / `MERCHANT_A_EMAIL` | `Alpha Retail Co` / its owner | merchant under test |
| `MERCHANT_B_NAME` / `MERCHANT_B_EMAIL` | `Delta Wholesale Traders` / its owner | the "other" merchant for isolation checks |
| `MERCHANT_A_ID`, `MERCHANT_B_ID` | looked up via the admin plane | skip the lookup by name |
| `ADMIN_OTP`, `MERCHANT_OTP` | unset | an OTP read from the real channel |
| `DATABASE_URL` | unset | local stacks only, see below |
| `CARD_PAN` | `4000000000000010` | simulator card that is not a magic decline |
| `SUPPORT_ADMIN_EMAIL` | `support@filspay.test` | `support`-role admin for the role-check and read-only impersonation checks (skipped if it cannot log in) |
| `TEST_MERCHANT_NAME` | `Gamma Hospitality Group` | a `testMode` merchant that must never settle |
| `WEBHOOK_TEST_URL` | `https://example.com/filspay-judge-suite` | public https URL for the webhook endpoint; deliveries to it fail, but every attempt is recorded with its payload and signature |
| `ACQUIRER_CALLBACK_SIGNING_SECRET` | unset | local stacks only: enables the signed-callback half of FP-201 |
| `VERBOSE=1` | off | print every request and passing detail |

## OTP

Merchant and admin login are password + OTP, and with `NODE_ENV=production`
the API neither returns nor logs the code (there is no delivery channel in
this codebase). The suite takes a code from, in order: `devOtpCode` in the
login response (only when `OTP_DEV_EXPOSE=true`, never on a hosted box),
`ADMIN_OTP` / `MERCHANT_OTP`, `DATABASE_URL` (re-keys the pending challenge
row to a fresh random code, then submits that code over HTTP), or an
interactive prompt.

## Case-file checks

Four sections map one check (or a few) to each item of the case file; each
check name starts with its item:

- `case file: finance memo`: CSV import of 4.755 / 4.75 BD, balance
  rebuild vs cache (FP-203), fee shown vs fee charged, MDR recalculation
  never touches paid batches, test merchants never settle, Bahrain business
  day, login without OTP (pending session, reused code, attempt limit),
  cross-merchant link cancel.
- `case file: incident log`: concurrent pays of one link, acquirer callback
  signature and redelivery (FP-201), webhook endpoint secret (FP-240).
- `case file: FP-300 refunds end to end`: pro-rata fee reversal summing to
  the whole fee, timeline events, signed `refund.succeeded` webhook verified
  with the endpoint secret over the exact body, reports, analytics and
  reconciliation, one payout notification per batch.
- `case file: handwritten list`: refund above captured, split payouts,
  support-role and impersonation limits, API key rotation and revocation,
  reporting query timings, oversized upload.

Checks marked `(DB)` read Postgres directly and run only with `DATABASE_URL`
(there is no HTTP view of those rows); everything else is HTTP only.
`docs/audit/judgeprep.md` lists every check with its last local result.

## Notes

- The acquirer simulator fails about 2% of approved-card attempts at random
  (`ACQUIRER_FAILURE_RATE`, default 0.02). The suite retries a payment on a
  fresh link after a 402/502 so this does not show up as a flaky failure.
- The settlement check closes *yesterday* (Asia/Bahrain) for merchant A and
  expects `422 business_day_not_over` for today.
- The suite writes data (payment links, refunds, API keys); run it against
  a disposable or freshly seeded instance.

## Load and abuse tests (`load/`)

Used for `docs/audit/hostharden.md`; local stacks only (they need
`DATABASE_URL`, and they write thousands of links and payments).

- `load/checkout-sweep.mjs <public origin> <api loopback origin> <seconds> <users,...> [out.json]`:
  each user reads a payment link and pays it; after each step every payment
  is checked in the database. Prints checkouts/s, p50/p95/p99, errors.
- `load/abuse-probes.mjs <host> <port> [all|slow|body|flood]`: slowloris,
  oversized bodies on the public routes, and single-address floods of
  login, signup, pay, `/v1` and `/healthz`.
- `load/money-invariants.sql`: ledger balance, paid links without a
  capture, double captures, captures without ledger entries, refunds above
  captured, after a load or crash test.
