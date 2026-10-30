import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listSettlementBatches } from "../../api/settlement.js";
import { describeError } from "../../api/client.js";
import { Pagination } from "../../components/Pagination.js";
import { SkeletonRows } from "../../components/SkeletonRows.js";
import { bhd, dateTime, humanDate, shortId, statusLabel } from "../../format.js";
import { usePageTitle } from "../../hooks/usePageTitle.js";
import type { SettlementBatchDto, SettlementBatchStatus } from "../../types.js";

const STATUSES: SettlementBatchStatus[] = ["open", "closed", "paid"];
const PAGE_SIZE = 25;

/**
 * `GET /v1/settlement/batches` — `requireMerchantAuth` with no role
 * restriction — a batch list is not as sensitive as the reconciliation
 * report.
 *
 * `from`/`to` bound `batch_date`, a plain DATE column, so the raw YYYY-MM-DD
 * value from the date input goes through unchanged — no instant conversion,
 * because there is no timezone in the column to convert against.
 */
/** Filters by batch_date, which is a Bahrain business date. */
export function SettlementBatchListPage() {
  usePageTitle("Settlements");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [statuses, setStatuses] = useState<SettlementBatchStatus[]>([]);
  const [batches, setBatches] = useState<SettlementBatchDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const result = await listSettlementBatches({
          from: from || undefined,
          to: to || undefined,
          status: statuses.length > 0 ? statuses : undefined,
          limit: PAGE_SIZE,
          cursor: cursor ?? undefined,
        });
        setBatches((previous) => (cursor ? [...previous, ...result.batches] : result.batches));
        setNextCursor(result.nextCursor);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setLoading(false);
      }
    },
    [from, to, statuses],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  function toggleStatus(status: SettlementBatchStatus): void {
    setStatuses((previous) =>
      previous.includes(status) ? previous.filter((s) => s !== status) : [...previous, status],
    );
  }

  return (
    <section>
      <h1>Settlement batches</h1>

      <fieldset className="dash-filters">
        <legend>Batch date</legend>
        <label>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To (not included)
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </fieldset>

      <fieldset className="dash-filters">
        <legend>Status</legend>
        {STATUSES.map((status) => (
          <label key={status}>
            <input
              type="checkbox"
              checked={statuses.includes(status)}
              onChange={() => toggleStatus(status)}
            />
            {statusLabel(status)}
          </label>
        ))}
      </fieldset>

      {error ? <p className="dash-error">{error}</p> : null}

      <div className="dash-tablewrap"><table className="dash-table">
        <thead>
          <tr>
            <th>Batch</th>
            <th>Status</th>
            <th className="dash-num">Gross</th>
            <th className="dash-num">Fee</th>
            <th className="dash-num">Net payout</th>
            <th>Closed</th>
            <th>Paid</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((batch) => (
            <tr key={batch.id}>
              <td>
                <Link className="dash-ref-main" to={`/dashboard/settlement/${batch.id}`}>
                  {humanDate(batch.batchDate)}
                </Link>
                <span className="dash-ref-sub" title={batch.id}>
                  {shortId(batch.id)}
                </span>
              </td>
              <td>
                <span className={`dash-status dash-status-${batch.status}`}>{statusLabel(batch.status)}</span>
              </td>
              <td className="dash-num">{bhd(batch.grossFils)}</td>
              <td className="dash-num">{bhd(batch.feeFils)}</td>
              <td className="dash-num">{bhd(batch.netPayoutFils)}</td>
              <td>{dateTime(batch.closedAt)}</td>
              <td>{dateTime(batch.paidAt)}</td>
            </tr>
          ))}
          {batches.length === 0 && loading ? <SkeletonRows columns={7} /> : null}
          {batches.length === 0 && !loading ? (
            <tr>
              <td colSpan={7}>No settlement batches match these filters.</td>
            </tr>
          ) : null}
        </tbody>
      </table></div>

      {loading ? <p className="dash-loading">Loading…</p> : null}

      <Pagination nextCursor={nextCursor} loading={loading} onLoadMore={() => void load(nextCursor)} />
    </section>
  );
}
