import { useState } from "react";
import { ApiError, describeError, request } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd } from "../../format.js";
import type { TransactionDto } from "../../types.js";

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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per refund *intent*, not per click: a double-click or a retry
  // after a timeout replays the same refund instead of issuing a second one.
  // Rotated only once the server has given a definitive answer.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const merchantId = me?.merchant.id;
  const remainingFils = txn.capturedFils - txn.refundedFils;
  if (!REFUNDABLE_STATUSES.has(txn.status) || remainingFils <= 0) return null;

  async function handleRefund(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!merchantId || submitting) return;
    if (!window.confirm("Refund this transaction? The money goes back to the cardholder and cannot be recalled.")) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const trimmed = amount.trim();
      // Left blank, amountFils is omitted and the API refunds everything
      // still refundable.
      const body = trimmed === "" ? { transactionId: txn.id } : { transactionId: txn.id, amountFils: Number(trimmed) };

      await request<RefundResponse>(`/v1/merchants/${encodeURIComponent(merchantId)}/refunds`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(body),
      });

      setIdempotencyKey(crypto.randomUUID());
      setOpen(false);
      setAmount("");
      // Refetch rather than patch: the refund wrote a new transaction_events
      // row server-side, so the timeline is stale, not merely shorter.
      await onRefunded();
    } catch (err) {
      // A 4xx is a final answer for this key (a replay would return it
      // again), so the next attempt needs a fresh one. A network error or
      // 5xx keeps the key so the retry is deduplicated server-side.
      if (err instanceof ApiError && err.statusCode < 500) {
        setIdempotencyKey(crypto.randomUUID());
      }
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  function updateAmount(value: string): void {
    // Changing the amount is a different refund: it must not reuse the key
    // of an earlier attempt (the server would reject it as a reused key).
    setAmount(value);
    setIdempotencyKey(crypto.randomUUID());
  }

  return (
    <RequireRole allow={["owner", "finance"]}>
      <div className="dash-actions">
        {error ? <p className="dash-error">{error}</p> : null}
        {open ? (
          <form className="dash-form dash-form-inline" onSubmit={(e) => void handleRefund(e)}>
            <label>
              Amount in fils (blank refunds everything still refundable)
              <input
                type="number"
                min={1}
                step={1}
                max={remainingFils}
                value={amount}
                onChange={(e) => updateAmount(e.target.value)}
              />
            </label>
            <p className="dash-muted">
              Captured: {bhd(txn.capturedFils)} · Already refunded: {bhd(txn.refundedFils)} · Refundable:{" "}
              {bhd(remainingFils)}
            </p>
            <button type="submit" className="dash-button" disabled={submitting}>
              {submitting ? "Refunding..." : "Refund"}
            </button>
            <button type="button" className="dash-button" disabled={submitting} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" className="dash-button" onClick={() => setOpen(true)}>
            Refund
          </button>
        )}
      </div>
    </RequireRole>
  );
}
