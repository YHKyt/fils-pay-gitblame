import { useCallback, useEffect, useState } from "react";
import { getReconciliation } from "../../api/settlement.js";
import { ApiError, describeError } from "../../api/client.js";
import { bhd } from "../../format.js";
import type { ReconciliationReport } from "../../types.js";

/**
 * `from`/`to` are required by this endpoint (`400 invalid_request` without
 * them), so the page arrives with a filled-in window rather than an empty form
 * that would 400 on first load. `to` is exclusive.
 *
 * The window is anchored to the Asia/Bahrain calendar date, not the viewer's
 * own, because that is the business day `settlement_batches.batch_date` is
 * keyed on — a browser in another timezone would otherwise default to a
 * window off by a day from the batches it's reconciling. Bahrain has observed
 * no DST since 1972, so a fixed +3h shift is exact; this is the same technique
 * apps/api's own analytics route uses.
 */
const BAHRAIN_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

function defaultRange(): { from: string; to: string } {
  const nowBahrain = Date.now() + BAHRAIN_OFFSET_MS;
  const day = (offsetDays: number): string =>
    new Date(nowBahrain + offsetDays * DAY_MS).toISOString().slice(0, 10);
  return { from: day(-30), to: day(1) };
}

// FH: 'explained: false' only shows when settlement is mid-run, a refresh fixes it
// YA: gap != 0 is real when a fee schedule changes mid-period
export function ReconciliationPage() {
  const initial = defaultRange();
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [applied, setApplied] = useState(initial);
  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      setReport(await getReconciliation(applied));
    } catch (err) {
      // The one page-specific error branch in this dashboard, because this is
      // the one merchant endpoint with a role gate narrower than "any
      // authenticated merchant user". A `support` user who typed or bookmarked
      // this URL gets a plain explanation — not a crash, not a blank
      // loading-forever state, and no retry.
      if (err instanceof ApiError && err.statusCode === 403) {
        setForbidden(true);
        setReport(null);
      } else {
        setError(describeError(err));
      }
    } finally {
      setLoading(false);
    }
  }, [applied]);

  useEffect(() => {
    void load();
  }, [load]);

  if (forbidden) {
    return (
      <section>
        <h1>Reconciliation</h1>
        <p className="dash-error">
          You don&apos;t have permission to view this report — ask an owner or
          finance user on your account.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h1>Reconciliation</h1>

      <form
        className="dash-form dash-form-inline"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied({ from, to });
        }}
      >
        <label>
          From
          <input type="date" required value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To (exclusive)
          <input type="date" required value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button type="submit" className="dash-button" disabled={loading}>
          {loading ? "Loading..." : "Run report"}
        </button>
      </form>

      {error ? <p className="dash-error">{error}</p> : null}

      {report ? (
        <>
          {/* A nonzero gap is shown as a nonzero gap. This page never rounds
              it away, hides it behind a tolerance, or explains it as expected —
              the endpoint reports honestly and so does this. */}
          <p>
            {report.explained ? (
              <span className="dash-badge dash-badge-ok">Reconciled — no gap</span>
            ) : (
              <span className="dash-badge dash-badge-gap">Gap: {bhd(report.gapFils)}</span>
            )}
          </p>

          <dl className="dash-dl">
            <dt>Period</dt>
            <dd>
              {report.periodFrom} to {report.periodTo} (exclusive)
            </dd>
            <dt>Ledger merchant payable (net)</dt>
            <dd>{bhd(report.ledgerMerchantPayableNetFils)}</dd>
            <dt>Settlement net payout</dt>
            <dd>{bhd(report.settlementNetPayoutFils)}</dd>
            <dt>Pending, not yet batched</dt>
            <dd>{bhd(report.pendingUnbatchedFils)}</dd>
            <dt>Gap</dt>
            <dd>{bhd(report.gapFils)}</dd>
          </dl>

          <p className="dash-muted">
            Gap = ledger merchant payable − settlement net payout − pending
            unbatched. A zero gap means every captured fil is accounted for in
            either a settled batch or the pending queue.
          </p>
        </>
      ) : null}

      {loading && !report ? <p className="dash-loading">Loading…</p> : null}
    </section>
  );
}
