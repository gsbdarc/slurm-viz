import { useState, useEffect } from "react";
import { useRedivisQuery } from "../hooks/useRedivisQuery";
import { getGroupSummaries, getFilterOptions, ck } from "../redivis/queries";
import { formatUsd } from "../lib/ec2";
import LoadingProgress from "./LoadingProgress";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import ChartFigure, { fmtCount, topList, peak, total } from "./ChartFigure";

const GROUP_COLUMNS = [
  { key: "Group", label: "Group" },
  { key: "job_count", label: "Jobs", numeric: true },
  { key: "user_count", label: "Users", numeric: true },
  { key: "total_cpus", label: "Total CPUs", numeric: true },
  { key: "cpu_hours", label: "CPU Hours", numeric: true },
  { key: "ec2_cost_usd", label: "EC2 Cost", currency: true, feature: "ec2Cost" },
  { key: "total_wait_hours", label: "Queue Wait (hrs)", numeric: true, feature: "waitTimes" },
];

function groupColumnsFor(cluster) {
  return GROUP_COLUMNS.filter((c) => !c.feature || cluster.features[c.feature]);
}

const numericGroupCols = new Set(
  GROUP_COLUMNS.filter((c) => c.numeric || c.currency).map((c) => c.key),
);

/** Jobs from before the collector recorded a group; see issue #6. */
const NO_GROUP_LABEL = "(no group recorded)";

function GroupTable({ groups, columns }) {
  const [sort, setSort] = useState({ col: "cpu_hours", asc: false });

  const handleSort = (col) => {
    setSort((prev) => (prev.col === col ? { col, asc: !prev.asc } : { col, asc: false }));
  };

  const sorted = [...groups].sort((a, b) => {
    if (!sort.col) return 0;
    const av = a[sort.col];
    const bv = b[sort.col];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (numericGroupCols.has(sort.col)) {
      return sort.asc ? Number(av) - Number(bv) : Number(bv) - Number(av);
    }
    return sort.asc
      ? String(av).localeCompare(String(bv))
      : String(bv).localeCompare(String(av));
  });

  const fmtVal = (col, val) => {
    if (col.key === "Group" && val == null) return NO_GROUP_LABEL;
    if (val == null) return "—";
    if (col.currency) return formatUsd(val);
    if (col.numeric && typeof val === "number")
      return val % 1 === 0 ? val.toLocaleString() : val.toFixed(1);
    return String(val);
  };

  return (
    <div className="bg-white rounded-lg shadow border border-black-20 overflow-hidden">
      <div className="p-4 border-b border-black-20">
        <h3 className="text-lg font-semibold text-black-su">All Groups ({groups.length})</h3>
      </div>
      <div className="overflow-x-auto max-h-96">
        <table className="w-full text-sm text-left">
          <thead className="bg-fog sticky top-0">
            <tr>
              {columns.map((col) => (
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
            {sorted.map((row, i) => (
              <tr key={i} className="border-t border-black-20 hover:bg-black-10">
                {columns.map((col) => (
                  <td key={col.key} className="px-4 py-2 whitespace-nowrap">
                    {fmtVal(col, row[col.key])}
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

export default function GroupDashboard({ cluster, startDate, endDate, node, group }) {
  const [partition, setPartition] = useState("");

  const filters = {
    partition: partition || undefined,
    node: node || undefined,
    group: group || undefined,
  };
  const fk = `${partition}_${node || ""}_${group || ""}`;

  const { data: groupsData, loading, error } = useRedivisQuery(
    () => getGroupSummaries(cluster, startDate, endDate, filters),
    ck(cluster, "groups", startDate, endDate, fk),
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

  const details = [];
  if (!loading && groupsData?.length) details.push(`${groupsData.length} groups`);

  if (loading && !groupsData)
    return <LoadingProgress completed={0} total={1} label="Loading groups" details={details} />;
  if (error) return <div className="text-digital-red p-4">Error: {error}</div>;

  const rows = groupsData || [];

  // The unnamed bucket stays in the table so its totals still reconcile with the summary cards, but
  // it is kept out of the charts: on a range reaching back before December 2025 it is the largest
  // bar on the page and says nothing about any actual group.
  const named = rows.filter((r) => r.Group != null);
  const unnamed = rows.find((r) => r.Group == null);

  const topByCpuHours = [...named]
    .sort((a, b) => (b.cpu_hours || 0) - (a.cpu_hours || 0))
    .slice(0, 10);
  const topByJobCount = [...named]
    .sort((a, b) => (b.job_count || 0) - (a.job_count || 0))
    .slice(0, 10);

  const suffixParts = [partition, node, group].filter(Boolean);
  const suffix = suffixParts.length ? ` (${suffixParts.join(", ")})` : "";

  const partitions = filterOptions?.partitions || [];

  return (
    <div className="space-y-6">
      <div className="flex gap-3 items-center">
        <select
          className="border border-black-20 rounded px-3 py-1.5 text-sm bg-white"
          value={partition}
          onChange={(e) => setPartition(e.target.value)}
        >
          <option value="">All partitions</option>
          {partitions.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
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

      {unnamed && (
        <div className="text-xs text-cool-grey leading-snug">
          {unnamed.job_count?.toLocaleString()} job
          {unnamed.job_count === 1 ? "" : "s"} in this range have no group recorded and are excluded
          from the charts below — the collector did not capture a group before December 2025
          (issue&nbsp;#6). They are still counted in the table and in the summary totals.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {topByCpuHours.length > 0 && (
          <div className="bg-white rounded-lg shadow border border-black-20 p-4">
            <h3 className="text-lg font-semibold text-black-su mb-3">
              Top Groups by CPU Hours{suffix}
            </h3>
            <ChartFigure summary={`Top groups by CPU hours: ${topList(topByCpuHours, "Group", "cpu_hours", (v) => `${fmtCount(v)} CPU-hours`)}.`}>
              <ResponsiveContainer width="100%" height={400}>
                <BarChart data={topByCpuHours} layout="vertical" margin={{ left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" />
                  <YAxis dataKey="Group" type="category" width={120} tick={{ fontSize: 13 }} />
                  <Tooltip formatter={(v) => (typeof v === "number" ? v.toFixed(1) : v)} />
                  <Bar isAnimationActive={false} dataKey="cpu_hours" fill="#B1040E" name="CPU Hours" />
                </BarChart>
              </ResponsiveContainer>
            </ChartFigure>
          </div>
        )}

        {topByJobCount.length > 0 && (
          <div className="bg-white rounded-lg shadow border border-black-20 p-4">
            <h3 className="text-lg font-semibold text-black-su mb-3">
              Top Groups by Job Count{suffix}
            </h3>
            <ChartFigure summary={`Top groups by job count: ${topList(topByJobCount, "Group", "job_count", (v) => `${fmtCount(v)} jobs`)}.`}>
              <ResponsiveContainer width="100%" height={400}>
                <BarChart data={topByJobCount} layout="vertical" margin={{ left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" />
                  <YAxis dataKey="Group" type="category" width={120} tick={{ fontSize: 13 }} />
                  <Tooltip formatter={(v) => (typeof v === "number" ? v.toLocaleString() : v)} />
                  <Bar isAnimationActive={false} dataKey="job_count" fill="#008566" name="Jobs" />
                </BarChart>
              </ResponsiveContainer>
            </ChartFigure>
          </div>
        )}
      </div>

      <GroupTable groups={rows} columns={groupColumnsFor(cluster)} />
    </div>
  );
}
