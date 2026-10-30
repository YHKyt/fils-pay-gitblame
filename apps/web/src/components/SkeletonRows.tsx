/**
 * Placeholder shimmer rows shown inside a `.dash-table` while its first page
 * loads, instead of an empty body. Pure presentation — rendered only when the
 * page has no data yet and is loading, and replaced by the real rows the
 * moment they arrive. No data flow depends on it.
 */
export function SkeletonRows({ rows = 5, columns }: { rows?: number; columns: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={`sk-${r}`} aria-hidden="true">
          {Array.from({ length: columns }).map((_, c) => (
            <td key={`sk-${r}-${c}`}>
              <span className="dash-skeleton" style={{ width: c === 0 ? "60%" : "80%" }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
