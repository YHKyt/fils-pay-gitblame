import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getPayoutTrends, getTopLinks, getVolumes } from "../../api/analytics.js";
import { describeError } from "../../api/client.js";
import { StalenessBadge } from "../../components/StalenessBadge.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { bhd, dash, dateTime, statusLabel } from "../../format.js";
import { usePageTitle } from "../../hooks/usePageTitle.js";
import { formatCount } from "../../utils/helpers.js";
import { StatCards } from "./StatCards.js";
import { VolumeChart } from "./VolumeChart.js";
import type { PayoutTrendsResponse, TopLinksResponse, VolumesResponse } from "../../types.js";

/** A time-of-day greeting in Asia/Bahrain, where this dashboard lives. */
function greeting(): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bahrain", hour: "2-digit", hour12: false }).format(new Date()),
  );
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** 60s: comfortably above the reporting worker's 15s worst-case lag, and
 *  more than often enough for a dashboard. Poll, not push —
 *  there is no websocket or SSE anywhere in this platform, and this page does
 *  not introduce the first one. */
const POLL_MS = 60_000;

export function OverviewPage() {
  usePageTitle("Overview");
  const { me } = useDashboardAuth();
  // Left blank, the server applies its own "last 30 Asia/Bahrain days"
  // default — the client does not compute a competing one.
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [topLinksLimit, setTopLinksLimit] = useState(10);

  const [volumes, setVolumes] = useState<VolumesResponse | null>(null);
  const [payouts, setPayouts] = useState<PayoutTrendsResponse | null>(null);
  const [topLinks, setTopLinks] = useState<TopLinksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Mirrors the server's own clamp so this page never displays a limit the
  // server would have silently overridden.
  const clampedLimit = Math.min(50, Math.max(1, Math.trunc(topLinksLimit) || 10));

  const load = useCallback(async () => {
    const range = { from: from || undefined, to: to || undefined };
    setLoading(true);
    setError(null);
    try {
      // Three independent endpoints, three independent fetches — there is no
      // combined route to call.
      const [v, p, t] = await Promise.all([
        getVolumes(range),
        getPayoutTrends(range),
        getTopLinks({ ...range, limit: clampedLimit }),
      ]);
      setVolumes(v);
      setPayouts(p);
      setTopLinks(t);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [from, to, clampedLimit]);

  // overview memory leak (heap +40mb/hr), pretty sure its these effects — am
  // FH: profiled for 1h, heap flat. maybe it was a browser extension? open
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const peakGross = Math.max(1, ...(volumes?.points.map((point) => point.capturedGrossFils) ?? [1]));

  return (
    <section>
      <div className="dash-hero">
        <p className="dash-hero-eyebrow">Overview</p>
        <h1 className="dash-hero-title">
          {greeting()}
          {me ? <>, <span className="dash-hero-name">{me.merchant.displayName}</span></> : null}
        </h1>
        <p className="dash-hero-sub">Here is how your payments are moving, in Asia/Bahrain time.</p>
      </div>

      <form
        className="dash-form dash-form-inline"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <label>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To (exclusive)
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          Top links
          <input
            type="number"
            min={1}
            max={50}
            value={topLinksLimit}
            onChange={(e) => setTopLinksLimit(Number(e.target.value))}
          />
        </label>
        <button type="submit" className="dash-button" disabled={loading}>
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </form>

      {error ? <p className="dash-error">{error}</p> : null}

      {/* Headline roll-ups + daily trend, derived from the same analytics the
          tables below render — no extra fetch. */}
      {volumes && payouts ? (
        <>
          <StatCards volumes={volumes} payouts={payouts} />
          <VolumeChart points={volumes.points} />
        </>
      ) : loading ? (
        <div className="dash-stats" aria-hidden="true">
          <span className="dash-skeleton dash-skeleton-card" />
          <span className="dash-skeleton dash-skeleton-card" />
          <span className="dash-skeleton dash-skeleton-card" />
          <span className="dash-skeleton dash-skeleton-card" />
        </div>
      ) : null}

      <h2>
        Captured volume{" "}
        {volumes ? <StalenessBadge readModelAsOf={volumes.readModelAsOf} live={volumes.live} /> : null}
      </h2>
      <div className="dash-tablewrap"><table className="dash-table">
        <thead>
          <tr>
            <th>Date</th>
            <th className="dash-num">Captured</th>
            <th className="dash-num">Gross</th>
            <th className="dash-num">Voided</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {volumes?.points.map((point) => (
            <tr key={point.date}>
              <td>{point.date}</td>
              <td className="dash-num">{formatCount(point.capturedCount)}</td>
              <td className="dash-num">{bhd(point.capturedGrossFils)}</td>
              <td className="dash-num">{formatCount(point.voidedCount)}</td>
              <td className="dash-bar-cell">
                {/* A plain CSS bar, scaled to the window's own peak — no
                    charting library, no new dependency. */}
                <span
                  className="dash-bar"
                  style={{ width: `${(point.capturedGrossFils / peakGross) * 100}%` }}
                />
              </td>
            </tr>
          ))}
          {volumes && volumes.points.length === 0 ? (
            <tr>
              <td colSpan={5}>No captured volume in this window.</td>
            </tr>
          ) : null}
        </tbody>
      </table></div>

      <h2>
        Payout trends{" "}
        {payouts ? <StalenessBadge readModelAsOf={payouts.readModelAsOf} live={payouts.live} /> : null}
      </h2>
      <div className="dash-tablewrap"><table className="dash-table">
        <thead>
          <tr>
            <th>Batch date</th>
            <th>Status</th>
            <th className="dash-num">Gross</th>
            <th className="dash-num">Fee</th>
            <th className="dash-num">Net payout</th>
            <th>Paid</th>
          </tr>
        </thead>
        <tbody>
          {payouts?.points.map((point) => (
            <tr key={point.settlementBatchId}>
              <td>
                <Link to={`/dashboard/settlement/${point.settlementBatchId}`}>{point.batchDate}</Link>
              </td>
              <td>
                <span className={`dash-status dash-status-${point.status}`}>{statusLabel(point.status)}</span>
              </td>
              <td className="dash-num">{bhd(point.grossFils)}</td>
              <td className="dash-num">{bhd(point.feeFils)}</td>
              <td className="dash-num">{bhd(point.netPayoutFils)}</td>
              <td>{dateTime(point.paidAt)}</td>
            </tr>
          ))}
          {payouts && payouts.points.length === 0 ? (
            <tr>
              <td colSpan={6}>No settled batches in this window.</td>
            </tr>
          ) : null}
        </tbody>
      </table></div>

      <h2>
        Top paid links{" "}
        {topLinks ? (
          <StalenessBadge readModelAsOf={topLinks.readModelAsOf} live={topLinks.live} />
        ) : null}
      </h2>
      <div className="dash-tablewrap"><table className="dash-table">
        <thead>
          <tr>
            <th className="dash-num">#</th>
            <th>Reference</th>
            <th>Description</th>
            <th className="dash-num">Amount</th>
            <th>Paid at</th>
          </tr>
        </thead>
        <tbody>
          {topLinks?.links.map((link, index) => (
            <tr key={link.id}>
              <td className="dash-num">{index + 1}</td>
              <td>
                <Link to={`/dashboard/payment-links/${link.id}`}>{dash(link.reference)}</Link>
              </td>
              <td>{dash(link.description)}</td>
              <td className="dash-num">{bhd(link.amountFils)}</td>
              <td>{dateTime(link.paidAt)}</td>
            </tr>
          ))}
          {topLinks && topLinks.links.length === 0 ? (
            <tr>
              <td colSpan={5}>No paid payment links in this window.</td>
            </tr>
          ) : null}
        </tbody>
      </table></div>
    </section>
  );
}
