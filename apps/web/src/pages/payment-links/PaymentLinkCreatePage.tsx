import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { parseBhdToFils } from "@filspay/money";
import { createPaymentLink } from "../../api/paymentLinks.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { bhdDisplay, localDateTimeToIso } from "../../format.js";
import { usePageTitle } from "../../hooks/usePageTitle.js";

/**
 * `POST /v1/merchants/:merchantId/payment-links`, `owner`/`finance`
 * server-side.
 *
 * Amount is entered in fils — the platform's actual unit, and the same unit
 * the checkout page works in. No decimal-BHD input widget: a second
 * string-to-fils parser in the browser is exactly the kind of place a money
 * bug hides, and `parseBhdToFils` exists in @filspay/money for whenever a
 * phase genuinely wants that UI.
 *
 * The two client-side checks below mirror the server's own two real checks so
 * an obviously-bad value doesn't need a round trip. They are not the
 * validation: `400 invalid_amount` / `400 invalid_expiry` remain the real
 * answer and are rendered verbatim.
 */
export function PaymentLinkCreatePage() {
  usePageTitle("New payment link");
  const { me } = useDashboardAuth();
  const navigate = useNavigate();

  const [amountBhd, setAmountBhd] = useState("");
  const [reference, setReference] = useState("");
  const [description, setDescription] = useState("");
  // Default: one week from now, as Bahrain wall time for the
  // datetime-local input (the form labels it Bahrain time).
  const [expiresAt, setExpiresAt] = useState(() =>
    new Date(Date.now() + 3 * 3_600_000 + 7 * 86_400_000).toISOString().slice(0, 16),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A live preview of the parsed amount, so the operator sees exactly what
  // will be charged before submitting.
  let amountPreview: string | null = null;
  if (amountBhd.trim() !== "") {
    try {
      amountPreview = bhdDisplay(parseBhdToFils(amountBhd.trim()));
    } catch {
      amountPreview = null;
    }
  }

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!me) return;
    setError(null);

    // The amount is typed in BHD (3 decimals) and parsed to integer fils here;
    // the request payload stays integer fils, exactly as before.
    let amount: number;
    try {
      amount = parseBhdToFils(amountBhd.trim());
    } catch {
      setError("Enter an amount in BHD, up to 3 decimals (for example 25.500).");
      return;
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      setError("Enter an amount above 0.000 BHD.");
      return;
    }
    const expiresAtIso = localDateTimeToIso(expiresAt);
    if (!expiresAtIso) {
      setError("Choose an expiry date and time.");
      return;
    }
    if (new Date(expiresAtIso).getTime() <= Date.now()) {
      setError("Choose an expiry date and time in the future (Bahrain time).");
      return;
    }

    setSubmitting(true);
    try {
      const link = await createPaymentLink(me.merchant.id, {
        amountFils: amount,
        reference: reference.trim() || undefined,
        description: description.trim() || undefined,
        expiresAt: expiresAtIso,
      });
      navigate(`/dashboard/payment-links/${link.id}`, { replace: true });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      <h1>New payment link</h1>

      {error ? <p className="dash-error">{error}</p> : null}

      <div className="dash-create-grid">
      <form className="dash-form" onSubmit={(e) => void handleSubmit(e)}>
        <label>
          Amount
          <span className="dash-money-input">
            <input
              type="text"
              inputMode="decimal"
              required
              placeholder="0.000"
              value={amountBhd}
              onChange={(e) => setAmountBhd(e.target.value)}
              aria-describedby="amount-hint"
            />
            <span className="dash-money-suffix">BHD</span>
          </span>
        </label>
        <p id="amount-hint" className="dash-muted dash-hint">
          {amountPreview ? `Customer pays ${amountPreview}.` : "In Bahraini dinar, up to 3 decimals (for example 25.500)."}
        </p>
        <label>
          Reference (optional)
          <input type="text" value={reference} onChange={(e) => setReference(e.target.value)} />
        </label>
        <label>
          Description (optional)
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          Expires at (Bahrain time) *
          <input
            type="datetime-local"
            required
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
          <span className="dash-muted">Required. Defaults to 7 days from now; the customer can't pay after this.</span>
        </label>
        <button type="submit" className="dash-button dash-button-primary" disabled={submitting}>
          {submitting ? "Creating..." : "Create payment link"}
        </button>
      </form>

      <aside className="dash-preview-card" aria-label="What the customer will see">
        <p className="dash-stat-label">Customer will see</p>
        <p className="dash-preview-merchant">{me?.merchant.displayName ?? "Your business"}</p>
        <p className="dash-preview-amount">{amountPreview ?? "0.000 BHD"}</p>
        <p className="dash-muted">{description.trim() || "No description"}</p>
        {reference.trim() ? <p className="dash-muted">Reference: {reference.trim()}</p> : null}
        <p className="dash-muted dash-preview-expiry">
          {expiresAt ? `Link expires ${expiresAt.replace("T", " ")} (Bahrain time)` : "Choose an expiry"}
        </p>
      </aside>
      </div>

      <p>
        <Link to="/dashboard/payment-links">Back to payment links</Link>
      </p>
    </section>
  );
}
