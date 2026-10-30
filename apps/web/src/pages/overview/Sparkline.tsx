/**
 * A tiny inline-SVG sparkline for a stat card — no charting library, no new
 * dependency, pure presentation over numbers the page already fetched. Draws a
 * soft gradient area under a brand-accent line.
 */
export function Sparkline({ values, idSuffix }: { values: number[]; idSuffix: string }) {
  const width = 240;
  const height = 44;
  const pad = 3;
  if (values.length < 2) {
    return <svg className="dash-stat-spark" viewBox={`0 0 ${width} ${height}`} aria-hidden="true" />;
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const stepX = (width - pad * 2) / (values.length - 1);
  const y = (v: number): number => height - pad - ((v - min) / span) * (height - pad * 2);
  const points = values.map((v, i) => [pad + i * stepX, y(v)] as const);
  const line = points.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px.toFixed(1)} ${py.toFixed(1)}`).join(" ");
  const area = `${line} L${(pad + (values.length - 1) * stepX).toFixed(1)} ${height - pad} L${pad} ${height - pad} Z`;
  const gid = `fp-spark-${idSuffix}`;

  return (
    <svg className="dash-stat-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--fp-spark-color, var(--fp-accent))" stopOpacity="0.3" />
          <stop offset="1" stopColor="var(--fp-spark-color, var(--fp-accent))" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path className="dash-spark-area" d={area} fill={`url(#${gid})`} />
      <path className="dash-spark-line dash-draw" d={line} style={{ ["--dash-len" as string]: "600" }} />
    </svg>
  );
}
