import { useState } from "react";
import { rebuildAnalytics, rebuildBalances, runBatch } from "../../api/settlement.js";
import { recalculateMdr } from "../../api/mdrRecalculation.js";
import { describeError } from "../../api/client.js";
import { bahrainDate, bhd } from "../../format.js";
import { ConfirmAction } from "../../components/ConfirmAction.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { StatusPill } from "../../components/StatusPill.js";
import { MerchantPicker, merchantLabel, useMerchantOptions } from "../../components/MerchantPicker.js";
import type {
  AnalyticsRebuildSummary,
  BalanceRebuildSummary,
  MdrRecalcSummary,
  RunBatchSummary,
} from "../../types.js";

/** The day after a YYYY-MM-DD date. The UI takes an inclusive "To"; the
 *  API's `to` is exclusive. */
function nextDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return new Date(d.getTime() + 86_400_000).toISOString().slice(0, 10);
}

/**
 * The two cross-process operations. Both are `finance` /
 * `super_admin` server-side; both write their audit row *before* the call
 * crosses the network, so an attempt is on record even if the settlement
 * service never answers.
 *
 * The analytics rebuild at the bottom is the same role gate and the same
 * confirm-before-you-run shape, but it never leaves apps/api — it is one
 * transaction of SQL, so its audit row is simply part of that transaction.
 */
