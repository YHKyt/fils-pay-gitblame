import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAdminAuth } from "../auth/AdminAuthContext.js";
import { WEB_BASE_URL } from "../api/client.js";
import { enumLabel } from "../format.js";
import { ImpersonationBanner } from "./ImpersonationBanner.js";
import { Brand } from "./Brand.js";
import { ThemeToggle } from "./ThemeToggle.js";

/** Nav shell for every admin-plane screen: who you are signed in as, the
 *  section links, a logout, and — above all of it — the impersonation
 *  banner when a grant is live. */
// YA: nav order per Huda's request (Credits first)
export function AdminLayout() {
  const { admin, signOut, impersonation, exitImpersonation } = useAdminAuth();
  const navigate = useNavigate();

  // signOut drops local state even when the API call fails (its finally),
  // so always leave for the login screen rather than strand the operator on
  // a console whose session state is already gone.
  async function handleSignOut(): Promise<void> {
    try {
      await signOut();
    } catch (err) {
      console.warn("admin logout request failed; local session cleared anyway", err);
    }
    navigate("/login", { replace: true });
  }

  return (
    <div className="admin-shell">
      {/* Banner and header stick together, so the header never slides
          under the banner. */}
      <div className="admin-topstack">
      <ImpersonationBanner />

      <header className="admin-header">
        <Brand />
        <div className="admin-identity">
          {admin ? (
            <span className="admin-identity-email">
              {admin.email} <span className="admin-role-chip">{enumLabel(admin.role)}</span>
            </span>
          ) : null}
          <ThemeToggle />
          <button type="button" onClick={() => void handleSignOut()}>
            Log out
          </button>
        </div>
      </header>
      </div>

      <div className="admin-body">
        <aside className="admin-sidebar">
          <nav
            className={impersonation ? "admin-nav is-paused" : "admin-nav"}
            aria-disabled={impersonation ? true : undefined}
          >
            <NavLink to="/merchants">Merchants</NavLink>
            <NavLink to="/credits">Credits</NavLink>
            <NavLink to="/settlement">Settlement ops</NavLink>
            <NavLink to="/adjustment-imports">Import adjustments</NavLink>
            <NavLink to="/webhooks">Webhook replay</NavLink>
          </nav>
        </aside>

        {impersonation ? (
          // An explicit "exit view-as-merchant" action is required before
          // admin-plane screens are shown again. This is a UX safeguard so the
          // two modes are never confused on screen; the privilege boundary
          // itself does not depend on it — /v1/admin/* never reads the
          // impersonation cookie, and the merchant side never reads the admin
          // session cookie.
          <main className="admin-main">
            <h1>Admin screens are paused</h1>
            <p>
              You are viewing {impersonation.merchantDisplayName ?? "a merchant"} as a merchant. End
              that session to return to the admin console.
            </p>
            <p>
              <button
                type="button"
                className="admin-btn-primary"
                onClick={() => {
                  void exitImpersonation().catch(() => undefined);
                }}
              >
                Exit view-as and return to admin
              </button>{" "}
              <a href={WEB_BASE_URL} target="_blank" rel="noreferrer">
                Open merchant dashboard
              </a>
            </p>
          </main>
        ) : (
          <main className="admin-main">
            <Outlet />
          </main>
        )}
      </div>
      <footer className="admin-footer">All dates and times are Asia/Bahrain time (UTC+3).</footer>
    </div>
  );
}
