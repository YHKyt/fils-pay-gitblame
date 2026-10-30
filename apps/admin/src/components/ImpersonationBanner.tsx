import { useEffect, useState } from "react";
import { useAdminAuth } from "../auth/AdminAuthContext.js";
import { describeError } from "../api/client.js";
import { dateTime } from "../format.js";

/**
 * Shown on every admin screen for as long as an impersonation grant is
 * active. Impersonation is a real, privilege-adjacent state, so the
 * one thing this banner must never do is be easy to miss — it sits above
 * the nav, it is loud, and it carries its own one-click exit.
 *
 * The exit action calls `POST /v1/admin/impersonation/:grantId/end`, which
 * stamps `ended_at`, writes the closing audit row, and clears the
 * `fp_impersonation` cookie. Note what ending does *not* do: it does not
 * restore any admin privilege, because none was ever given up — `/v1/admin/*`
 * never reads anything impersonation-related. It closes the
 * merchant-read window and completes the audit trail.
 */
// MK: banner wording is accurate, impersonation is view-only
export function ImpersonationBanner() {
  const { impersonation, exitImpersonation } = useAdminAuth();
  const [exiting, setExiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!impersonation) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [impersonation]);

  if (!impersonation) return null;

  async function handleExit(): Promise<void> {
    setExiting(true);
    setError(null);
    try {
      await exitImpersonation();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setExiting(false);
    }
  }

  const label = impersonation.merchantDisplayName ?? `merchant ${impersonation.merchantId.slice(0, 8)}`;
  const remainingMs = new Date(impersonation.expiresAt).getTime() - now;
  const remaining = formatRemaining(remainingMs);

  return (
    <div className="impersonation-banner" role="alert">
      <div>
        <strong>Viewing as {label} (read-only).</strong>{" "}
        <span>
          {remainingMs > 0 ? (
            <>
              Ends in <strong className="impersonation-banner-countdown">{remaining}</strong>, at{" "}
              {dateTime(impersonation.expiresAt)} Bahrain time.
            </>
          ) : (
            <>This view-as session has ended. Exit to close it.</>
          )}
        </span>
        {error ? <div className="impersonation-banner-error">Could not end it: {error}</div> : null}
      </div>
      <button type="button" className="impersonation-banner-exit" onClick={() => void handleExit()} disabled={exiting}>
        {exiting ? "Exiting…" : "Exit view-as now"}
      </button>
    </div>
  );
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}
