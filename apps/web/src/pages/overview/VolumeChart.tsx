import { useState } from "react";
import type { VolumePointDto } from "../../types.js";
import { bhd, groupThousands } from "../../format.js";
import { formatCount } from "../../utils/helpers.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A Bahrain business-day key (`2026-10-29`) as `29 Oct`. The API already
 *  buckets by Asia/Bahrain day, so this is pure string work with no zone
 *  conversion. */
function shortDay(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1] ?? match[2]}`;
}

function longDay(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match ? `${shortDay(date)} ${match[1]}` : date;
}

/** Compact BHD for axis ticks: whole dinars with separators below 10,000,
 *  then "12.5k". Axis labels only; every exact figure uses `bhd()`. */
function axisBhd(fils: number): string {
  const dinars = fils / 1000;
  if (dinars >= 10_000) return `${(dinars / 1000).toFixed(dinars >= 100_000 ? 0 : 1)}k`;
  if (dinars >= 10) return groupThousands(String(Math.round(dinars)));
  return dinars.toFixed(dinars === 0 ? 0 : 1);
}

/**
 * Inline-SVG area chart of daily captured gross, drawn from the
 * `volumes.points` the Overview page already fetched. Axis labels are HTML so
 * they stay readable at any width; hovering (or tapping) a day shows its
 * exact amount and payment count.
 */
export function VolumeChart({ points }: { points: VolumePointDto[] }) {
  const [active, setActive] = useState<number | null>(null);
  const width = 960;
  const height = 240;

  if (points.length === 0) {
    return (
      <div className="dash-chart-card">
        <p className="dash-chart-empty">No captured volume in this window.</p>
      </div>
    );
  }

  const values = points.map((p) => p.capturedGrossFils);
  const max = Math.max(1, ...values);
  const n = points.length;
  const xf = (i: number): number => (n === 1 ? 0.5 : i / (n - 1));
  const x = (i: number): number => xf(i) * width;
  const y = (v: number): number => height - (v / max) * height;

  const line = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(p.capturedGrossFils).toFixed(1)}`)
    .join(" ");
  const area = `${line} L${x(n - 1).toFixed(1)} ${height} L${x(0).toFixed(1)} ${height} Z`;

  const ticks = [1, 0.5, 0];
  // Up to six evenly spaced date labels, always including first and last.
  const labelCount = Math.min(n, 6);
  const labelIdx =
    n === 1
      ? [0]
      : Array.from(new Set(Array.from({ length: labelCount }, (_, k) => Math.round((k * (n - 1)) / (labelCount - 1)))));

  const point = active === null ? null : points[active];

  function pick(clientX: number, rect: DOMRect) {
    const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    setActive(n === 1 ? 0 : Math.round(f * (n - 1)));
  }

  return (
    <div className="dash-chart-card">
      <div className="dash-chart-head">
        <span className="dash-chart-title">Daily captured volume</span>
        <span className="dash-chart-unit">BHD · Bahrain time</span>
      </div>
      <div className="dash-chart-frame">
        <div className="dash-chart-yaxis" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} style={{ top: `${(1 - t) * 100}%` }}>
              {axisBhd(max * t)}
            </span>
          ))}
        </div>
        <div
          className="dash-chart-plot"
          onMouseMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
          onMouseLeave={() => setActive(null)}
          onTouchStart={(e) => {
            const t = e.touches[0];
            if (t) pick(t.clientX, e.currentTarget.getBoundingClientRect());
          }}
        >
          <svg
            className="dash-chart"
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Daily captured gross volume, ${shortDay(points[0]!.date)} to ${shortDay(points[n - 1]!.date)}, peak ${bhd(max)}`}
          >
            <defs>
              <linearGradient id="fp-chart-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--fp-gold)" stopOpacity="0.38" />
                <stop offset="0.6" stopColor="var(--fp-teal)" stopOpacity="0.14" />
                <stop offset="1" stopColor="var(--fp-teal)" stopOpacity="0.02" />
              </linearGradient>
              <linearGradient id="fp-chart-stroke" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="var(--fp-gold-deep)" />
                <stop offset="0.5" stopColor="var(--fp-gold)" />
                <stop offset="1" stopColor="var(--fp-teal)" />
              </linearGradient>
            </defs>
            {ticks.map((t) => (
              <line
                key={t}
                className="dash-chart-grid"
                x1={0}
                y1={(1 - t) * height}
                x2={width}
                y2={(1 - t) * height}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <path className="dash-chart-area" d={area} fill="url(#fp-chart-fill)" />
            <path
              className="dash-chart-line dash-draw"
              d={line}
              stroke="url(#fp-chart-stroke)"
              vectorEffect="non-scaling-stroke"
              style={{ ["--dash-len" as string]: "3000" }}
            />
            {active !== null ? (
              <line
                className="dash-chart-cursor"
                x1={x(active)}
                x2={x(active)}
                y1={0}
                y2={height}
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </svg>
          {point && active !== null ? (
            <>
              <span
                className="dash-chart-dot"
                style={{ left: `${xf(active) * 100}%`, top: `${(y(point.capturedGrossFils) / height) * 100}%` }}
              />
              <div
                className="dash-chart-tip"
                role="status"
                style={{
                  left: `${xf(active) * 100}%`,
                  transform: `translateX(${xf(active) > 0.75 ? "-100%" : xf(active) < 0.25 ? "0" : "-50%"})`,
                }}
              >
                <strong>{longDay(point.date)}</strong>
                <span>{bhd(point.capturedGrossFils)}</span>
                <span>
                  {formatCount(point.capturedCount)} {point.capturedCount === 1 ? "payment" : "payments"}
                </span>
              </div>
            </>
          ) : null}
        </div>
        <div className="dash-chart-xaxis" aria-hidden="true">
          {labelIdx.map((i) => (
            <span
              key={i}
              style={{
                left: `${xf(i) * 100}%`,
                transform: `translateX(${i === 0 && n > 1 ? "0" : i === n - 1 && n > 1 ? "-100%" : "-50%"})`,
              }}
            >
              {shortDay(points[i]!.date)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
