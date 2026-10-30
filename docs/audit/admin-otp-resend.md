# Admin OTP resend

## AR1. Admin login had no way to resend the one-time code — Low

**What.** The merchant login has `POST /v1/auth/otp/resend`; the admin login (`/v1/admin/auth`) had only `/login` and `/otp/verify`. An operator whose code was lost, mistyped past recognition or superseded saw `invalid_code` and the only way out was "Start over", which means typing the password again.

**Why.** `apps/api/src/routes/adminAuth.ts` was written as a copy of the merchant flow but the resend handler was never ported, and the admin console worked around it with a hint telling the operator to start over.

**Fix.** `POST /v1/admin/auth/otp/resend` mirrors the merchant handler line for line, against `admin_otp_challenges` and `admin_sessions` (no migration):

- needs the pending admin session cookie (the one `/otp/verify` uses); no cookie, an unknown token or an already verified session gives `401 no_pending_session`;
- the current challenge is read under a row lock inside the transaction; a resend less than 30 s after it was issued, or after it was consumed, gives `429 resend_too_soon`;
- the old challenge is consumed, a new one is issued with a fresh expiry, and the new row inherits `attempt_count`, so a resend never resets the guess budget;
- the code goes through `sendAdminOtpCode` and is returned as `devOtpCode` only when `otpDevExpose` is on, which `loadConfig` forces off when `NODE_ENV=production`.

The merchant resend writes no audit row, so neither does this one.

The admin console (`apps/admin/src/pages/login/LoginPage.tsx`) now shows a **Resend code** button next to **Start over**. On success it shows "A new code has been issued."; `resend_too_soon` is shown as "Please wait a moment before requesting another code."

**Test.** `apps/api/src/routes/adminOtpResend.new.test.ts` (real Postgres): resend gives 200 and a new code, the old code no longer verifies and the new one does; a resend inside 30 s gives 429 `resend_too_soon`; the guess count carries over; no session or a verified session gives 401; with `NODE_ENV=production` and `OTP_DEV_EXPOSE=true` the response carries no code. All five fail with 404 before the route exists and pass after.
