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
| `VERBOSE=1` | off | print every request and passing detail |

## OTP

Merchant and admin login are password + OTP, and with `NODE_ENV=production`
the API neither returns nor logs the code (there is no delivery channel in
this codebase). The suite takes a code from, in order: `devOtpCode` in the
login response (only when `OTP_DEV_EXPOSE=true`, never on a hosted box),
`ADMIN_OTP` / `MERCHANT_OTP`, `DATABASE_URL` (re-keys the pending challenge
row to a fresh random code, then submits that code over HTTP), or an
interactive prompt.

## Notes

- The acquirer simulator fails about 2% of approved-card attempts at random
  (`ACQUIRER_FAILURE_RATE`, default 0.02). The suite retries a payment on a
  fresh link after a 402/502 so this does not show up as a flaky failure.
- The settlement check closes *yesterday* (Asia/Bahrain) for merchant A and
  expects `422 business_day_not_over` for today.
- The suite writes data (payment links, refunds, API keys); run it against
  a disposable or freshly seeded instance.
