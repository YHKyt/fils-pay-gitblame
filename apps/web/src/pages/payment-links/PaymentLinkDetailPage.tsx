import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { cancelPaymentLink, getMerchantPaymentLink } from "../../api/paymentLinks.js";
import { ApiError, describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { bhd, dash, dateTime, statusLabel } from "../../format.js";
import { usePageTitle } from "../../hooks/usePageTitle.js";
import type { PaymentLinkDto } from "../../types.js";
import { canCancelPaymentLink, paymentLinkDisplayStatus } from "../../utils/paymentLinkStatus.js";

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; link: PaymentLinkDto };

/**
 * `GET /v1/merchants/:merchantId/payment-links/:id` — merchant-scoped,
 * one row. A `404` means "doesn't exist or isn't yours", deliberately
 * indistinguishable.
 */
export function PaymentLinkDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useDashboardAuth();
  const merchantId = me?.merchant.id;

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  usePageTitle(state.kind === "loaded" ? `Payment link ${state.link.reference ?? bhd(state.link.amountFils)}` : "Payment link");
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);

  const load = useCallback(async () => {
    if (!merchantId || !id) return;
    try {
      const link = await getMerchantPaymentLink(merchantId, id);
      setState({ kind: "loaded", link });
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 404) {
        setState({ kind: "not_found" });
      } else {
        setState({ kind: "error", message: describeError(err) });
      }
    }
  }, [merchantId, id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCancel(): Promise<void> {
    if (!merchantId || !id) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await cancelPaymentLink(merchantId, id);
      setCancelConfirm(false);
      await load();
    } catch (err) {
      // Includes `409 not_cancelable` for a link that is paid, already
      // canceled, or `reserved` mid-payment-attempt.
      setCancelConfirm(false);
      setActionError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCopy(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // No clipboard permission (or no secure context) — the URL is already
      // on screen and selectable, so there is nothing to recover from.
      setCopied(false);
    }
  }

  if (state.kind === "loading") return <p className="dash-loading">Loading…</p>;
  if (state.kind === "error") {
    return (
      <section>
        <h1>Payment link</h1>
        <p className="dash-error">{state.message}</p>
      </section>
    );
  }
  if (state.kind === "not_found") {
    return (
      <section>
        <h1>Payment link not found</h1>
        <p>
          No payment link with this ID exists on your account.{" "}
          <Link to="/dashboard/payment-links">Back to payment links</Link>
        </p>
      </section>
    );
  }

  const { link } = state;
  // Stored 'active' past expires_at is expired (same rule as the API's
  // public read); expired links can't be paid, so Cancel is not offered.
  const displayStatus = paymentLinkDisplayStatus(link);

  return (
    <section>
      <div className="dash-page-head">
        <div>
          <p className="dash-eyebrow">
            <Link to="/dashboard/payment-links">Payment links</Link> / Detail
          </p>
          <h1>Payment link</h1>
          <p className="dash-muted dash-id-line">
            <code>{link.id}</code>
          </p>
        </div>
        <span className={`dash-status dash-status-${displayStatus}`}>{statusLabel(displayStatus)}</span>
      </div>

      <dl className="dash-dl">
        <dt>Amount</dt>
        <dd>{bhd(link.amountFils)}</dd>
        <dt>Currency</dt>
        <dd>{link.currency}</dd>
        <dt>Status</dt>
        <dd>
          <span className={`dash-status dash-status-${displayStatus}`}>{statusLabel(displayStatus)}</span>
        </dd>
        <dt>Reference</dt>
        <dd>{dash(link.reference)}</dd>
        <dt>Description</dt>
        <dd>{dash(link.description)}</dd>
        <dt>Expires at</dt>
        <dd>{dateTime(link.expiresAt)}</dd>
        <dt>Created at</dt>
        <dd>{dateTime(link.createdAt)}</dd>
        <dt>Paid at</dt>
        <dd>{dateTime(link.paidAt)}</dd>
        <dt>Canceled at</dt>
        <dd>{dateTime(link.canceledAt)}</dd>
        <dt>Transaction</dt>
        <dd>
          {link.transactionId ? (
            <Link to={`/dashboard/transactions/${link.transactionId}`}>
              <code>{link.transactionId}</code>
            </Link>
          ) : (
            "—"
          )}
        </dd>
        <dt>Checkout link</dt>
        <dd>
          {/* Linked to, never duplicated — /pay/:token is the one checkout
              implementation, and there is no preview of it embedded here. */}
          <a href={link.url} target="_blank" rel="noreferrer">
            {link.url}
          </a>{" "}
          <button type="button" className="dash-button" onClick={() => void handleCopy(link.url)}>
            {copied ? "Copied" : "Copy link"}
          </button>
        </dd>
      </dl>

      {actionError ? <p className="dash-error">{actionError}</p> : null}

      {canCancelPaymentLink(link) ? (
        <RequireRole allow={["owner", "finance"]}>
          <button
            type="button"
            className="dash-button dash-button-danger"
            disabled={submitting}
            onClick={() => setCancelConfirm(true)}
          >
            Cancel payment link
          </button>
        </RequireRole>
      ) : null}

      <ConfirmDialog
        open={cancelConfirm}
        title="Cancel this payment link"
        amount={bhd(link.amountFils)}
        message={
          <>
            Once canceled, {link.reference ? <strong>{link.reference}</strong> : "this link"} can no longer be
            paid. You can always create a new link.
          </>
        }
        confirmLabel="Cancel link"
        tone="danger"
        busy={submitting}
        onConfirm={() => void handleCancel()}
        onCancel={() => setCancelConfirm(false)}
      />
    </section>
  );
}
