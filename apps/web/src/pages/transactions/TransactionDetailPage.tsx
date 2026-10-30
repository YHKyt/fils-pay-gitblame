import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  captureTransaction,
  getTransaction,
  getTransactionEvents,
  voidTransaction,
} from "../../api/transactions.js";
import { ApiError, describeError } from "../../api/client.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd, dash, dateTime, statusLabel } from "../../format.js";
import type { TransactionDto, TransactionEventDto } from "../../types.js";
import { attemptFor, isDefinitiveFailure, type IdempotentAttempt } from "../../utils/idempotencyIntent.js";
import { RefundDrawer } from "./RefundDrawer.js";

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; txn: TransactionDto };

/**
 * `GET /v1/transactions/:id` plus its event timeline on the same page — one
 * feature, so one view, not two navigable routes.
 *
 * A `404` renders a plain "not found" state and never tries to distinguish
 * "doesn't exist" from "not yours": the API deliberately answers the same way
 * for both (a `403` would confirm a foreign transaction's existence), and
 * this page does not undo that by guessing.
 */
export function TransactionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [events, setEvents] = useState<TransactionEventDto[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureAmount, setCaptureAmount] = useState("");
  const captureAttempt = useRef<IdempotentAttempt | null>(null);

  const load = useCallback(async () => {
    if (!id) {
      setState({ kind: "not_found" });
      return;
    }
    try {
      // Two independent reads — the events route does its own merchant-scoped
      // existence check, so neither depends on the other's result.
      const [txn, timeline] = await Promise.all([getTransaction(id), getTransactionEvents(id)]);
      setState({ kind: "loaded", txn });
      setEvents(timeline);
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 404) {
        setState({ kind: "not_found" });
      } else {
        setState({ kind: "error", message: describeError(err) });
      }
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCapture(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!id || submitting) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const trimmed = captureAmount.trim();
      // Left blank, `amountFils` is omitted entirely and capture.ts captures
      // everything still outstanding — its own documented default. Computing
      // the remainder here would just be a second, staler copy of that rule.
      const input = trimmed === "" ? {} : { amountFils: Number(trimmed) };
      // One Idempotency-Key per capture intent (same rule as RefundDrawer):
      // a retry after a lost response or 5xx resends the same key, so the
      // server replays the first capture instead of capturing again. A
      // different amount, or any submit after a definitive answer, is a new
      // intent with a new key.
      const current = attemptFor(captureAttempt.current, JSON.stringify({ id, ...input }));
      captureAttempt.current = current;
      await captureTransaction(id, input, current.key);
      captureAttempt.current = null;
      setCaptureOpen(false);
      setCaptureAmount("");
      // Refetch rather than patch: a capture wrote a new transaction_events
      // row server-side, so the timeline is stale, not merely shorter.
      await load();
    } catch (err) {
      if (isDefinitiveFailure(err)) captureAttempt.current = null;
      setActionError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  /** Only offered while status is authorized. */
  async function handleVoid(): Promise<void> {
    // No key needed: void is idempotent by state server-side (void.ts
    // answers 200 for an already-voided row), so a retry is always safe.
    if (!id || submitting) return;
    if (!window.confirm("Void this authorization? The held funds are released and cannot be captured afterwards.")) {
      return;
    }
    setSubmitting(true);
    setActionError(null);
    try {
      // An already-voided transaction also answers `200` with the voided row —
      // indistinguishable from a first void on the wire, and correctly so:
      // both mean "now voided".
      await voidTransaction(id);
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (state.kind === "loading") {
    return <p className="dash-loading">Loading…</p>;
  }
  if (state.kind === "not_found") {
    return (
      <section>
        <h1>Transaction not found</h1>
        <p>
          No transaction with this id exists on your account.{" "}
          <Link to="/dashboard/transactions">Back to transactions</Link>
        </p>
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <section>
        <h1>Transaction</h1>
        <p className="dash-error">{state.message}</p>
      </section>
    );
  }

  const { txn } = state;
  const capturable = txn.status === "authorized" || txn.status === "partially_captured";
  const voidable = txn.status === "authorized";

  return (
    <section>
      <div className="dash-page-head">
        <div>
          <p className="dash-eyebrow">
            <Link to="/dashboard/transactions">Transactions</Link> / Detail
          </p>
          <h1>Transaction</h1>
          <p className="dash-muted dash-id-line">
            <code>{txn.id}</code>
          </p>
        </div>
        <span className={`dash-status dash-status-${txn.status}`}>{statusLabel(txn.status)}</span>
      </div>

      <div className="dash-split">
        <div className="dash-split-main">
      <dl className="dash-dl dash-dl-stack">
        <dt>Status</dt>
        <dd>
          <span className={`dash-status dash-status-${txn.status}`}>{statusLabel(txn.status)}</span>
        </dd>
        <dt>Authorized amount</dt>
        <dd>{bhd(txn.amountFils)}</dd>
        <dt>Captured amount</dt>
        <dd>{bhd(txn.capturedFils)}</dd>
        <dt>Refunded amount</dt>
        <dd>{bhd(txn.refundedFils)}</dd>
        <dt>Currency</dt>
        <dd>{txn.currency}</dd>
        <dt>Reference</dt>
        <dd>{dash(txn.reference)}</dd>
        <dt>Acquirer reference</dt>
        <dd>
          <code>{txn.acquirerReference}</code>
        </dd>
        <dt>Occurred at</dt>
        <dd>{dateTime(txn.occurredAt)}</dd>
        <dt>Created at</dt>
        <dd>{dateTime(txn.createdAt)}</dd>
      </dl>

      {/* Capture and void are hidden from `support`: a support agent looks
          things up, they don't move money. The API enforces the same rule
          (requireMerchantRole("owner", "finance")); this hide is UX only. */}
      <RequireRole allow={["owner", "finance"]}>
        {capturable || voidable ? (
          <div className="dash-actions">
            {actionError ? <p className="dash-error">{actionError}</p> : null}

            {capturable ? (
              captureOpen ? (
                <form className="dash-form dash-form-inline" onSubmit={(e) => void handleCapture(e)}>
                  <label>
                    Amount in fils (blank captures everything outstanding)
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={captureAmount}
                      onChange={(e) => setCaptureAmount(e.target.value)}
                    />
                  </label>
                  <button type="submit" className="dash-button dash-button-primary" disabled={submitting}>
                    {submitting ? "Capturing..." : "Capture"}
                  </button>
                  <button
                    type="button"
                    className="dash-button"
                    disabled={submitting}
                    onClick={() => setCaptureOpen(false)}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <button type="button" className="dash-button" onClick={() => setCaptureOpen(true)}>
                  Capture
                </button>
              )
            ) : null}

            {voidable ? (
              <button
                type="button"
                className="dash-button dash-button-danger"
                disabled={submitting}
                onClick={() => void handleVoid()}
              >
                Void
              </button>
            ) : null}
          </div>
        ) : null}
      </RequireRole>

      <RefundDrawer txn={txn} onRefunded={load} />
        </div>

        <div className="dash-split-side">
      <h2>Event timeline</h2>
      <div className="dash-tablewrap"><table className="dash-table">
        <thead>
          <tr>
            <th>Occurred</th>
            <th>Event</th>
            <th className="dash-num">Amount</th>
            <th>Actor</th>
          </tr>
        </thead>
        <tbody>
          {/* Already ordered oldest-first by the endpoint — never re-sorted
              here, so the page can't disagree with the API about history. */}
          {events.map((event) => (
            <tr key={event.id}>
              <td>{dateTime(event.occurredAt)}</td>
              <td>{event.eventType}</td>
              <td className="dash-num">{event.amountFils === null ? "—" : bhd(event.amountFils)}</td>
              <td>
                {event.actorType}
                {event.actorId ? (
                  <div className="dash-muted">
                    <code>{event.actorId}</code>
                  </div>
                ) : null}
              </td>
            </tr>
          ))}
          {events.length === 0 ? (
            <tr>
              <td colSpan={4}>No events recorded.</td>
            </tr>
          ) : null}
        </tbody>
      </table></div>

        </div>
      </div>
    </section>
  );
}
