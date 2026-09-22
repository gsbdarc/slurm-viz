import { useState, useEffect } from "react";
import { useRedivisQuery } from "../hooks/useRedivisQuery";
import { getUserSummaries, getUsersByPeriod, getFilterOptions, ck } from "../redivis/queries";
import { formatUsd } from "../lib/ec2";
import { formatPeriod, periodSortKey, periodLabel } from "../lib/periods";
import LoadingProgress from "./LoadingProgress";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import ChartFigure, { fmtCount, topList, peak, sumOf } from "./ChartFigure";

const COLORS = [
  "#B1040E",
  "#008566",
  "#B36700",
  "#4298B5",
  "#175E54",
  "#620059",
  "#007C92",
  "#E94C0A",
];

const USER_COLUMNS = [
  { key: "User", label: "User" },
  { key: "Group", label: "Group", feature: "groups" },
  { key: "job_count", label: "Jobs", numeric: true },
  { key: "total_cpus", label: "Total CPUs", numeric: true },
  { key: "total_elapsed", label: "Elapsed (s)", numeric: true },
  { key: "cpu_hours", label: "CPU Hours", numeric: true },
  { key: "ec2_cost_usd", label: "EC2 Cost", currency: true, feature: "ec2Cost" },
  { key: "total_wait_hours", label: "Queue Wait (hrs)", numeric: true },
  // Utilization, computed exactly as on the Utilization tab (`usageRowsCte`). Sort any of these to
  // rank users; the unused and idle totals rank by how much was held back, which is what matters
  // for contention, rather than by the ratio, which flatters or punishes small users.
  {
    key: "usage_jobs",
    label: "Measured Jobs",
    numeric: true,
    feature: "usage",
    title:
      "Jobs with usage data: finished, submitted on or after 2026-01-22, and not resized. The " +
      "utilization columns cover only these.",
  },
  {
    key: "mem_weighted_pct",
    label: "Mem Used",
    numeric: true,
    percent: true,
    feature: "usage",
    title: "Peak memory as a share of requested memory, weighted by runtime (GiB-hours used ÷ requested).",
  },
  {
    key: "mem_unused_gib_hours",
    label: "Unused Mem (GiB-h)",
    numeric: true,
    feature: "usage",
    title:
      "Memory requested above each job's peak, times its runtime. A floor on waste, since jobs sit " +
      "below their peak most of the time.",
  },
  {
    key: "cpu_weighted_pct",
    label: "CPU Used",
    numeric: true,
    percent: true,
    feature: "usage",
    title: "CPU time as a share of cores × runtime, across the user's measured jobs.",
  },
  {
    key: "cpu_idle_hours",
    label: "Idle CPU-h",
    numeric: true,
    feature: "usage",
    title: "Core-hours reserved but not used.",
  },
  {
    key: "gpu_idle_hours",
    label: "Idle GPU-h",
    numeric: true,
    feature: "usage",
    title:
      "GPU-hours in jobs where no 30-second sample ever caught the GPU working. Users with no " +
      "GPU jobs read 0.",
  },
];

/** Columns the cluster can actually populate — same idiom as `jobColumnsFor`. */
function userColumnsFor(cluster) {
  return USER_COLUMNS.filter((c) => !c.feature || cluster.features[c.feature]);
}

const numericUserCols = new Set(
  USER_COLUMNS.filter((c) => c.numeric || c.currency).map((c) => c.key),
);

