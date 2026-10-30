import { Link, useLocation } from "react-router-dom";
import "./NotFoundPage.css";

/** Any address that matches no route. React Router would otherwise render its
 *  bare default error screen; this is a branded, calm way back. It lives at
 *  the very top of the route tree (above the auth provider) so it makes no
 *  auth calls — a mistyped URL must never trigger a session check. The link
 *  home points at the merchant login, the one public entry the dashboard has. */
export function NotFoundPage() {
  const { pathname } = useLocation();
  return (
    <main className="nf-root">
      <section className="nf-card">
        <p className="nf-code">404</p>
        <h1 className="nf-title">Page not found</h1>
        <p className="nf-message">
          This address doesn&apos;t match any page here. No payment or action was taken.
        </p>
        <p className="nf-path">{pathname}</p>
        <Link className="nf-link" to="/dashboard/login">
          Go to sign in
        </Link>
      </section>
    </main>
  );
}
