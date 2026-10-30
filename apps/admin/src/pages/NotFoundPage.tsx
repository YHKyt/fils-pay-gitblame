import { Link } from "react-router-dom";

/** Any unknown admin URL: a way back instead of a blank page. */
export function NotFoundPage() {
  return (
    <section>
      <h1>Page not found</h1>
      <p className="admin-muted">This address doesn&apos;t match any page in the console.</p>
      <p>
        <Link to="/merchants">Go to Merchants</Link>
      </p>
    </section>
  );
}
