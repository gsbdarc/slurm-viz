import { useState, useEffect } from "react";
import { useRedivisQuery } from "../hooks/useRedivisQuery";
import { getSummary, getJobs, getTimeline, getFilterOptions, getWaitTimes, ck } from "../redivis/queries";
import { jobCost, formatUsd } from "../lib/ec2";
import LoadingProgress from "./LoadingProgress";
import JobTable, { jobColumnsFor } from "./JobTable";
import { parsePeriod, formatPeriod } from "../lib/periods";
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
import ChartFigure, { fmtCount, topList, peak, sumOf } from "./ChartFigure";

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
      <div className="text-xs font-medium text-cool-grey uppercase tracking-wide mb-2">
        {label}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
        {cards.map((c) => (
          <div
            key={c.label}
            className="bg-white rounded-lg shadow-sm border border-black-20 p-2 text-center"
          >
            <div className="text-lg font-bold text-black-su">{c.value}</div>
            <div className="text-xs text-cool-grey">{c.label}</div>
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

/**
 * Validated as a categorical set: worst adjacent pair ΔE 16.1 (protan), 16.8 normal vision.
 * `avg` was Poppy, which fails 3:1 against the plot; Poppy Dark clears that but sits ΔE 12.8 from
 * `max` under normal vision, below the 15 floor. Digital Blue clears both.
 */
const WAIT_COLORS = { median: "#008566", avg: "#006CB8", max: "#B83A4B" };

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

export default function JobsDashboard({ cluster, startDate, endDate, node, group }) {
  const [localFilters, setLocalFilters] = useState({
    state: "",
    user: "",
    partition: "",
    agentOnly: false,
  });
  const [sort, setSort] = useState({ col: null, asc: true });
  const showCost = cluster.features.ec2Cost;
  const showStates = cluster.features.jobStates;
  const showAgents = cluster.features.agentDetection;
  const columns = jobColumnsFor(cluster);

  // With no state control rendered, a stale `state` must not linger in the filter set or the cache
  // key — it would filter invisibly and put a "Filtered" row on screen with nothing to explain it.
  const activeState = showStates ? localFilters.state : "";

  // Same reasoning as `activeState`: on a cluster with no provenance columns the checkbox is not
  // rendered, so a toggle left on from the Yen tab must not survive into the filter set or the cache
  // key. `buildWhere` also guards, but dropping it here keeps "Filtered" off screen when there is no
  // visible control to explain it.
  const activeAgentOnly = showAgents ? Boolean(localFilters.agentOnly) : false;

  // `node` is a global filter owned by App; the rest are local to this tab. The summary strip
  // above already reflects `node`, so only the local filters justify a second "Filtered" row —
  // otherwise it would restate the same numbers.
  const filters = {
    ...localFilters,
    state: activeState,
    agentOnly: activeAgentOnly,
    node,
    group,
  };
  const hasFilters = Boolean(
    activeState || localFilters.user || localFilters.partition || activeAgentOnly,
  );
  const fk =
    `${activeState}_${localFilters.user}_${localFilters.partition}_` +
    `${node || ""}_${group || ""}_${activeAgentOnly ? "agent" : ""}`;

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
  if (error) return <div className="text-digital-red p-4">Error: {error}</div>;

  const filterParts = [
    filters.user && `user: ${filters.user}`,
    filters.state && `state: ${filters.state}`,
    filters.partition && `partition: ${filters.partition}`,
    node && `node: ${node}`,
    group && `group: ${group}`,
    filters.agentOnly && "agent-submitted only",
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
    label: formatPeriod(key, timelineGran),
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
        {showAgents && (
          <label
            className="flex items-center gap-2 text-sm border border-black-20 rounded px-3 py-1.5 bg-white cursor-pointer"
            title={
              "Only jobs whose WorkDir or SubmitLine contains an agent scratch or worktree path. " +
              "Undercounts: an agent submitting a script from the project tree leaves no trace."
            }
          >
            <input
              type="checkbox"
              checked={Boolean(localFilters.agentOnly)}
              onChange={(e) =>
                setLocalFilters({ ...localFilters, agentOnly: e.target.checked })
              }
            />
            AI agent only
          </label>
        )}
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
            onClick={() =>
              setLocalFilters({ state: "", user: "", partition: "", agentOnly: false })
            }
            className="text-sm text-cool-grey hover:text-black-su px-2"
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
          <ChartFigure summary={`Jobs by state: ${topList(stateData, "name", "value", (v) => `${fmtCount(v)} jobs`, 4)}.`}>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={stateData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" />
                <YAxis />
                <Tooltip />
                <Bar isAnimationActive={false} dataKey="value" fill="#B1040E" />
              </BarChart>
            </ResponsiveContainer>
          </ChartFigure>
        </div>
      )}

      {combinedData.length > 0 && (
        <div className="bg-white rounded-lg shadow border border-black-20 p-4">
          <h3 className="text-lg font-semibold text-black-su mb-3">
            Job Submissions &amp; Queue Wait Time{filterSuffix}
          </h3>
          <ChartFigure summary={`Jobs submitted per ${timelineGran}: ${fmtCount(sumOf(combinedData, (r) => r.count))} in total${(() => { const p = peak(combinedData, "label", (r) => r.count); return p ? `, peaking at ${fmtCount(p.value)} in ${p.at}` : ""; })()}${(() => { const m = peak(combinedData, "label", (r) => r.median); return m ? `. Median queue wait peaked at ${fmtWait(m.value)} in ${m.at}` : ""; })()}.`}>
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
          </ChartFigure>
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
