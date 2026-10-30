import { bhdDisplay } from "../../format.js";
import { formatCount } from "../../utils/helpers.js";
import { useCountUp } from "../../hooks/useCountUp.js";
import type { PayoutTrendsResponse, VolumesResponse } from "../../types.js";
import { Sparkline } from "./Sparkline.js";

/** One premium stat tile: big count-up number, label, sub-line, sparkline. */
function StatCard({
  label,
  value,
  format,
  sub,
  spark,
  idSuffix,
  accent = "teal",
}: {
  label: string;
  value: number;
  format: (n: number) => string;
  sub: string;
  spark: number[];
  idSuffix: string;
  accent?: "gold" | "teal";
}) {
  const animated = useCountUp(value);
  return (
    <div className={`dash-stat dash-stat-${accent}`}>
      <span className="dash-stat-label">{label}</span>
      <span className="dash-stat-value">{format(animated)}</span>
      <span className="dash-stat-sub">{sub}</span>
      <Sparkline values={spark} idSuffix={idSuffix} />
    </div>
  );
}

/**
 * The dashboard overview summary: four headline figures rolled up from the
 * analytics the page already fetched. Pure presentation — every number here is
 * a plain sum of `volumes`/`payouts` points, computed once, nothing re-fetched
 * and no new request introduced.
 */
export function StatCards({
  volumes,
  payouts,
  periodLabel,
}: {
  volumes: VolumesResponse;
  payouts: PayoutTrendsResponse;
  periodLabel: string;
}) {
  const vPoints = volumes.points;
  const pPoints = payouts.points;

  const totalGross = vPoints.reduce((s, p) => s + p.capturedGrossFils, 0);
  const totalCaptured = vPoints.reduce((s, p) => s + p.capturedCount, 0);
  const totalVoided = vPoints.reduce((s, p) => s + p.voidedCount, 0);
  const totalNetPayout = pPoints.reduce((s, p) => s + p.netPayoutFils, 0);

  const grossSpark = vPoints.map((p) => p.capturedGrossFils);
  const countSpark = vPoints.map((p) => p.capturedCount);
  const voidSpark = vPoints.map((p) => p.voidedCount);
  const payoutSpark = pPoints.map((p) => p.netPayoutFils);
  const days = vPoints.length;

  return (
    <div className="dash-stats">
      <StatCard
        label="Captured volume"
        value={totalGross}
        format={(n) => bhdDisplay(Math.round(n))}
        sub={periodLabel}
        spark={grossSpark}
        idSuffix="gross"
        accent="gold"
      />
      <StatCard
        label="Transactions"
        value={totalCaptured}
        format={(n) => formatCount(Math.round(n))}
        sub={`Payments captured · ${periodLabel}`}
        spark={countSpark}
        idSuffix="count"
      />
      <StatCard
        label="Voided"
        value={totalVoided}
        format={(n) => formatCount(Math.round(n))}
        sub={`Authorizations released · ${periodLabel}`}
        spark={voidSpark}
        idSuffix="void"
      />
      <StatCard
        label="Net payout"
        value={totalNetPayout}
        format={(n) => bhdDisplay(Math.round(n))}
        sub={`${periodLabel} · ${pPoints.length} ${pPoints.length === 1 ? "batch" : "batches"}`}
        spark={payoutSpark}
        idSuffix="payout"
        accent="gold"
      />
    </div>
  );
}
