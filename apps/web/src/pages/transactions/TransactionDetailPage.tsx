import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { parseBhdToFils } from "@filspay/money";
import {
  captureTransaction,
  getTransaction,
  getTransactionEvents,
  voidTransaction,
} from "../../api/transactions.js";
import { ApiError, describeError } from "../../api/client.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { CopyId } from "../../components/CopyId.js";
import { actorDisplay, bhdDisplay, dash, dateTime, eventLabel, shortId, statusLabel, truncateMiddle } from "../../format.js";
import { usePageTitle } from "../../hooks/usePageTitle.js";
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
  usePageTitle(state.kind === "loaded" ? `Payment ${state.txn.reference ?? bhdDisplay(state.txn.amountFils)}` : "Payment");
  const [events, setEvents] = useState<TransactionEventDto[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureAmount, setCaptureAmount] = useState("");
  const [captureConfirm, setCaptureConfirm] = useState(false);
  const [voidConfirm, setVoidConfirm] = useState(false);
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

  // Parse the BHD-entered capture amount to integer fils. Blank = capture
  // everything outstanding. Payload stays integer fils, so nothing about the
  // money path changes — only the unit typed.
  function parseCaptureFils(): { fils: number | null; error: string | null } {
    const trimmed = captureAmount.trim();
    if (trimmed === "") return { fils: null, error: null };
    let fils: number;
    try {
      fils = parseBhdToFils(trimmed);
    } catch {
      return { fils: null, error: "Enter an amount in BHD, up to 3 decimals (for example 12.500)." };
    }
    if (fils <= 0) return { fils: null, error: "Enter an amount above 0.000 BHD." };
    return { fils, error: null };
  }

  function reviewCapture(event: React.FormEvent): void {
    event.preventDefault();
    const { error } = parseCaptureFils();
    if (error) {
      setActionError(error);
      return;
    }
    setActionError(null);
    setCaptureConfirm(true);
  }

  async function handleCapture(): Promise<void> {
    if (!id || submitting) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const { fils } = parseCaptureFils();
      // Left blank, `amountFils` is omitted entirely and capture.ts captures
      // everything still outstanding — its own documented default. Computing
      // the remainder here would just be a second, staler copy of that rule.
      const input = fils === null ? {} : { amountFils: fils };
      // One Idempotency-Key per capture intent (same rule as RefundDrawer):
      // a retry after a lost response or 5xx resends the same key, so the
      // server replays the first capture instead of capturing again. A
      // different amount, or any submit after a definitive answer, is a new
      // intent with a new key.
      const current = attemptFor(captureAttempt.current, JSON.stringify({ id, ...input }));
      captureAttempt.current = current;
      await captureTransaction(id, input, current.key);
      captureAttempt.current = null;
      setCaptureConfirm(false);
      setCaptureOpen(false);
      setCaptureAmount("");
      // Refetch rather than patch: a capture wrote a new transaction_events
      // row server-side, so the timeline is stale, not merely shorter.
      await load();
    } catch (err) {
      if (isDefinitiveFailure(err)) captureAttempt.current = null;
      setCaptureConfirm(false);
      setActionError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  /** Only offered while status is authorized. The confirm step is the
   *  ConfirmDialog opened by `voidConfirm`; no key needed because void is
   *  idempotent by state server-side (an already-voided row answers 200). */
  async function handleVoid(): Promise<void> {
    if (!id || submitting) return;
    setSubmitting(true);
    setActionError(null);
    try {
      // An already-voided transaction also answers `200` with the voided row —
      // indistinguishable from a first void on the wire, and correctly so:
      // both mean "now voided".
      await voidTransaction(id);
      setVoidConfirm(false);
      await load();
    } catch (err) {
      setVoidConfirm(false);
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
          <h1>
            {bhdDisplay(txn.amountFils)}
            {txn.reference ? <span className="dash-h1-sub"> · {txn.reference}</span> : null}
          </h1>
          <p className="dash-muted dash-id-line">
            <CopyId display={`Ref ${shortId(txn.id)}`} value={txn.id} label="Transaction ID" />
          </p>
        </div>
        <span className={`dash-status dash-status-${txn.status}`}>{statusLabel(txn.status)}</span>
      </div>

      <div className="dash-split">
        <div className="dash-split-main">
      <dl className="dash-dl dash-dl-stack dash-facts">
        <div>
          <dt>Authorized</dt>
          <dd className="dash-num-left">{bhdDisplay(txn.amountFils)}</dd>
        </div>
        <div>
          <dt>Captured</dt>
          <dd className="dash-num-left">{bhdDisplay(txn.capturedFils)}</dd>
        </div>
        <div>
          <dt>Refunded</dt>
          <dd className="dash-num-left">{bhdDisplay(txn.refundedFils)}</dd>
        </div>
        <div>
          <dt>Currency</dt>
          <dd>{txn.currency}</dd>
        </div>
        <div className="dash-facts-wide">
          <dt>Reference</dt>
          <dd>{dash(txn.reference)}</dd>
        </div>
        <div className="dash-facts-wide">
          <dt>Acquirer reference</dt>
          <dd>
            <CopyId display={truncateMiddle(txn.acquirerReference)} value={txn.acquirerReference} label="Acquirer reference" />
          </dd>
        </div>
        <div>
          <dt>Occurred</dt>
          <dd>{dateTime(txn.occurredAt)}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{dateTime(txn.createdAt)}</dd>
        </div>
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
                <form className="dash-form dash-form-inline" onSubmit={reviewCapture}>
                  <label>
                    Capture amount
                    <span className="dash-money-input">
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder={bhdDisplay(txn.amountFils - txn.capturedFils).replace(" BHD", "")}
                        value={captureAmount}
                        onChange={(e) => setCaptureAmount(e.target.value)}
                      />
                      <span className="dash-money-suffix">BHD</span>
                    </span>
                  </label>
                  <button type="submit" className="dash-button dash-button-primary">
                    Review capture
                  </button>
                  <button
                    type="button"
                    className="dash-button"
                    onClick={() => {
                      setCaptureOpen(false);
                      setActionError(null);
                    }}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <button type="button" className="dash-button dash-button-primary" onClick={() => setCaptureOpen(true)}>
                  Capture
                </button>
              )
            ) : null}

            {voidable ? (
              <button
                type="button"
                className="dash-button dash-button-danger"
                disabled={submitting}
                onClick={() => setVoidConfirm(true)}
              >
                Void authorization
              </button>
            ) : null}
          </div>
        ) : null}

        <ConfirmDialog
          open={captureConfirm}
          title="Capture this payment"
          amount={bhdDisplay(parseCaptureFils().fils ?? txn.amountFils - txn.capturedFils)}
          message={
            <>
              This captures{" "}
              <strong>{bhdDisplay(parseCaptureFils().fils ?? txn.amountFils - txn.capturedFils)}</strong> from the
              authorized amount. The customer's card is charged.
            </>
          }
          confirmLabel="Capture"
          tone="primary"
          busy={submitting}
          onConfirm={() => void handleCapture()}
          onCancel={() => setCaptureConfirm(false)}
        />
        <ConfirmDialog
          open={voidConfirm}
          title="Void this authorization"
          message="The hold on the customer's card is released and the payment can't be captured afterwards."
          confirmLabel="Void authorization"
          tone="danger"
          busy={submitting}
          onConfirm={() => void handleVoid()}
          onCancel={() => setVoidConfirm(false)}
        />
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
              <td>{eventLabel(event.eventType)}</td>
              <td className="dash-num">{event.amountFils === null ? "—" : bhdDisplay(event.amountFils)}</td>
              <td title={event.actorId && event.actorType !== "system" ? event.actorId : undefined}>
                {actorDisplay(event.actorType, event.actorId)}
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
