import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { login, resendOtp, verifyOtp } from "../../api/auth.js";
import { describeError } from "../../api/client.js";
import { time } from "../../format.js";
import { Brand } from "../../components/Brand.js";
import { safeReturnPath } from "../../utils/safeReturnPath.js";
import { useAdminAuth } from "../../auth/AdminAuthContext.js";
import type { AdminLoginResponse } from "../../types.js";

type Step =
  | { kind: "credentials" }
  | { kind: "otp"; challenge: AdminLoginResponse };

/**
 * Two-step admin login: email + password creates a *pending* session
 * and issues an OTP challenge; the OTP step is what actually authenticates
 * it. Neither step is told which half of a bad credential pair was wrong —
 * the API answers a single generic `invalid_credentials`, and this screen
 * repeats it verbatim rather than guessing at something more specific.
 */
export function LoginPage() {
  const { status, refresh } = useAdminAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [step, setStep] = useState<Step>({ kind: "credentials" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const redirectTo = safeReturnPath((location.state as { from?: unknown } | null)?.from, "/merchants");

  if (status === "authenticated") {
    return <Navigate to={redirectTo} replace />;
  }

  async function handleCredentials(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const challenge = await login({ email, password });
      setStep({ kind: "otp", challenge });
      setPassword("");
    } catch (err) {
      setError(describeError(err));
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
      setNotice("A new code has been issued.");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  // YA: admin verify re-issues the cookie with the full TTL
  async function handleOtp(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      await verifyOtp({ code });
      // The session cookie is now authenticated server-side; re-read `me`
      // so the rest of the console renders from the server's answer, not
      // from the verify response we happen to be holding.
      await refresh();
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="admin-centered">
      <Brand />
      <p className="admin-login-tagline">Pearl of the Gulf · operations console</p>
      <p className="admin-muted">
        {step.kind === "credentials"
          ? "Sign in with your admin credentials. A one-time code follows."
          : "Enter the one-time code to finish signing in."}
      </p>

      {error ? <p className="admin-error">{error}</p> : null}
      {notice && !error ? <p className="admin-notice">{notice}</p> : null}

      {step.kind === "credentials" ? (
        <form onSubmit={(e) => void handleCredentials(e)} className="admin-form">
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
          <button type="submit" disabled={submitting}>
            {submitting ? "Signing in..." : "Continue"}
          </button>
        </form>
      ) : (
        <form onSubmit={(e) => void handleOtp(e)} className="admin-form">
          <p>
            A one-time code was issued for <strong>{email}</strong>. It expires at{" "}
            {time(step.challenge.otpExpiresAt)} (Bahrain time).
          </p>
          {step.challenge.devOtpCode ? (
            <p className="admin-muted">
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
          <div className="admin-login-actions">
            <button type="submit" disabled={submitting}>
              {submitting ? "Verifying..." : "Verify"}
            </button>
            <button
              type="button"
              className="admin-btn-ghost"
              disabled={submitting}
              onClick={() => void handleResend()}
            >
              Resend code
            </button>
            <button
              type="button"
              className="admin-btn-ghost"
              onClick={() => {
                setStep({ kind: "credentials" });
                setCode("");
                setError(null);
                setNotice(null);
              }}
            >
              Start over
            </button>
          </div>
          <p className="admin-muted admin-login-hint">
            Didn&apos;t receive a code? Use <strong>Resend code</strong> to get a new one, or{" "}
            <strong>Start over</strong> to sign in again.
          </p>
        </form>
      )}
    </main>
  );
}
