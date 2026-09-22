/**
 * A chart's text alternative.
 *
 * Recharts renders bare SVG, so without this a screen reader announces nothing — or a stream of
 * tick labels. `role="img"` makes the chart one element whose name is `summary`, which should state
 * the takeaway with its numbers ("normal 61% of jobs, …"), not the chart type ("pie chart of
 * partitions"). The summary is built from the same rows the chart draws, so the two cannot drift.
 */
export default function ChartFigure({ summary, children }) {
  return (
    <div role="img" aria-label={summary}>
      {children}
    </div>
  );
}

const num = (v) => Number(v) || 0;

export function fmtCount(v) {
  return Math.round(num(v)).toLocaleString();
}

/**
 * The `n` largest rows as "a (…), b (…), c (…)", largest first. `label` is a key or a function
 * of the row; `fmt` formats the value.
 */
export function topList(rows, label, valueKey, fmt = fmtCount, n = 3) {
  const labelOf = typeof label === "function" ? label : (r) => r[label];
  const top = [...(rows || [])]
    .sort((a, b) => num(b[valueKey]) - num(a[valueKey]))
    .slice(0, n)
    .map((r) => `${labelOf(r)} (${fmt(r[valueKey])})`);
  return top.length ? top.join(", ") : "no data";
}

/** Where a series peaks: `{ value, at }`, or null when there are no rows. */
export function peak(rows, xKey, valueOf) {
  let best = null;
  for (const r of rows || []) {
    const v = valueOf(r);
    if (v == null || !Number.isFinite(Number(v))) continue;
    if (!best || Number(v) > best.value) best = { value: Number(v), at: r[xKey] };
  }
  return best;
}

export function total(rows, valueOf) {
  return (rows || []).reduce((s, r) => s + num(valueOf(r)), 0);
}
