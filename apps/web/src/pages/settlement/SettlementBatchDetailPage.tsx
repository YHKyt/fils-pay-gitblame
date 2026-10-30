import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getSettlementBatch, getSettlementBatchTransactions } from "../../api/settlement.js";
import { ApiError, describeError } from "../../api/client.js";
import { bhdDisplay, dash, dateTime, humanDate, shortId, statusLabel } from "../../format.js";
import { usePageTitle } from "../../hooks/usePageTitle.js";
import type { SettlementBatchDetailDto, SettlementBatchTransactionDto } from "../../types.js";

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; batch: SettlementBatchDetailDto };

/**
 * `GET /v1/settlement/batches/:id` plus its line items.
 *
 * The two counts are rendered as two separately-labeled figures and never
 * added, averaged, or presented as one number: a transaction captured twice
 * inside the batch window contributes one scheme export line but two capture
 * events, so they can legitimately differ. Conflating them would invent a
 * discrepancy where there isn't one — or hide a real one.
 *
 * No pagination on the line items: the endpoint has none, and adding a
 * client-side cap would silently drop rows from a settlement figure.
 */
export function SettlementBatchDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [lines, setLines] = useState<SettlementBatchTransactionDto[]>([]);
  usePageTitle(state.kind === "loaded" ? `Settlement ${humanDate(state.batch.batchDate)}` : "Settlement");

  useEffect(() => {
    if (!id) {
      setState({ kind: "not_found" });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [batch, txns] = await Promise.all([
          getSettlementBatch(id),
          getSettlementBatchTransactions(id),
        ]);
        if (cancelled) return;
        setState({ kind: "loaded", batch });
        setLines(txns.transactions);
      } catch (err) {
        if (cancelled) return;
        // 404, not 403, for another merchant's batch — the same non-disclosure
        // choice the transaction detail read makes.
        if (err instanceof ApiError && err.statusCode === 404) {
          setState({ kind: "not_found" });
        } else {
          setState({ kind: "error", message: describeError(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (state.kind === "loading") return <p className="dash-loading">Loading…</p>;
  if (state.kind === "not_found") {
    return (
      <section>
        <h1>Settlement batch not found</h1>
        <p>
          No settlement batch with this id exists on your account.{" "}
          <Link to="/dashboard/settlement">Back to settlement batches</Link>
        </p>
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <section>
        <h1>Settlement batch</h1>
        <p className="dash-error">{state.message}</p>
      </section>
    );
  }

  const { batch } = state;

  return (
    <section>
      <div className="dash-page-head">
        <div>
          <p className="dash-eyebrow">
            <Link to="/dashboard/settlement">Settlements</Link> / Batch
          </p>
          <h1>
            Settlement {humanDate(batch.batchDate)} <span className="dash-ref-sub">{shortId(batch.id)}</span>
          </h1>
          <p className="dash-muted dash-id-line">
            <code title="Batch ID">{batch.id}</code>
          </p>
        </div>
        <span className={`dash-status dash-status-${batch.status}`}>{statusLabel(batch.status)}</span>
      </div>

      <dl className="dash-dl">
        <dt>Status</dt>
        <dd>
          <span className={`dash-status dash-status-${batch.status}`}>{statusLabel(batch.status)}</span>
        </dd>
        <dt>Gross</dt>
        <dd>{bhdDisplay(batch.grossFils)}</dd>
        <dt>Fee</dt>
        <dd>{bhdDisplay(batch.feeFils)}</dd>
        <dt>Refunds</dt>
        <dd className={(batch.refundDeductionFils ?? 0) > 0 ? "dash-refund" : undefined}>
          {(batch.refundDeductionFils ?? 0) > 0 ? bhdDisplay(-(batch.refundDeductionFils ?? 0)) : bhdDisplay(0)}
        </dd>
        {(batch.carriedInFils ?? 0) !== 0 && (
          <>
            <dt>Carried in</dt>
            <dd className="dash-refund">{bhdDisplay(batch.carriedInFils)}</dd>
          </>
        )}
        <dt>Net payout</dt>
        <dd>{bhdDisplay(batch.netPayoutFils)}</dd>
        <dt>How net is made</dt>
        <dd className="dash-muted">
          Gross − Fee − Refunds{(batch.carriedInFils ?? 0) !== 0 ? " + Carried in" : ""} = Net payout
        </dd>
        <dt>Closed at</dt>
        <dd>{dateTime(batch.closedAt)}</dd>
        <dt>Paid at</dt>
        <dd>{batch.paidAt ? dateTime(batch.paidAt) : "Not paid yet"}</dd>
        <dt>Included transactions</dt>
        <dd>{batch.includedTransactionCount}</dd>
        <dt>Payments in batch</dt>
        <dd>
          {batch.includedEventCount}
          {batch.includedEventCount !== batch.includedTransactionCount ? (
            <span className="dash-muted">
              {" "}
              — more events than transactions is normal: a transaction captured
              more than once in this window contributes one export line and
              several events.
            </span>
          ) : null}
        </dd>
      </dl>

      <h2>Included transactions</h2>
      <div className="dash-tablewrap"><table className="dash-table">
        <thead>
          <tr>
            <th className="dash-num">Line</th>
            <th>Payment</th>
            <th>Status</th>
            <th className="dash-num">Authorized</th>
            <th className="dash-num">Captured</th>
            <th className="dash-num" title="Card networks round to 2 decimals, so this can differ by up to 9 fils.">
              Scheme amount ⓘ
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={`${line.transactionId}-${line.lineSequence}`}>
              <td className="dash-num">{line.lineSequence}</td>
              <td>
                <Link className="dash-ref-main" to={`/dashboard/transactions/${line.transactionId}`}>
                  {line.reference ? dash(line.reference) : shortId(line.transactionId)}
                </Link>
                <span className="dash-ref-sub" title={line.transactionId}>
                  {shortId(line.transactionId)}
                </span>
              </td>
              <td>
                <span className={`dash-status dash-status-${line.status}`}>{statusLabel(line.status)}</span>
              </td>
              <td className="dash-num">{bhdDisplay(line.authorizedFils)}</td>
              <td className="dash-num">{bhdDisplay(line.capturedFils)}</td>
              <td className="dash-num">{bhdDisplay(line.schemeAmountFils)}</td>
            </tr>
          ))}
          {lines.length === 0 ? (
            <tr>
              <td colSpan={6}>No scheme export lines in this batch.</td>
            </tr>
          ) : null}
        </tbody>
      </table></div>
      <p className="dash-muted">
        Scheme amount: card networks round to 2 decimals, so it can be up to 9 fils below the captured amount.
      </p>

      <p>
        <Link to="/dashboard/settlement">Back to settlement batches</Link>
      </p>
    </section>
  );
}