export function SettlementPage() {
  const merchantOptions = useMerchantOptions();
  const nameOf = (id: string) => merchantLabel(merchantOptions.options, id);
  // Yesterday's Asia/Bahrain business day — the day a batch run is keyed on.
  const [date, setDate] = useState(() => bahrainDate(-1));
  const [merchantId, setMerchantId] = useState("");
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<RunBatchSummary | null>(null);

  const [confirmingRebuild, setConfirmingRebuild] = useState(false);
  const [rebuildBusy, setRebuildBusy] = useState(false);
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const [rebuildResult, setRebuildResult] = useState<BalanceRebuildSummary | null>(null);

  const [confirmingAnalytics, setConfirmingAnalytics] = useState(false);
  const [analyticsBusy, setAnalyticsBusy] = useState(false);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [analyticsResult, setAnalyticsResult] = useState<AnalyticsRebuildSummary | null>(null);

  const [mdrMerchantId, setMdrMerchantId] = useState("");
  const [mdrFrom, setMdrFrom] = useState("");
  const [mdrTo, setMdrTo] = useState("");
  const [mdrBusy, setMdrBusy] = useState(false);
  const [mdrError, setMdrError] = useState<string | null>(null);
  const [mdrResult, setMdrResult] = useState<MdrRecalcSummary | null>(null);
  const [confirmingRun, setConfirmingRun] = useState(false);
  const [confirmingMdr, setConfirmingMdr] = useState(false);

  /** Idempotent per business date: re-running returns the already-closed batches. */
  async function handleRunBatch(): Promise<void> {
    setRunBusy(true);
    setRunError(null);
    setRunResult(null);
    try {
      setRunResult(
        await runBatch({ date, merchantId: merchantId.trim() ? merchantId.trim() : undefined }),
      );
      setConfirmingRun(false);
    } catch (err) {
      setRunError(describeError(err));
    } finally {
      setRunBusy(false);
    }
  }

  // after clicking rebuild on staging alpha's balance jumped to like 3x?? — am
  // MK: staging data is junk. cache-only, safe to click
  async function handleRebuild(): Promise<void> {
    setRebuildBusy(true);
    setRebuildError(null);
    setRebuildResult(null);
    try {
      setRebuildResult(await rebuildBalances());
      setConfirmingRebuild(false);
    } catch (err) {
      setRebuildError(describeError(err));
    } finally {
      setRebuildBusy(false);
    }
  }

  async function handleRebuildAnalytics(): Promise<void> {
    setAnalyticsBusy(true);
    setAnalyticsError(null);
    setAnalyticsResult(null);
    try {
      setAnalyticsResult(await rebuildAnalytics());
      setConfirmingAnalytics(false);
    } catch (err) {
      setAnalyticsError(describeError(err));
    } finally {
      setAnalyticsBusy(false);
    }
  }

  // FH: ADMIN.md says this is safe
  async function handleRecalculateMdr(): Promise<void> {
    setMdrBusy(true);
    setMdrError(null);
    setMdrResult(null);
    try {
      setMdrResult(await recalculateMdr(mdrMerchantId.trim(), { from: mdrFrom, to: nextDay(mdrTo) }));
      setConfirmingMdr(false);
    } catch (err) {
      setMdrError(describeError(err));
    } finally {
      setMdrBusy(false);
    }
  }

  const runResults = runResult?.merchantResults ?? [];
  const mdrAdjusted = mdrResult?.adjusted ?? [];

  return (
    <section>
      <h1>Settlement ops</h1>
      <p className="admin-muted">
        These tools move or recalculate money. Finance admins only. Every run is recorded in the
        audit log.
      </p>

      <h2>Re-run a daily batch</h2>
      <p className="admin-muted">
        Closes and pays out the batch for one business date. Re-running a date that is already
        closed or paid is safe: nothing is paid twice.
      </p>

      {runError ? <p className="admin-error">{runError}</p> : null}

      <RequireRole
        allow={["finance", "super_admin"]}
        fallback={
          <p className="admin-muted">
            Your role cannot trigger settlement runs. Ask a finance admin.
          </p>
        }
      >
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            setRunError(null);
            setConfirmingRun(true);
          }}
        >
          <label>
            Business date
            <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
            Merchant
            <MerchantPicker
              value={merchantId}
              onChange={setMerchantId}
              {...merchantOptions}
              emptyLabel="All merchants"
            />
          </label>
          <button type="submit" disabled={runBusy}>
            {runBusy ? "Running…" : merchantId.trim() ? "Run batch" : "Run batch for all merchants"}
          </button>
        </form>
      </RequireRole>

      {runResult ? (
        <div className="admin-notice">
          <p>
            Batch run for <strong>{runResult.businessDate}</strong> — {runResults.length} merchant
            {runResults.length === 1 ? "" : "s"} processed.
          </p>
          {runResults.length > 0 ? (
            <div className="admin-table-wrap"><table className="admin-table">
              <thead>
                <tr>
                  <th>Merchant</th>
                  <th>Batch</th>
                  <th className="admin-num">Gross</th>
                  <th className="admin-num">Fee</th>
                  <th className="admin-num">Refunds</th>
                  <th className="admin-num">Net payout</th>
                  <th>Already closed</th>
                  <th>Already paid</th>
                </tr>
              </thead>
              <tbody>
                {runResults.map((outcome) => (
                  <tr key={`${outcome.merchantId}-${outcome.batchId}`}>
                    <td>
                      <span title={outcome.merchantId}>{nameOf(outcome.merchantId)}</span>
                    </td>
                    <td>
                      <code title={outcome.batchId}>{outcome.batchId.slice(0, 8)}</code>
                    </td>
                    <td className="admin-num">{bhd(outcome.grossFils)}</td>
                    <td className="admin-num">{bhd(outcome.feeFils)}</td>
                    <td className={`admin-num${(outcome.refundDeductionFils ?? 0) > 0 ? " admin-refund" : ""}`}>
                      {bhd(-(outcome.refundDeductionFils ?? 0) || 0)}
                    </td>
                    <td className="admin-num">{bhd(outcome.netPayoutFils)}</td>
                    <td>{outcome.alreadyClosed ? "Yes" : "No"}</td>
                    <td>{outcome.alreadyPaid ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          ) : null}
        </div>
      ) : null}

      <h2>Rebuild cached balances</h2>
      <p className="admin-muted">
        Recalculates every merchant&apos;s balance from the ledger. The ledger is only read, never
        changed, but this touches every merchant at once, so it asks first.
      </p>

      {rebuildError ? <p className="admin-error">{rebuildError}</p> : null}

      <RequireRole
        allow={["finance", "super_admin"]}
        fallback={
          <p className="admin-muted">Your role cannot rebuild balances. Ask a finance admin.</p>
        }
      >
        {confirmingRebuild ? (
          <div className="admin-confirm">
            <p>
              <strong>Rebuild balances for every merchant?</strong> This recalculates all cached
              payable balances and records the action in the admin audit log.
            </p>
            <button
              type="button"
              className="admin-btn-primary"
              disabled={rebuildBusy}
              onClick={() => void handleRebuild()}
            >
              {rebuildBusy ? "Rebuilding..." : "Yes, rebuild all balances"}
            </button>{" "}
            <button
              type="button"
              className="admin-btn-ghost"
              disabled={rebuildBusy}
              onClick={() => setConfirmingRebuild(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" className="admin-btn-primary" onClick={() => setConfirmingRebuild(true)}>
            Rebuild balances
          </button>
        )}
      </RequireRole>

      {rebuildResult ? (
        <div className="admin-notice">
          <p>
            Rebuilt {rebuildResult.rebuiltCount} balance
            {rebuildResult.rebuiltCount === 1 ? "" : "s"};{" "}
            {(rebuildResult.changed ?? []).length} changed.
          </p>
          {(rebuildResult.changed ?? []).length > 0 ? (
            <div className="admin-table-wrap"><table className="admin-table">
              <thead>
                <tr>
                  <th>Merchant</th>
                  <th className="admin-num">Before</th>
                  <th className="admin-num">After</th>
                </tr>
              </thead>
              <tbody>
                {(rebuildResult.changed ?? []).map((change) => (
                  <tr key={change.merchantId}>
                    <td>
                      <span title={change.merchantId}>{nameOf(change.merchantId)}</span>
                    </td>
                    <td className="admin-num">{bhd(change.before)}</td>
                    <td className="admin-num">{bhd(change.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          ) : (
            <p className="admin-muted">Every cached balance already matched the ledger.</p>
          )}
        </div>
      ) : null}

      <h2>Rebuild analytics</h2>
      <p className="admin-muted">
        Recalculates dashboard charts (daily volumes and payout trends) for every merchant. Use it
        when a merchant&apos;s dashboard looks behind.
      </p>

      {analyticsError ? <p className="admin-error">{analyticsError}</p> : null}

      <RequireRole
        allow={["finance", "super_admin"]}
        fallback={
          <p className="admin-muted">Your role cannot rebuild analytics. Ask a finance admin.</p>
        }
      >
        {confirmingAnalytics ? (
          <div className="admin-confirm">
            <p>
              <strong>Rebuild analytics for every merchant?</strong> Every merchant&apos;s charts are
              recalculated. The run is recorded in the audit log.
            </p>
            <button
              type="button"
              className="admin-btn-primary"
              disabled={analyticsBusy}
              onClick={() => void handleRebuildAnalytics()}
            >
              {analyticsBusy ? "Rebuilding..." : "Yes, rebuild analytics"}
            </button>{" "}
            <button
              type="button"
              className="admin-btn-ghost"
              disabled={analyticsBusy}
              onClick={() => setConfirmingAnalytics(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" className="admin-btn-primary" onClick={() => setConfirmingAnalytics(true)}>
            Rebuild analytics
          </button>
        )}
      </RequireRole>

      {analyticsResult ? (
        <div className="admin-notice">
          <p>
            Rebuilt {analyticsResult.volumeRows} daily-volume row
            {analyticsResult.volumeRows === 1 ? "" : "s"} and {analyticsResult.trendRows} payout-trend
            row{analyticsResult.trendRows === 1 ? "" : "s"}.
          </p>
        </div>
      ) : null}

      <h2>Recalculate MDR</h2>
      <p className="admin-muted">
        Recalculates one merchant&apos;s fees over a date range at their current rate, and posts a
        correction for any difference. Run it after a rate change.
      </p>
      <RequireRole
        allow={["finance", "super_admin"]}
        fallback={
          <p className="admin-muted">
            Your role cannot run an MDR recalculation. Ask a finance admin.
          </p>
        }
      >
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            setMdrError(null);
            if (mdrTo < mdrFrom) {
              setMdrError("The end date must be on or after the start date.");
              return;
            }
            setConfirmingMdr(true);
          }}
        >
          <label>
            Merchant
            <MerchantPicker
              value={mdrMerchantId}
              onChange={setMdrMerchantId}
              {...merchantOptions}
              required
            />
          </label>
          <label>
            From
            <input type="date" value={mdrFrom} onChange={(e) => setMdrFrom(e.target.value)} required />
          </label>
          <label>
            To
            <input type="date" value={mdrTo} onChange={(e) => setMdrTo(e.target.value)} required />
          </label>
          <button type="submit" disabled={mdrBusy}>
            {mdrBusy ? "Recalculating…" : "Recalculate MDR"}
          </button>
        </form>
      </RequireRole>

      {mdrError ? <p className="admin-error">{mdrError}</p> : null}

      {mdrResult ? (
        <div>
          <p>
            Checked {mdrResult.batchesConsidered} {mdrResult.batchesConsidered === 1 ? "batch" : "batches"};{" "}
            {mdrAdjusted.length} had a fee change.
          </p>
          {mdrAdjusted.length > 0 ? (
            <div className="admin-table-wrap"><table className="admin-table">
              <thead>
                <tr>
                  <th>Batch date</th>
                  <th>Status</th>
                  <th className="admin-num">Old fee</th>
                  <th className="admin-num">New fee</th>
                  <th className="admin-num">Difference</th>
                </tr>
              </thead>
              <tbody>
                {mdrAdjusted.map((adjustment) => (
                  <tr key={adjustment.batchId}>
                    <td>{adjustment.batchDate}</td>
                    <td>
                      <StatusPill value={adjustment.status} />
                    </td>
                    <td className="admin-num">{bhd(adjustment.oldFeeFils)}</td>
                    <td className="admin-num">{bhd(adjustment.newFeeFils)}</td>
                    <td className="admin-num">{bhd(adjustment.diffFils)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          ) : (
            <p className="admin-muted">Every batch in range already matched the current rate.</p>
          )}
        </div>
      ) : null}
      <ConfirmAction
        open={confirmingRun}
        title={merchantId.trim() ? "Run settlement for this merchant?" : "Run settlement for ALL merchants?"}
        confirmLabel={merchantId.trim() ? "Run batch" : "Run for all merchants"}
        danger={!merchantId.trim()}
        busy={runBusy}
        error={runError}
        onCancel={() => setConfirmingRun(false)}
        onConfirm={() => void handleRunBatch()}
      >
        {merchantId.trim() ? (
          <dl className="admin-dialog-summary">
            <dt>Business date</dt>
            <dd>{date}</dd>
            <dt>Merchant</dt>
            <dd>
              {nameOf(merchantId.trim())} <code>{merchantId.trim().slice(0, 8)}</code>
            </dd>
          </dl>
        ) : (
          <>
            <p className="admin-dialog-warning">
              This runs settlement for ALL merchants for {date}.
            </p>
            <p>Every eligible merchant&apos;s batch for that day is closed and paid out.</p>
          </>
        )}
      </ConfirmAction>

      <ConfirmAction
        open={confirmingMdr}
        title="Recalculate MDR?"
        confirmLabel="Recalculate and post"
        busy={mdrBusy}
        error={mdrError}
        onCancel={() => setConfirmingMdr(false)}
        onConfirm={() => void handleRecalculateMdr()}
      >
        <dl className="admin-dialog-summary">
          <dt>Merchant</dt>
          <dd>
            {nameOf(mdrMerchantId.trim())} <code>{mdrMerchantId.trim().slice(0, 8)}</code>
          </dd>
          <dt>Dates</dt>
          <dd>
            {mdrFrom} to {mdrTo} (both included)
          </dd>
        </dl>
        <p>Fee corrections are posted to the ledger for any batch whose fee changes.</p>
      </ConfirmAction>
    </section>
  );
}