function UserTable({ users, columns }) {
  const [sort, setSort] = useState({ col: "cpu_hours", asc: false });

  const handleSort = (col) => {
    setSort((prev) =>
      prev.col === col ? { col, asc: !prev.asc } : { col, asc: false },
    );
  };

  const sorted = [...users].sort((a, b) => {
    if (!sort.col) return 0;
    let av = a[sort.col], bv = b[sort.col];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (numericUserCols.has(sort.col)) {
      const na = Number(av), nb = Number(bv);
      return sort.asc ? na - nb : nb - na;
    }
    return sort.asc
      ? String(av).localeCompare(String(bv))
      : String(bv).localeCompare(String(av));
  });

  const fmtVal = (col, val) => {
    if (val == null) return "—";
    if (col.currency) return formatUsd(val);
    if (col.percent) {
      const n = Number(val);
      return n > 0 && n < 1 ? "<1%" : `${Math.round(n)}%`;
    }
    if (col.numeric && typeof val === "number")
      return val % 1 === 0 ? val.toLocaleString() : val.toFixed(1);
    return String(val);
  };

  return (
    <div className="bg-white rounded-lg shadow border border-black-20 overflow-hidden">
      <div className="p-4 border-b border-black-20">
        <h3 className="text-lg font-semibold text-black-su">All Users ({users.length})</h3>
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
            {sorted.map((user, i) => (
              <tr key={i} className="border-t border-black-20 hover:bg-black-10">
                {columns.map((col) => (
                  <td key={col.key} className="px-4 py-2 whitespace-nowrap">
                    {fmtVal(col, user[col.key])}
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

export default function UserDashboard({ cluster, startDate, endDate, node, group }) {
  const [partition, setPartition] = useState("");
  const showCost = cluster.features.ec2Cost;

  const filters = {
    partition: partition || undefined,
    node: node || undefined,
    group: group || undefined,
  };
  const fk = `${partition}_${node || ""}_${group || ""}`;

  const { data: usersData, loading, error } = useRedivisQuery(
    () => getUserSummaries(cluster, startDate, endDate, filters),
    ck(cluster, "users", startDate, endDate, fk),
  );
  const { data: byPeriod, loading: lPeriod } = useRedivisQuery(
    () => getUsersByPeriod(cluster, startDate, endDate, filters),
    ck(cluster, "usersPeriod", startDate, endDate, fk),
  );
  const { data: filterOptions } = useRedivisQuery(
    () => getFilterOptions(cluster, startDate, endDate, { group, node }),
    ck(cluster, "filters", startDate, endDate, group || "", node || ""),
  );

  // The partition list narrows with the global filters, so a selection can stop existing.
  useEffect(() => {
    if (partition && filterOptions && !filterOptions.partitions.includes(partition)) {
      setPartition("");
    }
  }, [partition, filterOptions]);

  const queries = [loading, lPeriod];
  const total = queries.length;
  const completed = queries.filter((l) => !l).length;
  const anyLoading = completed < total;

  const details = [];
  if (!loading && usersData?.length) details.push(`${usersData.length} users`);
  if (!lPeriod && byPeriod?.data?.length) details.push(`${byPeriod.data.length} period records`);
  if (filterOptions?.partitions?.length) details.push(`${filterOptions.partitions.length} partitions`);

  if (loading && !usersData)
    return <LoadingProgress completed={completed} total={total} label="Loading users" details={details} />;
  if (error) return <div className="text-digital-red p-4">Error: {error}</div>;

  const users = usersData || [];
  const topByCpuHours = [...users].sort((a, b) => (b.cpu_hours || 0) - (a.cpu_hours || 0)).slice(0, 10);
  const topByJobCount = [...users].sort((a, b) => (b.job_count || 0) - (a.job_count || 0)).slice(0, 10);
  const topByCost = [...users]
    .sort((a, b) => (b.ec2_cost_usd || 0) - (a.ec2_cost_usd || 0))
    .slice(0, 10);

  const periodRows = byPeriod?.data || [];
  const periodGranularity = byPeriod?.granularity || "month";
  const partitions = [
    ...new Set(periodRows.map((r) => r.Partition)),
  ].sort();

  const periodMap = {};
  periodRows.forEach((r) => {
    const sortKey = periodSortKey(r.period);
    if (!periodMap[sortKey]) periodMap[sortKey] = { period: formatPeriod(r.period, periodGranularity), _sort: sortKey };
    periodMap[sortKey][r.Partition] = r.unique_users;
  });
  const periodData = Object.values(periodMap).sort((a, b) =>
    a._sort.localeCompare(b._sort),
  );
  const granLabel = periodLabel(periodGranularity);

  const suffixParts = [partition, node, group].filter(Boolean);
  const partitionSuffix = suffixParts.length ? ` (${suffixParts.join(", ")})` : "";

  return (
    <div className="space-y-6">
      <div className="flex gap-3 items-center">
        <select
          className="border border-black-20 rounded px-3 py-1.5 text-sm bg-white"
          value={partition}
          onChange={(e) => setPartition(e.target.value)}
        >
          <option value="">All partitions</option>
          {(filterOptions?.partitions || []).map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        {partition && (
          <button
            onClick={() => setPartition("")}
            className="text-sm text-cool-grey hover:text-black-su px-2"
          >
            Clear
          </button>
        )}
      </div>

      {anyLoading && usersData && (
        <LoadingProgress completed={completed} total={total} label="Updating results" details={details} />
      )}

      {!anyLoading && <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {topByCpuHours.length > 0 && topByCpuHours[0].cpu_hours != null && (
          <div className="bg-white rounded-lg shadow border border-black-20 p-4">
            <h3 className="text-lg font-semibold text-black-su mb-3">
              Top Users by CPU Hours{partitionSuffix}
            </h3>
            <ChartFigure summary={`Top users by CPU hours: ${topList(topByCpuHours, "User", "cpu_hours", (v) => `${fmtCount(v)} CPU-hours`)}.`}>
              <ResponsiveContainer width="100%" height={400}>
                <BarChart data={topByCpuHours} layout="vertical" margin={{ left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" />
                  <YAxis dataKey="User" type="category" width={120} tick={{ fontSize: 13 }} />
                  <Tooltip
                    formatter={(v) =>
                      typeof v === "number" ? v.toFixed(1) : v
                    }
                  />
                  <Bar isAnimationActive={false} dataKey="cpu_hours" fill="#B1040E" name="CPU Hours" />
                </BarChart>
              </ResponsiveContainer>
            </ChartFigure>
          </div>
        )}

        {topByJobCount.length > 0 && (
          <div className="bg-white rounded-lg shadow border border-black-20 p-4">
            <h3 className="text-lg font-semibold text-black-su mb-3">
              Top Users by Job Count{partitionSuffix}
            </h3>
            <ChartFigure summary={`Top users by job count: ${topList(topByJobCount, "User", "job_count", (v) => `${fmtCount(v)} jobs`)}.`}>
              <ResponsiveContainer width="100%" height={400}>
                <BarChart data={topByJobCount} layout="vertical" margin={{ left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" />
                  <YAxis dataKey="User" type="category" width={120} tick={{ fontSize: 13 }} />
                  <Tooltip />
                  <Bar isAnimationActive={false} dataKey="job_count" fill="#008566" name="Jobs" />
                </BarChart>
              </ResponsiveContainer>
            </ChartFigure>
          </div>
        )}
      </div>

      {showCost && topByCost.length > 0 && topByCost[0].ec2_cost_usd != null && (
        <div className="bg-white rounded-lg shadow border border-black-20 p-4">
          <h3 className="text-lg font-semibold text-black-su mb-3">
            Top Users by EC2 Cost{partitionSuffix}
          </h3>
          <ChartFigure summary={`Top users by EC2-equivalent cost: ${topList(topByCost, "User", "ec2_cost_usd", formatUsd)}.`}>
            <ResponsiveContainer width="100%" height={400}>
              <BarChart data={topByCost} layout="vertical" margin={{ left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" tickFormatter={formatUsd} />
                <YAxis dataKey="User" type="category" width={120} tick={{ fontSize: 13 }} />
                <Tooltip formatter={(v) => formatUsd(v)} />
                <Bar isAnimationActive={false} dataKey="ec2_cost_usd" fill="#B36700" name="EC2 Cost" />
              </BarChart>
            </ResponsiveContainer>
          </ChartFigure>
        </div>
      )}

      {periodData.length > 0 && (
        <div className="bg-white rounded-lg shadow border border-black-20 p-4">
          <h3 className="text-lg font-semibold text-black-su mb-3">
            Unique Users by {granLabel} by Partition{partitionSuffix}
          </h3>
          <ChartFigure summary={`Unique users per ${granLabel.toLowerCase()} by partition: ${partitions.map((p) => { const pk = peak(periodData, "period", (r) => r[p]); return `${p} up to ${pk ? fmtCount(pk.value) : 0}`; }).join(", ") || "none"}.`}>
            <ResponsiveContainer width="100%" height={350}>
              <BarChart data={periodData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="period" />
                <YAxis />
                <Tooltip />
                <Legend />
                {partitions.map((p, i) => (
                  <Bar

                    isAnimationActive={false}

                    key={p}
                    dataKey={p}
                    stackId="a"
                    fill={COLORS[i % COLORS.length]}
                    name={p}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </ChartFigure>
        </div>
      )}

      <UserTable users={users} columns={userColumnsFor(cluster)} />
      </>}
    </div>
  );
}
