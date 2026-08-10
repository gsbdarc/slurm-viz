import { useState } from "react";
import { useRedivisQuery } from "../hooks/useRedivisQuery";
import { getSummary, getJobs, getTimeline, getFilterOptions, getWaitTimes } from "../redivis/queries";
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

function MiniCards({ data, label }) {
  if (!data) return null;

  const cards = [
    { label: "Total Jobs", value: data.total_jobs?.toLocaleString() },
    { label: "Unique Users", value: data.unique_users },
    { label: "Partitions", value: data.unique_partitions },
    { label: "EC2 Equivalent", value: formatUsd(data.total_ec2_cost_usd) },
  ];

  if (data.state_counts) {
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

const JOB_COLUMNS = [
  { key: "JobID", label: "Job ID" },
  { key: "JobName", label: "Name" },
  { key: "User", label: "User" },
  { key: "Partition", label: "Partition" },
  { key: "State", label: "State" },
  { key: "NCPUS", label: "CPUs", numeric: true },
  { key: "ReqMem_GB", label: "Memory (GB)", numeric: true },
  { key: "gpu_count", label: "GPUs", numeric: true },
  { key: "ec2_cost_usd", label: "EC2 Cost", currency: true },
  { key: "ec2_instance", label: "EC2 Instance" },
  { key: "wait_seconds", label: "Queue Wait (s)", numeric: true },
  { key: "ElapsedRaw", label: "Elapsed (s)", numeric: true },
  { key: "Submit", label: "Submit", date: true },
  { key: "Start", label: "Start", date: true },
  { key: "End", label: "End", date: true },
  { key: "NodeList", label: "Nodes" },
];

function JobTable({ data, sort, setSort }) {
  const handleSort = (col) => {
    setSort((prev) =>
      prev.col === col ? { col, asc: !prev.asc } : { col, asc: true },
    );
  };

  const colMeta = Object.fromEntries(JOB_COLUMNS.map((c) => [c.key, c]));
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
        <p className="text-xs text-black-60 mt-1">
          EC2 cost across all {data.total?.toLocaleString()} matching jobs:{" "}
          <span className="font-medium text-black-su">
            {formatUsd(data.total_ec2_cost_usd)}
          </span>
          {anyOversized && " · † job exceeds every catalog instance; cost shown is a lower bound"}
        </p>
      </div>
      <div className="overflow-x-auto max-h-96">
        <table className="w-full text-sm text-left">
          <thead className="bg-fog sticky top-0">
            <tr>
              {JOB_COLUMNS.map((col) => (
                <th
                  key={col.key}
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
                {JOB_COLUMNS.map((col) => (
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

export default function JobsDashboard({ startDate, endDate, node }) {
  const [localFilters, setLocalFilters] = useState({
    state: "",
    user: "",
    partition: "",
  });
  const [sort, setSort] = useState({ col: null, asc: true });

  // `node` is a global filter owned by App; the rest are local to this tab. The summary strip
  // above already reflects `node`, so only the local filters justify a second "Filtered" row —
  // otherwise it would restate the same numbers.
  const filters = { ...localFilters, node };
  const hasFilters = Boolean(
    localFilters.state || localFilters.user || localFilters.partition,
  );
  const fk = `${localFilters.state}_${localFilters.user}_${localFilters.partition}_${node || ""}`;

  const { data, loading, error } = useRedivisQuery(
    () => getJobs(startDate, endDate, filters),
    `jobs_${startDate}_${endDate}_${fk}`,
  );
  const { data: summary, loading: lSummary } = useRedivisQuery(
    () => getSummary(startDate, endDate, { node }),
    `summary_${startDate}_${endDate}_${node || ""}`,
  );
  const { data: filteredSummary, loading: lFiltered } = useRedivisQuery(
    hasFilters ? () => getSummary(startDate, endDate, filters) : null,
    hasFilters ? `fsummary_${startDate}_${endDate}_${fk}` : null,
  );
  const { data: timeline, loading: lTimeline } = useRedivisQuery(
    () => getTimeline(startDate, endDate, filters),
    `timeline_${startDate}_${endDate}_${fk}`,
  );
  const { data: filterOptions, loading: lFilters } = useRedivisQuery(
    () => getFilterOptions(startDate, endDate),
    `filters_${startDate}_${endDate}`,
  );
  const { data: waitTimes, loading: lWait } = useRedivisQuery(
    () => getWaitTimes(startDate, endDate, filters),
    `wait_${startDate}_${endDate}_${fk}`,
  );

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
  ].filter(Boolean);
  const filterSuffix = filterParts.length > 0 ? ` (${filterParts.join(", ")})` : "";

  const activeSummary = hasFilters && filteredSummary ? filteredSummary : summary;
  const stateData = activeSummary?.state_counts
    ? Object.entries(activeSummary.state_counts).map(([name, value]) => ({
        name,
        value,
      }))
    : [];

  const rawWait = waitTimes?.data || [];
  const maxWaitMin = Math.max(0, ...rawWait.map((r) => r.max_wait_minutes || 0));
  const waitUnit = maxWaitMin >= 1440 ? "days" : maxWaitMin >= 60 ? "hours" : "minutes";
  const waitDivisor = waitUnit === "days" ? 1440 : waitUnit === "hours" ? 60 : 1;

  const waitByDate = {};
  rawWait.forEach((r) => {
    const d = r.period instanceof Date ? r.period : typeof r.period === "number" ? new Date(r.period) : new Date(String(r.period).length === 10 ? r.period + "T00:00:00" : r.period);
    const key = isNaN(d.getTime()) ? String(r.period) : d.toISOString().slice(0, 10);
    waitByDate[key] = {
      avg: r.avg_wait_minutes != null ? +(r.avg_wait_minutes / waitDivisor).toFixed(1) : null,
      median: r.median_wait_minutes != null ? +(r.median_wait_minutes / waitDivisor).toFixed(1) : null,
      max: r.max_wait_minutes != null ? +(r.max_wait_minutes / waitDivisor).toFixed(1) : null,
    };
  });

  const timelineGran = timeline?.granularity || "day";

  function parsePeriod(val) {
    if (val == null) return null;
    if (val instanceof Date) return val;
    if (typeof val === "number") return new Date(val);
    const s = String(val);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + "T00:00:00");
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

  const combinedData = (timeline?.data || []).map((r) => {
    const key = periodKey(r.period);
    return { date: key, label: formatPeriodLabel(r.period), count: r.count, ...waitByDate[key] };
  });

  // Priced client-side from the same CPU / RAM / GPU columns the SQL aggregate uses, so the
  // per-row figures and the total agree by construction.
  const jobsWithCost = (data?.jobs || []).map((job) => {
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
  });

  return (
    <div className="space-y-6">
      <div className="flex gap-3 items-center">
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
        <MiniCards data={filteredSummary} label="Filtered" />
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
              <Bar dataKey="value" fill="#B1040E" />
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
              <YAxis yAxisId="right" orientation="right" label={{ value: `Wait (${waitUnit})`, angle: 90, position: "insideRight" }} />
              <Tooltip />
              <Legend />
              <Bar yAxisId="left" dataKey="count" fill="#4298B5" name="Jobs" opacity={0.4} />
              <Line yAxisId="right" type="monotone" dataKey="median" stroke="#008566" strokeWidth={2} dot={false} name={`Median (${waitUnit})`} />
              <Line yAxisId="right" type="monotone" dataKey="avg" stroke="#E98300" strokeWidth={2} dot={false} name={`Avg (${waitUnit})`} />
              <Line yAxisId="right" type="monotone" dataKey="max" stroke="#B83A4B" strokeWidth={1} strokeDasharray="4 4" dot={false} name={`Max (${waitUnit})`} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      <JobTable
        data={{ ...data, jobs: jobsWithCost }}
        sort={sort}
        setSort={setSort}
      />
      </>}
    </div>
  );
}
