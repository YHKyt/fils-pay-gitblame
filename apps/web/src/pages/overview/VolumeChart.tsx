import type { VolumePointDto } from "../../types.js";
import { bhd } from "../../format.js";

/**
 * An elegant inline-SVG area chart of daily captured gross — no charting
 * library, drawn straight from the `volumes.points` the Overview page already
 * fetched. Presentation only; it renders exactly the data passed in, in the
 * order the API returned it. The line draws itself in (CSS stroke-dashoffset).
 */
export function VolumeChart({ points }: { points: VolumePointDto[] }) {
  const width = 960;
  const height = 240;
  const padL = 8;
  const padR = 8;
  const padT = 18;
  const padB = 26;

  if (points.length === 0) {
    return (
      <div className="dash-chart-card">
        <p className="dash-chart-empty">No captured volume in this window.</p>
      </div>
    );
  }

  const values = points.map((p) => p.capturedGrossFils);
  const max = Math.max(1, ...values);
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const n = points.length;
  const x = (i: number): number => (n === 1 ? padL + innerW / 2 : padL + (i / (n - 1)) * innerW);
  const y = (v: number): number => padT + innerH - (v / max) * innerH;

  const line = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(p.capturedGrossFils).toFixed(1)}`)
    .join(" ");
  const area = `${line} L${x(n - 1).toFixed(1)} ${padT + innerH} L${x(0).toFixed(1)} ${padT + innerH} Z`;

  // Three faint gridlines (0 / mid / peak) plus end-date labels — enough to
  // read the shape without clutter.
  const gridYs = [0, 0.5, 1].map((f) => padT + innerH - f * innerH);
  const firstDate = points[0]?.date ?? "";
  const lastDate = points[n - 1]?.date ?? "";

  return (
    <div className="dash-chart-card">
      <svg
        className="dash-chart"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Daily captured gross volume, peak ${bhd(max)}`}
      >
        <defs>
          {/* Signature gold→teal area wash: brass at the crest, Gulf-mint as
              it falls to the baseline. */}
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
        {gridYs.map((gy, i) => (
          <line key={i} className="dash-chart-grid" x1={padL} y1={gy} x2={width - padR} y2={gy} />
        ))}
        <path className="dash-chart-area" d={area} fill="url(#fp-chart-fill)" />
        <path
          className="dash-chart-line dash-draw"
          d={line}
          stroke="url(#fp-chart-stroke)"
          style={{ ["--dash-len" as string]: "3000" }}
        />
        {n > 1 ? (
          <>
            <text className="dash-chart-axis" x={padL} y={height - 8} textAnchor="start">
              {firstDate}
            </text>
            <text className="dash-chart-axis" x={width - padR} y={height - 8} textAnchor="end">
              {lastDate}
            </text>
          </>
        ) : null}
      </svg>
    </div>
  );
}
