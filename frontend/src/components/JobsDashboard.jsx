import { useState, useEffect } from "react";
import { useRedivisQuery } from "../hooks/useRedivisQuery";
import { getSummary, getJobs, getTimeline, getFilterOptions, getWaitTimes, ck } from "../redivis/queries";
import { jobCost, formatUsd } from "../lib/ec2";
import LoadingProgress from "./LoadingProgress";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ComposedChart,
  Line,
  Legend,
} from "recharts";

function MiniCards({ data, label, showCost, showStates }) {
  if (!data) return null;

  const cards = [
    { label: "Total Jobs", value: data.total_jobs?.toLocaleString() },
    { label: "Unique Users", value: data.unique_users },
    { label: "Partitions", value: data.unique_partitions },
  ];

  if (showCost) {
    cards.push({ label: "EC2 Equivalent", value: formatUsd(data.total_ec2_cost_usd) });
  }

  if (showStates && data.state_counts) {
    Object.entries(data.state_counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .forEach(([state, count]) => {
        cards.push({ label: state, value: count.toLocaleString() });
      });
  }

  return (
    <div>
      <div className="text-xs font-medium text-black-60 uppercase tracking-wide mb-2">
        {label}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
        {cards.map((c) => (
          <div
            key={c.label}
            className="bg-white rounded-lg shadow-sm border border-black-20 p-2 text-center"
          >
            <div className="text-lg font-bold text-black-su">{c.value}</div>
            <div className="text-xs text-black-60">{c.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A duration in minutes, written the way someone reads a queue wait.
 *
 * The wait series span five orders of magnitude — a median of a few seconds against a maximum of
 * over a week — so a single fixed unit makes one end of the axis unreadable whichever end you pick.
 */
function fmtWait(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return "—";
  const trim = (n) => String(+n.toFixed(1)).replace(/\.0$/, "");
  if (minutes < 1) return `${Math.round(minutes * 60)}s`;
  if (minutes < 60) return `${trim(minutes)}m`;
  if (minutes < 1440) return `${trim(minutes / 60)}h`;
  return `${trim(minutes / 1440)}d`;
}

/** Validated as a categorical set: worst adjacent pair ΔE 11.9 (protan), 20.9 normal vision. */
const WAIT_COLORS = { median: "#008566", avg: "#E98300", max: "#B83A4B" };

/** A filled dot with a surface ring, so points stay legible where the series overlap. */
const waitDot = (fill, r = 3) => ({ r, fill, stroke: "#fff", strokeWidth: 1.5 });

/** Gridlines at intervals people think in, rather than at powers of ten. */
const WAIT_TICKS_MINUTES = [
  1 / 60, 1 / 6, 1, 5, 15, 60, 360, 1440, 4320, 10080, 43200, 129600,
];

/**
 * Every period in the range, including the ones with no jobs.
 *
 * `GROUP BY period` only returns periods that had jobs, so an idle month is simply absent from the
 * result. Plotted as-is, the surviving points are spaced evenly and a gap silently closes up:
 * December sits next to July as though they were consecutive, and a line drawn between them implies
 * a trend across months that hold no data at all.
 *
 * Keys are UTC-based ISO dates, matching what `periodKey` derives from the query's own rows, and
 * the boundaries mirror BigQuery's `DATE_TRUNC` — months to the 1st, weeks back to Sunday.
 */
function periodSequenceKeys(startDate, endDate, gran) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return [];

  let cur;
  if (gran === "month") {
    cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  } else if (gran === "week") {
    cur = new Date(start);
    cur.setUTCDate(cur.getUTCDate() - cur.getUTCDay());
  } else {
    cur = new Date(start);
  }

  const keys = [];
  // The granularity is derived from the range, so this cannot run away; the cap is a backstop.
  while (cur <= end && keys.length < 2000) {
    keys.push(cur.toISOString().slice(0, 10));
    if (gran === "month") {
      cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    } else {
      cur = new Date(cur.getTime() + (gran === "week" ? 7 : 1) * 86400000);
    }
  }
  return keys;
}

const JOB_COLUMNS = [
  { key: "JobID", label: "Job ID" },
  { key: "JobName", label: "Name" },
  { key: "User", label: "User" },
  { key: "Partition", label: "Partition" },
  { key: "State", label: "State", feature: "jobStates" },
  { key: "NCPUS", label: "CPUs", numeric: true },
  { key: "ReqMem_GB", label: "Memory (GB)", numeric: true, feature: "memory" },
  { key: "gpu_count", label: "GPUs", numeric: true, feature: "gpus" },
  { key: "ec2_cost_usd", label: "EC2 Cost", currency: true, feature: "ec2Cost" },
  { key: "ec2_instance", label: "EC2 Instance", feature: "ec2Cost" },
  { key: "wait_seconds", label: "Queue Wait (s)", numeric: true, feature: "waitTimes" },
  { key: "ElapsedRaw", label: "Elapsed (s)", numeric: true },
  { key: "Submit", label: "Submit", date: true },
  { key: "Start", label: "Start", date: true },
  { key: "End", label: "End", date: true, feature: "hasEndColumn" },
  { key: "NodeList", label: "Nodes" },
];

/**
 * Columns a cluster can actually populate. `feature: null`-guarded entries would otherwise render a
 * column of em-dashes, which reads as "no GPUs were used" rather than "this dump can't tell you".
 */
function jobColumnsFor(cluster) {
  const available = {
    ...cluster.features,
    hasEndColumn: Boolean(cluster.columns.end),
  };
  // Keyed on `sampling`, not on a state flag: a runtime is a lower bound because the source samples
  // a live queue, which is the actual cause, and stays right for a sampled cluster that does record
  // states.
  return JOB_COLUMNS.filter((c) => !c.feature || available[c.feature]).map((c) =>
    c.key === "ElapsedRaw" && cluster.sampling
      ? {
          ...c,
          label: "Observed runtime (s)",
          title:
            `Last runtime seen before the job left the queue, sampled ${cluster.sampling.label} — ` +
            "a lower bound, not the final elapsed time.",
        }
      : c,
  );
}

function JobTable({ data, sort, setSort, columns, showCost }) {
  const handleSort = (col) => {
    setSort((prev) =>
      prev.col === col ? { col, asc: !prev.asc } : { col, asc: true },
    );
  };

  const colMeta = Object.fromEntries(columns.map((c) => [c.key, c]));
  const sorted = [...(data.jobs || [])].sort((a, b) => {
    if (!sort.col) return 0;
    let av = a[sort.col], bv = b[sort.col];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const meta = colMeta[sort.col] || {};
    if (meta.numeric || meta.currency) {
      const na = Number(av), nb = Number(bv);
      return sort.asc ? na - nb : nb - na;
    }
    if (meta.date) {
      const da = new Date(av).getTime(), db = new Date(bv).getTime();
      return sort.asc ? da - db : db - da;
    }
    av = String(av);
    bv = String(bv);
    return sort.asc ? av.localeCompare(bv) : bv.localeCompare(av);
  });

  const fmtVal = (col, val) => {
    if (val == null) return "—";
    if (col.currency) return formatUsd(val);
    if (col.numeric && typeof val === "number")
      return val % 1 === 0 ? val.toLocaleString() : val.toFixed(2);
    return String(val);
  };

  const anyOversized = sorted.some((j) => j.ec2_oversized);

  return (
    <div className="bg-white rounded-lg shadow border border-black-20 overflow-hidden">
      <div className="p-4 border-b border-black-20">
        <h3 className="text-lg font-semibold text-black-su">
          Jobs ({data.total?.toLocaleString()} total, showing{" "}
          {data.jobs?.length})
        </h3>
        {showCost && (
          <p className="text-xs text-black-60 mt-1">
            EC2 cost across all {data.total?.toLocaleString()} matching jobs:{" "}
            <span className="font-medium text-black-su">
              {formatUsd(data.total_ec2_cost_usd)}
            </span>
            {anyOversized && " · † job exceeds every catalog instance; cost shown is a lower bound"}
          </p>
        )}
      </div>
      <div className="overflow-x-auto max-h-96">
        <table className="w-full text-sm text-left">
          <thead className="bg-fog sticky top-0">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  title={col.title}
                  className="px-4 py-2 font-medium text-black-su cursor-pointer select-none hover:bg-fog-dark"
                  onClick={() => handleSort(col.key)}
                >
                  {col.label}
                  {sort.col === col.key && (sort.asc ? " ▲" : " ▼")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, 200).map((job, i) => (
              <tr key={i} className="border-t border-black-20 hover:bg-black-10">
                {columns.map((col) => (
                  <td key={col.key} className="px-4 py-2 whitespace-nowrap">
                    {fmtVal(col, job[col.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function JobsDashboard({ cluster, startDate, endDate, node, group }) {
  const [localFilters, setLocalFilters] = useState({
    state: "",
    user: "",
    partition: "",
  });
  const [sort, setSort] = useState({ col: null, asc: true });
  const showCost = cluster.features.ec2Cost;
  const showStates = cluster.features.jobStates;
  const columns = jobColumnsFor(cluster);

  // With no state control rendered, a stale `state` must not linger in the filter set or the cache
  // key — it would filter invisibly and put a "Filtered" row on screen with nothing to explain it.
  const activeState = showStates ? localFilters.state : "";

  // `node` is a global filter owned by App; the rest are local to this tab. The summary strip
  // above already reflects `node`, so only the local filters justify a second "Filtered" row —
  // otherwise it would restate the same numbers.
  const filters = { ...localFilters, state: activeState, node, group };
  const hasFilters = Boolean(
    activeState || localFilters.user || localFilters.partition,
  );
  const fk = `${activeState}_${localFilters.user}_${localFilters.partition}_${node || ""}_${group || ""}`;

  const { data, loading, error } = useRedivisQuery(
    () => getJobs(cluster, startDate, endDate, filters),
    ck(cluster, "jobs", startDate, endDate, fk),
  );
  // Deliberately identical to SummaryCards' key so the two share one query rather than issuing two.
  const { data: summary, loading: lSummary } = useRedivisQuery(
    () => getSummary(cluster, startDate, endDate, { node, group }),
    ck(cluster, "summary", startDate, endDate, node || "", group || ""),
  );
  const { data: filteredSummary, loading: lFiltered } = useRedivisQuery(
    hasFilters ? () => getSummary(cluster, startDate, endDate, filters) : null,
    hasFilters ? ck(cluster, "fsummary", startDate, endDate, fk) : null,
  );
  const { data: timeline, loading: lTimeline } = useRedivisQuery(
    () => getTimeline(cluster, startDate, endDate, filters),
    ck(cluster, "timeline", startDate, endDate, fk),
  );
  const { data: filterOptions, loading: lFilters } = useRedivisQuery(
    () => getFilterOptions(cluster, startDate, endDate, { group, node }),
    ck(cluster, "filters", startDate, endDate, group || "", node || ""),
  );
  const { data: waitTimes, loading: lWait } = useRedivisQuery(
    () => getWaitTimes(cluster, startDate, endDate, filters),
    ck(cluster, "wait", startDate, endDate, fk),
  );

  // The option lists narrow with the global filters, so a locally selected user or partition can
  // stop existing — pick a user, then a group they aren't in. Left alone, the `<select>` would show
  // blank while still filtering by the vanished value.
  useEffect(() => {
    if (!filterOptions) return;
    setLocalFilters((prev) => {
      const next = { ...prev };
      if (next.user && !filterOptions.users.includes(next.user)) next.user = "";
      if (next.partition && !filterOptions.partitions.includes(next.partition)) next.partition = "";
      if (next.state && !filterOptions.states.includes(next.state)) next.state = "";
      return next.user === prev.user && next.partition === prev.partition && next.state === prev.state
        ? prev
        : next;
    });
  }, [filterOptions]);

  const queries = [loading, lSummary, lTimeline, lFilters, lWait, ...(hasFilters ? [lFiltered] : [])];
  const total = queries.length;
  const completed = queries.filter((l) => !l).length;
  const anyLoading = completed < total;

  const details = [];
  if (!lSummary && summary) details.push(`${summary.total_jobs?.toLocaleString()} jobs`);
  if (!lFilters && filterOptions) {
    const parts = [];
    if (filterOptions.users?.length) parts.push(`${filterOptions.users.length} users`);
    if (filterOptions.partitions?.length) parts.push(`${filterOptions.partitions.length} partitions`);
    if (parts.length) details.push(parts.join(", "));
  }
  if (!lTimeline && timeline?.data?.length) details.push(`${timeline.data.length} time periods`);
  if (!lWait && waitTimes?.data?.length) details.push(`${waitTimes.data.length} wait records`);
  if (!loading && data?.jobs?.length) details.push(`${data.jobs.length} rows loaded`);
  if (hasFilters && !lFiltered && filteredSummary) details.push(`${filteredSummary.total_jobs?.toLocaleString()} filtered`);

  if (anyLoading && !data) return <LoadingProgress completed={completed} total={total} label="Loading jobs" details={details} />;
  if (error) return <div className="text-spirited p-4">Error: {error}</div>;

  const filterParts = [
    filters.user && `user: ${filters.user}`,
    filters.state && `state: ${filters.state}`,
    filters.partition && `partition: ${filters.partition}`,
    node && `node: ${node}`,
    group && `group: ${group}`,
  ].filter(Boolean);
  const filterSuffix = filterParts.length > 0 ? ` (${filterParts.join(", ")})` : "";

  const activeSummary = hasFilters && filteredSummary ? filteredSummary : summary;
  const stateData =
    showStates && activeSummary?.state_counts
      ? Object.entries(activeSummary.state_counts).map(([name, value]) => ({
          name,
          value,
        }))
      : [];

  const rawWait = waitTimes?.data || [];

  // Kept in raw minutes at full precision. Converting to a single unit chosen from the maximum and
  // rounding to one decimal used to destroy the very series this chart is about: a median wait of
  // 0.23 minutes expressed in days is 0.00016, which rounded to 0.0 and drew flat along the axis.
  // A log scale cannot plot that zero either, so the precision has to survive to the renderer.
  const waitByDate = {};
  rawWait.forEach((r) => {
    // UTC-based, to match the keys the timeline sequence generates.
    const d = r.period instanceof Date ? r.period : typeof r.period === "number" ? new Date(r.period) : new Date(String(r.period).length === 10 ? r.period + "T00:00:00Z" : r.period);
    const key = isNaN(d.getTime()) ? String(r.period) : d.toISOString().slice(0, 10);
    // A log axis has no room for zero or negative values; drop them so the line breaks instead.
    const pos = (v) => (v != null && v > 0 ? v : null);
    waitByDate[key] = {
      avg: pos(r.avg_wait_minutes),
      median: pos(r.median_wait_minutes),
      max: pos(r.max_wait_minutes),
    };
  });

  const timelineGran = timeline?.granularity || "day";

  function parsePeriod(val) {
    if (val == null) return null;
    if (val instanceof Date) return val;
    if (typeof val === "number") return new Date(val);
    const s = String(val);
    // Parsed as UTC, not local: these are whole dates, and reading them in a zone ahead of UTC
    // would shift them a day and mislabel the period.
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + "T00:00:00Z");
    return new Date(s);
  }

  function formatPeriodLabel(val) {
    const d = parsePeriod(val);
    if (!d || isNaN(d.getTime())) return String(val);
    const utc = { timeZone: "UTC" };
    const fmt = (dt) => dt.toLocaleDateString("en-US", { month: "short", day: "numeric", ...utc });
    if (timelineGran === "week") {
      const end = new Date(d);
      end.setDate(end.getDate() + 6);
      return `${fmt(d)} – ${fmt(end)}`;
    }
    if (timelineGran === "month") {
      return d.toLocaleDateString("en-US", { month: "short", year: "numeric", ...utc });
    }
    return fmt(d);
  }

  function periodKey(val) {
    const d = parsePeriod(val);
    if (!d || isNaN(d.getTime())) return String(val);
    return d.toISOString().slice(0, 10);
  }

  const countByKey = {};
  (timeline?.data || []).forEach((r) => {
    countByKey[periodKey(r.period)] = r.count;
  });

  // Walk the whole range rather than the rows that came back, so an idle period occupies its own
  // slot on the axis. Note the two series treat a missing period differently, and must: no jobs
  // submitted really is a count of zero, but it is *not* a wait of zero — there was nothing to
  // wait. Leaving the wait null lets `connectNulls={false}` break the line instead of drawing a
  // trend through months that hold no data.
  const sequence = periodSequenceKeys(startDate, endDate, timelineGran);
  const keys = sequence.length ? sequence : Object.keys(countByKey).sort();

  const combinedData = keys.map((key) => ({
    date: key,
    label: formatPeriodLabel(key),
    count: countByKey[key] ?? 0,
    avg: waitByDate[key]?.avg ?? null,
    median: waitByDate[key]?.median ?? null,
    max: waitByDate[key]?.max ?? null,
  }));

  // A log axis needs an explicit positive domain — recharts cannot infer one. Pad by half a
  // multiplicative step so the extreme points sit inside the plot rather than on its edge, and
  // widen a degenerate range so a single period still renders an axis.
  const waitValues = combinedData
    .flatMap((d) => [d.avg, d.median, d.max])
    .filter((v) => v != null && v > 0);
  let waitDomain = null;
  let waitTicks = [];
  if (waitValues.length) {
    let lo = Math.min(...waitValues) / 1.5;
    let hi = Math.max(...waitValues) * 1.5;
    if (hi / lo < 4) {
      lo /= 2;
      hi *= 2;
    }
    waitDomain = [lo, hi];
    waitTicks = WAIT_TICKS_MINUTES.filter((t) => t >= lo && t <= hi);
  }

  // Priced client-side from the same CPU / RAM / GPU columns the SQL aggregate uses, so the
  // per-row figures and the total agree by construction. Skipped entirely where the cluster has no
  // trustworthy elapsed time to bill.
  const jobsWithCost = showCost
    ? (data?.jobs || []).map((job) => {
        const cost = jobCost({
          cpus: job.NCPUS,
          memGb: job.ReqMem_GB,
          gpus: job.gpu_count,
          elapsedSeconds: job.ElapsedRaw,
        });
        return {
          ...job,
          ec2_cost_usd: cost.costUsd,
          ec2_instance: cost.oversized ? `${cost.instanceType} †` : cost.instanceType,
          ec2_oversized: cost.oversized,
        };
      })
    : data?.jobs || [];

  return (
    <div className="space-y-6">
      <div className="flex gap-3 items-center">
        {showStates && (
          <select
            className="border border-black-20 rounded px-3 py-1.5 text-sm bg-white"
            value={localFilters.state}
            onChange={(e) => setLocalFilters({ ...localFilters, state: e.target.value })}
          >
            <option value="">All states</option>
            {(filterOptions?.states || []).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
        <select
          className="border border-black-20 rounded px-3 py-1.5 text-sm bg-white"
          value={localFilters.user}
          onChange={(e) => setLocalFilters({ ...localFilters, user: e.target.value })}
        >
          <option value="">All users</option>
          {(filterOptions?.users || []).map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
        <select
          className="border border-black-20 rounded px-3 py-1.5 text-sm bg-white"
          value={localFilters.partition}
          onChange={(e) =>
            setLocalFilters({ ...localFilters, partition: e.target.value })
          }
        >
          <option value="">All partitions</option>
          {(filterOptions?.partitions || []).map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        {hasFilters && (
          <button
            onClick={() => setLocalFilters({ state: "", user: "", partition: "" })}
            className="text-sm text-black-60 hover:text-black-su px-2"
          >
            Clear
          </button>
        )}
      </div>

      {anyLoading && data && (
        <LoadingProgress completed={completed} total={total} label="Updating results" details={details} />
      )}

      {!anyLoading && <>
      {hasFilters && filteredSummary && (
        <MiniCards
          data={filteredSummary}
          label="Filtered"
          showCost={showCost}
          showStates={showStates}
        />
      )}

      {stateData.length > 0 && (
        <div className="bg-white rounded-lg shadow border border-black-20 p-4">
          <h3 className="text-lg font-semibold text-black-su mb-3">Jobs by State{filterSuffix}</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={stateData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" />
              <YAxis />
              <Tooltip />
              <Bar isAnimationActive={false} dataKey="value" fill="#B1040E" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {combinedData.length > 0 && (
        <div className="bg-white rounded-lg shadow border border-black-20 p-4">
          <h3 className="text-lg font-semibold text-black-su mb-3">
            Job Submissions &amp; Queue Wait Time{filterSuffix}
          </h3>
          <ResponsiveContainer width="100%" height={350}>
            <ComposedChart data={combinedData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" />
              <YAxis yAxisId="left" label={{ value: "Jobs", angle: -90, position: "insideLeft" }} />
              <YAxis
                yAxisId="right"
                orientation="right"
                scale="log"
                domain={waitDomain || ["auto", "auto"]}
                ticks={waitTicks.length ? waitTicks : undefined}
                tickFormatter={fmtWait}
                allowDataOverflow
                label={{ value: "Queue wait (log)", angle: 90, position: "insideRight" }}
              />
              <Tooltip
                formatter={(v, name) =>
                  name === "Jobs" ? v.toLocaleString() : fmtWait(v)
                }
              />
              <Legend />
              <Bar isAnimationActive={false} yAxisId="left" dataKey="count" fill="#4298B5" name="Jobs" opacity={0.4} />
              {/* Dots are not decoration here. Once idle periods break the lines, a period whose
                  neighbours are both empty becomes a single point, and a lone point on a dotless
                  line draws nothing at all — Dec 2025 above has 33 jobs averaging a 94-minute wait
                  and would otherwise be invisible. They carry an explicit fill because recharts
                  defaults a dot to white, which on a white card is the same as not drawing it. */}
              <Line isAnimationActive={false} yAxisId="right" type="monotone" dataKey="median" stroke={WAIT_COLORS.median} strokeWidth={2} dot={waitDot(WAIT_COLORS.median)} activeDot={{ r: 5 }} name="Median wait" connectNulls={false} />
              <Line isAnimationActive={false} yAxisId="right" type="monotone" dataKey="avg" stroke={WAIT_COLORS.avg} strokeWidth={2} dot={waitDot(WAIT_COLORS.avg)} activeDot={{ r: 5 }} name="Avg wait" connectNulls={false} />
              <Line isAnimationActive={false} yAxisId="right" type="monotone" dataKey="max" stroke={WAIT_COLORS.max} strokeWidth={1} strokeDasharray="4 4" dot={waitDot(WAIT_COLORS.max, 2.5)} activeDot={{ r: 4 }} name="Max wait" connectNulls={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      <JobTable
        data={{ ...data, jobs: jobsWithCost }}
        sort={sort}
        setSort={setSort}
        columns={columns}
        showCost={showCost}
      />
      </>}
    </div>
  );
}
