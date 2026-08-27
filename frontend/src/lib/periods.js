/**
 * Formatting for the `period` column that `granularity()` produces in `redivis/queries.js`.
 *
 * Extracted because three dashboards need it and the two hand-rolled copies had already drifted
 * apart on the one detail that matters — see `parsePeriod`.
 */

/**
 * Parse a period value from BigQuery into a Date.
 *
 * A bare `YYYY-MM-DD` is parsed **as UTC**, not local. These are whole dates, and every formatter
 * below renders them with `timeZone: "UTC"`; parsing them locally and rendering them as UTC shifts
 * the result a day backwards for any viewer east of Greenwich. The bug is invisible in California
 * (behind UTC, so the shift lands inside the same day) and mislabels every bar in Europe or Asia.
 */
export function parsePeriod(val) {
  if (val == null) return null;
  if (val instanceof Date) return val;
  if (typeof val === "number") return new Date(val);
  const s = String(val);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + "T00:00:00Z");
  return new Date(s);
}

/**
 * Axis/tooltip label for one period, at the granularity the query used.
 *
 * A week is labelled as the span it covers rather than its first day, so a `DATE_TRUNC(…, WEEK)`
 * bucket does not read as a single date. Unparseable values are passed through as their own string
 * rather than rendering "Invalid Date".
 */
export function formatPeriod(val, granularity) {
  const d = parsePeriod(val);
  if (!d || isNaN(d.getTime())) return String(val);
  const utc = { timeZone: "UTC" };
  const day = (dt) => dt.toLocaleDateString("en-US", { month: "short", day: "numeric", ...utc });
  if (granularity === "month") {
    return d.toLocaleDateString("en-US", { month: "short", year: "numeric", ...utc });
  }
  if (granularity === "week") {
    const end = new Date(d);
    end.setUTCDate(end.getUTCDate() + 6);
    return `${day(d)} – ${day(end)}`;
  }
  return day(d);
}

/**
 * Sortable key for a period.
 *
 * ISO strings sort lexically in chronological order, which lets callers order formatted rows with a
 * plain `localeCompare`. Unparseable values fall back to their own string so they group together
 * instead of throwing.
 */
export function periodSortKey(val) {
  const d = parsePeriod(val);
  if (!d || isNaN(d.getTime())) return String(val);
  return d.toISOString();
}

/** Human name for a granularity, for axis titles. */
export function periodLabel(granularity) {
  if (granularity === "day") return "Day";
  if (granularity === "week") return "Week";
  return "Month";
}
