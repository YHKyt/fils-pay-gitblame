import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useDashboardAuth } from "../auth/DashboardAuthContext.js";
import { RequireRole } from "../auth/RequireRole.js";
import { describeError } from "../api/client.js";
import "../dashboard.css";

/** Nav shell for every merchant dashboard screen. No impersonation banner
 *  here — nothing in the merchant plane impersonates anyone; when an admin
 *  "views as merchant", they arrive with a `support`-role session and see
 *  exactly what a support user sees. */
export function DashboardLayout() {
  const { me, signOut } = useDashboardAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  // sign out clears the cookie server side, local merchantId stays — am
  async function handleSignOut(): Promise<void> {
    setError(null);
    try {
      await signOut();
      navigate("/dashboard/login", { replace: true });
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <div className="dash-shell">
      <header className="dash-header">
        <div className="dash-brand">FilsPay</div>
        <nav className="dash-nav">
          <NavLink to="/dashboard/transactions">Transactions</NavLink>
          <NavLink to="/dashboard/payment-links">Payment links</NavLink>
          {/* Every webhook route — including the plain list read — is
              owner/finance-only server-side, so the link itself is
              hidden from support rather than offered and then refused. */}
          <RequireRole allow={["owner", "finance"]}>
            <NavLink to="/dashboard/webhooks">Webhooks</NavLink>
          </RequireRole>
          <NavLink to="/dashboard/settlement">Settlement</NavLink>
          <RequireRole allow={["owner", "finance"]}>
            <NavLink to="/dashboard/reconciliation">Reconciliation</NavLink>
          </RequireRole>
          <NavLink to="/dashboard/overview">Overview</NavLink>
        </nav>
        <div className="dash-identity">
          {me ? (
            <span>
              {me.email} <span className="dash-role-chip">{me.role}</span>
              <span className="dash-muted"> · {me.merchant.displayName}</span>
            </span>
          ) : null}
          <button type="button" className="dash-button" onClick={() => void handleSignOut()}>
            Log out
          </button>
        </div>
      </header>

      {error ? <p className="dash-error">{error}</p> : null}

      <main className="dash-main">
        <Outlet />
      </main>
      <footer className="dash-main dash-muted">All dates and times are Asia/Bahrain time (UTC+3).</footer>
    </div>
  );
}
