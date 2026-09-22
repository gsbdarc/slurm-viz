import { useState, useEffect } from "react";
import { useRedivisQuery } from "../hooks/useRedivisQuery";
import { getUtilization, getJobs, getFilterOptions, ck } from "../redivis/queries";
import LoadingProgress from "./LoadingProgress";
import JobTable, { jobColumnsFor } from "./JobTable";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import ChartFigure, { fmtCount, topList, peak, sumOf } from "./ChartFigure";

/**
 * One hue for every histogram: each is a single series of counts, so there is no identity to
 * encode, and the four charts read as one family. Digital Blue passes the palette validator
 * against the white card surface; Lagunita, the first choice, fails its chroma floor.
 */
const BAR_COLOR = "#006CB8";

const BIN_LABELS = ["0–10", "10–20", "20–30", "30–40", "40–50", "50–60", "60–70", "70–80", "80–90", "90–100", ">100"];

/** The jobs-list columns this tab shows — what was asked for next to what was used. */
const UTIL_COLUMN_KEYS = [
  "JobID", "JobName", "User", "Partition", "State",
  "NCPUS", "cpu_used_pct", "ReqMem_GB", "mem_used_pct",
  "gpu_count", "gpu_util_pct", "gpu_mem_pct",
  "ElapsedRaw", "Submit", "NodeList",
];

function fmtPct(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  if (n > 0 && n < 1) return "<1%";
  return `${n < 10 ? n.toFixed(1).replace(/\.0$/, "") : Math.round(n)}%`;
}

function fmtCompact(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v);
}

function fmtInt(v) {
  return v == null ? "—" : Number(v).toLocaleString();
}

function StatTile({ label, value, sub }) {
  return (
    <div className="bg-fog-light rounded p-2">
      <div className="text-xs text-cool-grey">{label}</div>
      <div className="text-xl font-semibold text-black-su">{value}</div>
      {sub && <div className="text-xs text-cool-grey leading-tight">{sub}</div>}
    </div>
  );
}

function HistogramTooltip({ active, payload, measured }) {
  if (!active || !payload?.length) return null;
  const { label, jobs } = payload[0].payload;
  const share = measured ? (100 * jobs) / measured : 0;
  return (
    <div className="bg-white border border-black-20 rounded shadow px-2 py-1 text-xs text-black-su">
      <div className="font-medium">{label}%</div>
      <div className="tabular-nums">
        {fmtInt(jobs)} jobs · {fmtPct(share)} of measured
      </div>
    </div>
  );
}

/**
 * Jobs by share of their allocation used, in 10% bins. Every bin is drawn, empty or not, so the
 * x-axis is the same scale on all four cards and a gap reads as "no jobs here", not a missing bar.
 */
function Histogram({ bins, measured, xLabel }) {
  const data = BIN_LABELS.map((label, i) => ({ label, jobs: bins[i] || 0 }));
  return (
    <ChartFigure summary={`${xLabel}: of ${fmtCount(measured)} measured jobs, ${Math.round((100 * (bins[0] || 0)) / (measured || 1))}% are under 10% and ${Math.round((100 * [5, 6, 7, 8, 9, 10].reduce((s, i) => s + (bins[i] || 0), 0)) / (measured || 1))}% are at 50% or more.`}>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }} barCategoryGap={2}>
          <CartesianGrid vertical={false} stroke="#EBEAEA" />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 10, fill: "#53565A" }}
            interval={0}
            tickLine={false}
            axisLine={{ stroke: "#B5B4AE" }}
            label={{ value: xLabel, position: "insideBottom", offset: -2, fontSize: 11, fill: "#53565A" }}
            height={34}
          />
          <YAxis
            tick={{ fontSize: 10, fill: "#53565A" }}
            tickFormatter={fmtCompact}
            tickLine={false}
            axisLine={false}
            width={40}
            allowDecimals={false}
          />
          <Tooltip
            cursor={{ fill: "#EBEAEA" }}
            content={<HistogramTooltip measured={measured} />}
          />
          <Bar dataKey="jobs" fill={BAR_COLOR} radius={[4, 4, 0, 0]} maxBarSize={24} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFigure>
  );
}

function ResourceCard({ title, subtitle, measured, tiles, bins, xLabel, empty }) {
  return (
    <div className="bg-white rounded-lg shadow border border-black-20 p-4">
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <h3 className="font-semibold text-black-su">{title}</h3>
        <span className="text-xs text-cool-grey">
          {measured ? `${fmtInt(measured)} jobs measured` : ""}
        </span>
      </div>
      {measured ? (
        <>
          <div className="grid grid-cols-3 gap-2 mb-3">
            {tiles.map((t) => (
              <StatTile key={t.label} {...t} />
            ))}
          </div>
          <Histogram bins={bins} measured={measured} xLabel={xLabel} />
          {subtitle && <p className="text-xs text-cool-grey mt-1 leading-snug">{subtitle}</p>}
        </>
      ) : (
        <p className="text-sm text-cool-grey py-8 text-center">{empty}</p>
      )}
    </div>
  );
}

