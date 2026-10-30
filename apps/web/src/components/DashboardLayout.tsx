import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useDashboardAuth } from "../auth/DashboardAuthContext.js";
import { RequireRole } from "../auth/RequireRole.js";
import { dateTime } from "../format.js";
import { Logo } from "./Logo.js";
import { ThemeToggle } from "./ThemeToggle.js";
import "../dashboard.css";

/** Nav shell for every merchant dashboard screen. When an admin "views as
 *  merchant", `me.impersonation` is set: a banner says so above everything,
 *  and every role-gated (write) control is hidden, since the API refuses
 *  all writes from a grant. */
export function DashboardLayout() {
  const { me, signOut } = useDashboardAuth();
  const navigate = useNavigate();
  const impersonation = me?.impersonation;

  // signOut never throws: local state is cleared even when the API call
  // fails, so the redirect always happens. (The remembered merchant id is
  // kept on purpose — it is a login convenience, not a credential.)
  async function handleSignOut(): Promise<void> {
    await signOut();
    navigate("/dashboard/login", { replace: true });
  }

  return (
    <div className="dash-shell">
      {impersonation ? (
        <div className="dash-impersonation-banner" role="alert">
          <strong>Admin view of {me?.merchant.displayName} (read only).</strong> This is an
          impersonation grant expiring {dateTime(impersonation.expiresAt)}. Nothing can be changed
          from here. End it with <strong>Exit impersonation</strong> in the admin console.
        </div>
      ) : null}
      <header className="dash-header">
        <div className="dash-brand">
          <Logo tone="light" />
        </div>
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
              {me.email ?? "Admin (view as merchant)"}{" "}
              <span className="dash-role-chip">{impersonation ? "read only" : me.role}</span>
              <span className="dash-muted"> · {me.merchant.displayName}</span>
            </span>
          ) : null}
          <button type="button" className="dash-button" onClick={() => void handleSignOut()}>
            Log out
          </button>
          <ThemeToggle />
        </div>
      </header>

      <main className="dash-main">
        <Outlet />
      </main>
      <footer className="dash-main dash-muted">All dates and times are Asia/Bahrain time (UTC+3).</footer>
    </div>
  );
}
