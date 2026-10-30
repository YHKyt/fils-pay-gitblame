import { useRef, useState } from "react";
import { parseBhdToFils } from "@filspay/money";
import { describeError, request } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhdDisplay } from "../../format.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import type { TransactionDto } from "../../types.js";
import { attemptFor, isDefinitiveFailure, type IdempotentAttempt } from "../../utils/idempotencyIntent.js";

interface RefundResponse {
  id: string;
  transactionId: string;
  amountFils: number;
  feeReversedFils: number;
  status: string;
  transactionStatus: string;
  refundedTotalFils: number;
  occurredAt: string;
}

interface RefundDrawerProps {
  txn: TransactionDto;
  onRefunded: () => Promise<void>;
}

/** Statuses the API's refundValidation accepts. */
const REFUNDABLE_STATUSES = new Set(["captured", "partially_captured", "partially_refunded"]);

/**
 * Full or partial refund of a captured transaction, via
 * `POST /v1/merchants/:merchantId/refunds`. The server is authoritative on
 * the amount (captured - refunded) and on role; this only mirrors both.
 */
export function RefundDrawer({ txn, onRefunded }: RefundDrawerProps) {
  const { me } = useDashboardAuth();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per refund *intent*, not per click or keystroke: a double-click
  // or a retry after a timeout replays the same refund instead of issuing a
  // second one. A new key only when the submitted amount differs from the
  // last attempt's, or after the server has given a definitive answer.
  const attempt = useRef<IdempotentAttempt | null>(null);

  const merchantId = me?.merchant.id;
  const remainingFils = txn.capturedFils - txn.refundedFils;
  if (!REFUNDABLE_STATUSES.has(txn.status) || remainingFils <= 0) return null;

  // Parse the BHD-entered amount (3 decimals) to integer fils. Blank = a full
  // refund of everything still refundable. The API payload stays integer fils,
  // so no money behaviour changes — only the unit the operator types in.
  function parseAmountFils(): { fils: number | null; error: string | null } {
    const trimmed = amount.trim();
    if (trimmed === "") return { fils: null, error: null };
    let fils: number;
    try {
      fils = parseBhdToFils(trimmed);
    } catch {
      return { fils: null, error: "Enter an amount in BHD, up to 3 decimals (for example 12.500)." };
    }
    if (fils <= 0) return { fils: null, error: "Enter a refund amount above 0.000 BHD." };
    if (fils > remainingFils) return { fils: null, error: `You can refund at most ${bhdDisplay(remainingFils)} on this payment.` };
    return { fils, error: null };
  }

  const parsed = parseAmountFils();
  const refundFils = parsed.fils ?? remainingFils;

  function reviewRefund(event: React.FormEvent): void {
    event.preventDefault();
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    setError(null);
    setConfirming(true);
  }

  async function doRefund(): Promise<void> {
    if (!merchantId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const body =
        parsed.fils === null
          ? { transactionId: txn.id }
          : { transactionId: txn.id, amountFils: parsed.fils };

      const payload = JSON.stringify(body);
      const current = attemptFor(attempt.current, payload);
      attempt.current = current;

      await request<RefundResponse>(`/v1/merchants/${encodeURIComponent(merchantId)}/refunds`, {
        method: "POST",
        headers: { "Idempotency-Key": current.key },
        body: payload,
      });

      attempt.current = null;
      setConfirming(false);
      setOpen(false);
      setAmount("");
      // Refetch rather than patch: the refund wrote a new transaction_events
      // row server-side, so the timeline is stale, not merely shorter.
      await onRefunded();
    } catch (err) {
      // A 4xx is a final answer for this key (a replay would return it
      // again), so the next attempt needs a fresh one. A network error or
      // 5xx keeps the key so the retry is deduplicated server-side.
      if (isDefinitiveFailure(err)) attempt.current = null;
      setConfirming(false);
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <RequireRole allow={["owner", "finance"]}>
      <div className="dash-actions">
        {error ? <p className="dash-error">{error}</p> : null}
        {open ? (
          <form className="dash-form dash-form-inline" onSubmit={reviewRefund}>
            <label>
              Refund amount
              <span className="dash-money-input">
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder={formatRefundable(remainingFils)}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  aria-describedby="refund-hint"
                />
                <span className="dash-money-suffix">BHD</span>
              </span>
            </label>
            <p id="refund-hint" className="dash-muted">
              Leave blank to refund the full {bhdDisplay(remainingFils)}. Captured {bhdDisplay(txn.capturedFils)} · Already
              refunded {bhdDisplay(txn.refundedFils)}.
            </p>
            <button type="submit" className="dash-button dash-button-danger">
              Review refund
            </button>
            <button
              type="button"
              className="dash-button"
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" className="dash-button dash-button-danger" onClick={() => setOpen(true)}>
            Refund
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirming}
        title="Refund to the cardholder"
        amount={bhdDisplay(refundFils)}
        message={
          <>
            This refunds <strong>{bhdDisplay(refundFils)}</strong> to the cardholder for{" "}
            {txn.reference ? <strong>{txn.reference}</strong> : "this payment"}. The money goes back to their
            card and can't be recalled.
          </>
        }
        confirmLabel={`Refund ${bhdDisplay(refundFils)}`}
        tone="danger"
        busy={submitting}
        onConfirm={() => void doRefund()}
        onCancel={() => setConfirming(false)}
      />
    </RequireRole>
  );
}

/** The refundable amount as a plain BHD number for the input placeholder
 *  (no "BHD" suffix, which the adornment already shows). */
function formatRefundable(fils: number): string {
  return bhdDisplay(fils).replace(" BHD", "");
}