/**
 * Requested vs used, for memory, CPU and GPUs.
 *
 * Every figure here counts only jobs whose usage Slurm actually measured — the same jobs whose
 * columns are populated in the list below. See `usage` in `lib/clusters.js` for what is excluded
 * and why (pre-2026-01-22, running, resized, and unsampled short GPU jobs), and `getUtilization`
 * for why the tiles pair a median with a time-weighted share.
 */
export default function UtilizationDashboard({ cluster, startDate, endDate, node, group }) {
  const [localFilters, setLocalFilters] = useState({ user: "", partition: "" });
  const [sort, setSort] = useState({ col: null, asc: true });

  const filters = { ...localFilters, node, group };
  const hasFilters = Boolean(localFilters.user || localFilters.partition);
  const fk = `${localFilters.user}_${localFilters.partition}_${node || ""}_${group || ""}`;

  const { data, loading, error } = useRedivisQuery(
    () => getUtilization(cluster, startDate, endDate, filters),
    ck(cluster, "utilization", startDate, endDate, fk),
  );
  const { data: jobs, loading: lJobs } = useRedivisQuery(
    () => getJobs(cluster, startDate, endDate, { ...filters, usageOnly: true }),
    ck(cluster, "utilJobs", startDate, endDate, fk),
  );
  // Same key as the Jobs tab and App, so the three share one query.
  const { data: filterOptions, loading: lFilters } = useRedivisQuery(
    () => getFilterOptions(cluster, startDate, endDate, { group, node }),
    ck(cluster, "filters", startDate, endDate, group || "", node || ""),
  );

  // As on the Jobs tab: a selection that drops out of the narrowed option list must not keep
  // filtering invisibly behind a blank `<select>`.
  useEffect(() => {
    if (!filterOptions) return;
    setLocalFilters((prev) => {
      const next = { ...prev };
      if (next.user && !filterOptions.users.includes(next.user)) next.user = "";
      if (next.partition && !filterOptions.partitions.includes(next.partition)) next.partition = "";
      return next.user === prev.user && next.partition === prev.partition ? prev : next;
    });
  }, [filterOptions]);

  const queries = [loading, lJobs, lFilters];
  const completed = queries.filter((l) => !l).length;
  const anyLoading = completed < queries.length;
  const details = [];
  if (!loading && data?.summary?.jobs_in_range != null)
    details.push(`${fmtInt(data.summary.jobs_in_range)} jobs in range`);
  if (!lJobs && jobs?.jobs?.length) details.push(`${jobs.jobs.length} rows loaded`);

  if (loading && !data)
    return (
      <LoadingProgress
        completed={completed}
        total={queries.length}
        label="Loading utilization"
        details={details}
      />
    );
  if (error) return <div className="text-digital-red p-4">Error: {error}</div>;

  const s = data?.summary || {};
  const bins = { mem: {}, cpu: {}, gpu_util: {}, gpu_mem: {} };
  (data?.histogram || []).forEach((r) => {
    if (bins[r.metric]) bins[r.metric][r.bin] = Number(r.jobs);
  });

  const since = cluster.usage?.since;
  const beforeSince = since && startDate < since;
  const measuredAny = Number(s.mem_jobs || 0) > 0;
  const gpuIdleShare = s.gpu_hours ? (100 * s.gpu_idle_hours) / s.gpu_hours : null;

  const columns = jobColumnsFor(cluster).filter((c) => UTIL_COLUMN_KEYS.includes(c.key));

  return (
    <div className="space-y-6">
      <div className="flex gap-3 items-center flex-wrap">
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
          onChange={(e) => setLocalFilters({ ...localFilters, partition: e.target.value })}
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
            onClick={() => setLocalFilters({ user: "", partition: "" })}
            className="text-sm text-cool-grey hover:text-black-su px-2"
          >
            Clear
          </button>
        )}
      </div>

      <div className="bg-white rounded-lg shadow border border-black-20 p-3 text-sm text-cool-grey leading-snug">
        {measuredAny ? (
          <>
            Usage was measured for <span className="font-medium text-black-su">{fmtInt(s.mem_jobs)}</span>{" "}
            of {fmtInt(s.jobs_in_range)} jobs in this range.{" "}
          </>
        ) : null}
        Slurm records usage only for finished jobs submitted on or after {since}; running jobs,
        jobs that never started, and resized jobs are left out rather than counted as zero.
        {beforeSince && (
          <span className="font-medium text-black-su">
            {" "}This range starts before {since}, so its earlier jobs are not included.
          </span>
        )}{" "}
        <span className="text-cool-grey">
          <em>Median</em> is the typical job; <em>time-weighted</em> is resource-hours used over
          resource-hours reserved, where long jobs count for more.
        </span>
      </div>

      {anyLoading && data && (
        <LoadingProgress
          completed={completed}
          total={queries.length}
          label="Updating results"
          details={details}
        />
      )}

      {!anyLoading && (
        <>
          {!measuredAny ? (
            <div className="bg-white rounded-lg shadow border border-black-20 p-8 text-center text-cool-grey">
              No jobs in this range have usage data. Usage is recorded from {since} onward.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <ResourceCard
                title="Memory"
                measured={Number(s.mem_jobs)}
                bins={bins.mem}
                xLabel="Peak memory, % of request"
                tiles={[
                  { label: "Median job", value: fmtPct(s.mem_median), sub: "of its request" },
                  {
                    label: "Time-weighted",
                    value: fmtPct(100 * s.mem_weighted),
                    sub: "of requested GiB-hours",
                  },
                  {
                    label: "Never used",
                    value: fmtCompact(s.mem_unused_gib_hours),
                    sub: "GiB-hours above peak",
                  },
                ]}
                subtitle="Measured at each job's peak, so the unused figure is a floor: most jobs sit below their peak most of the time."
                empty="No jobs with memory data in this range."
              />
              <ResourceCard
                title="CPU"
                measured={Number(s.cpu_jobs)}
                bins={bins.cpu}
                xLabel="CPU time, % of cores × runtime"
                tiles={[
                  { label: "Median job", value: fmtPct(s.cpu_median), sub: "of its cores busy" },
                  {
                    label: "Time-weighted",
                    value: fmtPct(100 * s.cpu_weighted),
                    sub: "of reserved CPU-hours",
                  },
                  { label: "Idle", value: fmtCompact(s.cpu_idle_hours), sub: "CPU-hours reserved, unused" },
                ]}
                subtitle="Readings above 105% are left out: they come from cancelled jobs whose processes outlived the recorded runtime."
                empty="No jobs with CPU data in this range."
              />
              {/* Hidden rather than shown empty when the range has no sampled GPU jobs. */}
              {Number(s.gpu_jobs) > 0 && (
                <ResourceCard
                  title="GPU compute"
                  measured={Number(s.gpu_jobs)}
                  bins={bins.gpu_util}
                  xLabel="Busiest 30s sample, % per GPU"
                  tiles={[
                    { label: "Median peak", value: fmtPct(s.gpu_util_median), sub: "busiest sample" },
                    { label: "GPU-hours", value: fmtCompact(s.gpu_hours), sub: "allocated" },
                    {
                      label: "Never used",
                      value: fmtCompact(s.gpu_idle_hours),
                      sub: `GPU-hours at 0%${gpuIdleShare != null ? ` (${fmtPct(gpuIdleShare)})` : ""}`,
                    },
                  ]}
                  subtitle="Slurm keeps only each job's busiest 30-second sample, not an average — so a high peak does not mean the GPU stayed busy. A job at 0% never registered GPU activity at all."
                  empty="No sampled GPU jobs in this range (jobs under 30 seconds are never sampled)."
                />
              )}
              {/* Separate test: a range whose only GPU jobs span two models has compute data but no memory denominator. */}
              {Number(s.gpu_mem_jobs) > 0 && (
                <ResourceCard
                  title="GPU memory"
                  measured={Number(s.gpu_mem_jobs)}
                  bins={bins.gpu_mem}
                  xLabel="Peak GPU memory, % of GPU capacity"
                  tiles={[
                    { label: "Median peak", value: fmtPct(s.gpu_mem_median), sub: "of GPU memory" },
                    {
                      label: "Time-weighted",
                      value: fmtPct(100 * s.gpu_mem_weighted),
                      sub: "peak share, by GPU-hours",
                    },
                    { label: "Jobs", value: fmtInt(s.gpu_mem_jobs), sub: "with a GPU model match" },
                  ]}
                  subtitle="Capacity is the GPU model's memory: A30 24 GiB, A40 48 GiB, H200 141 GiB."
                  empty="No sampled GPU jobs in this range."
                />
              )}
            </div>
          )}

          <div>
            <h3 className="font-semibold text-black-su mb-3">Measured jobs</h3>
            <JobTable
              data={jobs || { jobs: [], total: 0 }}
              sort={sort}
              setSort={setSort}
              columns={columns}
              showCost={false}
            />
          </div>
        </>
      )}
    </div>
  );
}
