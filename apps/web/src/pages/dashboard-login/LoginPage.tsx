import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { login, resendOtp, verifyOtp } from "../../api/dashboardAuth.js";
import { ApiError, describeError } from "../../api/client.js";
import {
  readLastMerchantId,
  useDashboardAuth,
  writeLastMerchantId,
} from "../../auth/DashboardAuthContext.js";
import type { DashboardLoginResponse } from "../../types.js";
import { bahrainTime } from "../../format.js";
import { Logo } from "../../components/Logo.js";
import { safeReturnPath } from "../../utils/safeReturnPath.js";
import "../../dashboard.css";
import "./LoginPage.css";

type Step = { kind: "credentials" } | { kind: "otp"; challenge: DashboardLoginResponse };

/**
 * Two-step merchant login: merchantId + email + password
 * creates a *pending* session and issues an OTP challenge; the OTP step is
 * what actually authenticates it. Neither step is told which credential was
 * wrong — the API answers a single generic `invalid_credentials`, and this
 * screen repeats it verbatim rather than guessing at something more specific.
 *
 * The Merchant ID field is a raw pasted UUID. This is a genuine rough edge,
 * not a preference: `merchant_users.email` is unique per merchant rather than
 * globally (Phase 1 schema), so an email alone cannot identify a user, and no
 * merchant slug or subdomain concept exists anywhere in the platform to infer
 * the id from. `localStorage` remembering the last-used value is the whole
 * mitigation available without new backend work; a lookup-by-email endpoint
 * or a per-merchant subdomain would be the real fix, and both are out of
 * scope for a frontend-only phase.
 */
export function LoginPage() {
  const { status, refresh, sessionExpired, expiredEmail } = useDashboardAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [step, setStep] = useState<Step>({ kind: "credentials" });
  // MK: remembers the last merchantId in localStorage. not a secret
  const [merchantId, setMerchantId] = useState(() => readLastMerchantId());
  // Prefilled after a session expiry (memory only, never the password).
  const [email, setEmail] = useState(() => expiredEmail ?? "");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const redirectTo = safeReturnPath((location.state as { from?: unknown } | null)?.from, "/dashboard/overview");

  if (status === "authenticated") {
    return <Navigate to={redirectTo} replace />;
  }

  function backToCredentials(message: string | null): void {
    setStep({ kind: "credentials" });
    setCode("");
    setError(message);
  }

  async function handleCredentials(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const challenge = await login({ merchantId: merchantId.trim(), email, password });
      setStep({ kind: "otp", challenge });
      setPassword("");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  // after otp we get logged out after ~10 min. cookie ttl never extended? — am
  // MK: that's the idle timeout, by design
  async function handleOtp(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      await verifyOtp({ code });
      writeLastMerchantId(merchantId.trim());
      // The session cookie is now authenticated server-side; re-read `me` so
      // the rest of the dashboard renders from the server's answer, not from
      // the verify response we happen to be holding.
      await refresh();
      navigate(redirectTo, { replace: true });
    } catch (err) {
      // `429 too_many_attempts` revokes the pending session server-side, so
      // retrying the OTP step against it can only ever fail again — start
      // over instead of leaving the user tapping a dead form.
      if (err instanceof ApiError && err.statusCode === 429 && err.code === "too_many_attempts") {
        backToCredentials(describeError(err));
      } else {
        setError(describeError(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResend(): Promise<void> {
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const challenge = await resendOtp();
      setStep({ kind: "otp", challenge });
      setCode("");
      setNotice("A new code has been sent.");
    } catch (err) {
      // Includes `429 resend_too_soon` — the server owns the cadence rule, so
      // whatever it says is shown as-is rather than pre-empted by a
      // client-side timer that could drift from it.
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mlogin-root">
    <aside className="mlogin-brand">
      <div className="mlogin-brand-inner">
        <Logo tone="light" size={40} />
        <div className="mlogin-brand-copy">
          <p className="mlogin-kicker">Merchant dashboard</p>
          <p className="mlogin-headline">
            Payments, settled <em>in Bahrain.</em>
          </p>
          <ul className="mlogin-points">
            <li>
              <span className="mlogin-point-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" focusable="false">
                  <path d="M4 12.5l5 5L20 6.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span>Accept cards and payment links in BHD, to the fils.</span>
            </li>
            <li>
              <span className="mlogin-point-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" focusable="false">
                  <path d="M4 17l5-5 4 4 7-8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span>Daily settlement with every fee shown line by line.</span>
            </li>
            <li>
              <span className="mlogin-point-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" focusable="false">
                  <rect x="5" y="10.5" width="14" height="9.5" rx="2.2" stroke="currentColor" strokeWidth="2" />
                  <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" stroke="currentColor" strokeWidth="2" />
                </svg>
              </span>
              <span>Two-step sign-in protects every account.</span>
            </li>
          </ul>
        </div>
        <p className="mlogin-foot">FilsPay · Pearl of the Gulf</p>
      </div>
    </aside>
    <main className="mlogin-main">
    <div className="mlogin-card">
      <h1>{step.kind === "otp" ? "Check your code" : "Sign in"}</h1>
      <p className="dash-muted dash-login-tagline">
        {step.kind === "otp"
          ? "A one-time code keeps your account secure."
          : "Welcome back. Sign in to your FilsPay merchant account."}
      </p>

      {sessionExpired && step.kind === "credentials" && !error ? (
        <p className="dash-notice" role="status">
          Your session expired. Please sign in again.
        </p>
      ) : null}
      {error ? <p className="dash-error">{error}</p> : null}
      {notice ? <p className="dash-notice">{notice}</p> : null}

      {step.kind === "credentials" ? (
        <form onSubmit={(e) => void handleCredentials(e)} className="dash-form">
          <label>
            Business ID
            <input
              type="text"
              required
              autoComplete="off"
              spellCheck={false}
              value={merchantId}
              onChange={(e) => setMerchantId(e.target.value)}
            />
          </label>
          <p className="dash-muted dash-hint">
            Find it in your welcome email or ask your FilsPay contact. We
            remember it on this device after your first sign-in.
          </p>
          <label>
            Email
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button type="submit" className="dash-button dash-button-primary" disabled={submitting}>
            {submitting ? "Signing in..." : "Continue"}
          </button>
        </form>
      ) : (
        <form onSubmit={(e) => void handleOtp(e)} className="dash-form">
          <p>
            A one-time code was issued for <strong>{email}</strong>. It expires at{" "}
            {bahrainTime(step.challenge.otpExpiresAt)} (Bahrain time).
          </p>
          {step.challenge.devOtpCode ? (
            <p className="dash-muted">
              Development code: <code>{step.challenge.devOtpCode}</code>
            </p>
          ) : null}
          <label>
            One-time code
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <button type="submit" className="dash-button dash-button-primary" disabled={submitting}>
            {submitting ? "Verifying..." : "Verify"}
          </button>
          {/* Resend keeps the viewer from re-entering their password just to
              get a fresh code. The API owns the cadence rule (`resendOtp`),
              so this button simply asks for a new challenge. */}
          <div className="dash-resend-row">
            <span className="dash-muted">Didn't get the code?</span>
            <button
              type="button"
              className="dash-resend"
              disabled={submitting}
              onClick={() => void handleResend()}
            >
              Resend code
            </button>
          </div>
          <button type="button" className="dash-button dash-button-ghost" onClick={() => backToCredentials(null)}>
            Use a different account
          </button>
        </form>
      )}
    </div>
    </main>
    </div>
  );
}
