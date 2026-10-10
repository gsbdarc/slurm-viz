import { useRedivisQuery } from "../hooks/useRedivisQuery";
import { getClusterUtilization, ck } from "../redivis/queries";
import LoadingProgress from "./LoadingProgress";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import ChartFigure, { fmtCount, topList, peak, sumOf } from "./ChartFigure";

const COLORS = [
  "#8C1515",
  "#175E54",
  "#006CB8",
  "#B36700",
  "#007C92",
  "#620059",
  "#E94C0A",
  "#279989",
];

function fmtDuration(seconds) {
  if (seconds == null) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h < 24) return `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export default function ClusterDashboard({ cluster, startDate, endDate, node, group }) {
  const showMemory = cluster.features.memory;
  const showWaits = cluster.features.waitTimes;
  // Where runtimes are last-seen values rather than final ones, an average of them is an average of
  // lower bounds, and the column heading should not pretend otherwise.
  const durationLabel = cluster.sampling ? "Avg Observed Runtime" : "Avg Duration";
  const durationTitle = cluster.sampling
    ? `Averaged over last-seen runtimes from ${cluster.sampling.label} snapshots — a lower bound.`
    : undefined;

  const { data, loading, error } = useRedivisQuery(
    () => getClusterUtilization(cluster, startDate, endDate, { node, group }),
    ck(cluster, "cluster", startDate, endDate, node || "", group || ""),
  );

  const details = [];
  if (data?.cpu_by_partition?.length) details.push(`${data.cpu_by_partition.length} partitions`);
  if (data?.nodes_used) details.push(`${data.nodes_used} nodes`);

  if (loading)
    return <LoadingProgress completed={0} total={1} label="Loading cluster" details={details} />;
  if (error) return <div className="text-digital-red p-4">Error: {error}</div>;

  const allPartitions = data.partitions
    ? Object.entries(data.partitions).map(([name, value]) => ({ name, value }))
    : [];

  // A pie is only readable to about a dozen slices, and on a cluster where a queued job lists every
  // partition it is eligible for there can be far more than that. Show the biggest and roll the tail
  // into one slice — display only, so no total moves and the Partition Details table below still
  // lists every partition individually.
  const PIE_SLICES = 8;
  const partitionData = (() => {
    if (allPartitions.length <= PIE_SLICES + 1) return allPartitions;
    const sorted = [...allPartitions].sort((a, b) => b.value - a.value);
    const head = sorted.slice(0, PIE_SLICES);
    const tail = sorted.slice(PIE_SLICES);
    return [
      ...head,
      {
        name: `(other — ${tail.length} partitions)`,
        value: tail.reduce((sum, p) => sum + p.value, 0),
      },
    ];
  })();

  const cpuData = data.cpu_by_partition || [];

  // CPU-hours, not a sum of CPU counts: a 1-minute and a 3-day 16-core job are not the same usage.
  // Sorted biggest first, and partitions with no CPU-hours are left off the chart. Those are jobs
  // that never started, whose allocation is 0 (on Sherlock, every partition list is one). Display
  // only: the table below still lists every partition.
  const CPU_BARS = 10;
  const cpuBars = (() => {
    const used = cpuData
      .filter((r) => Number(r.cpu_hours) > 0)
      .map((r) => ({ ...r, cpu_hours: Number(r.cpu_hours) }))
      .sort((a, b) => b.cpu_hours - a.cpu_hours);
    if (used.length <= CPU_BARS + 1) return used;
    const tail = used.slice(CPU_BARS);
    const jobs = tail.reduce((n, r) => n + Number(r.job_count || 0), 0);
    const cpus = tail.reduce((n, r) => n + Number(r.total_cpus || 0), 0);
    return [
      ...used.slice(0, CPU_BARS),
      {
        Partition: `(other — ${tail.length})`,
        cpu_hours: tail.reduce((n, r) => n + r.cpu_hours, 0),
        job_count: jobs,
        avg_cpus_per_job: jobs ? cpus / jobs : null,
      },
    ];
  })();
  const cpuHoursLabel = cluster.sampling ? "Observed CPU-Hours" : "CPU-Hours";

  // A node filter narrows this tab to one machine, which usually leaves a single partition. A
  // one-slice pie and a lone bar convey nothing the table below doesn't state more precisely, so
  // the "by Partition" charts are only worth drawing when there's something to compare.
  const showPartitionCharts = allPartitions.length > 1;

  // `nodes_used` counts every node the matching jobs touched. Under a node filter that's still
  // >1 whenever a multi-node job (e.g. `yen-gpu[1-4]`) also ran elsewhere — true, but it reads as
  // a contradiction next to a single-node filter unless it's spelled out.
  const alsoTouched = Math.max(0, (data.nodes_used || 0) - 1);

  return (
    <div className="space-y-6">
      {data.nodes_used > 0 && (
        <div className="bg-white rounded-lg shadow border border-black-20 p-4">
          {node ? (
            <>
              <span className="text-cool-grey">Filtered to node </span>
              <span className="font-bold text-xl text-black-su">{node}</span>
              {alsoTouched > 0 && (
                <span className="text-cool-grey">
                  {" "}
                  — some of these jobs also spanned {alsoTouched} other{" "}
                  {alsoTouched === 1 ? "node" : "nodes"}
                </span>
              )}
            </>
          ) : (
            <>
              <span className="text-cool-grey">Unique nodes used: </span>
              <span className="font-bold text-xl text-black-su">
                {/* The count comes from the node index, so a capped index makes it a floor. */}
                {data.nodes_truncated ? "≥ " : ""}
                {data.nodes_used}
              </span>
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {showPartitionCharts && (
          <div className="bg-white rounded-lg shadow border border-black-20 p-4">
            <h3 className="text-lg font-semibold text-black-su mb-3">Jobs by Partition</h3>
            <ChartFigure summary={`Jobs by partition: ${topList(partitionData, "name", "value", (v) => `${fmtCount(v)} jobs, ${Math.round((100 * v) / (sumOf(partitionData, (r) => r.value) || 1))}%`, 4)}.`}>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    isAnimationActive={false}
                    data={partitionData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={100}
                    innerRadius={40}
                    paddingAngle={2}
                  >
                    {partitionData.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v) => v.toLocaleString()} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </ChartFigure>
          </div>
        )}

        {showPartitionCharts && cpuBars.length > 0 && (
          <div className="bg-white rounded-lg shadow border border-black-20 p-4">
            <h3 className="text-lg font-semibold text-black-su mb-3">{cpuHoursLabel} by Partition</h3>
            <ChartFigure summary={`${cpuHoursLabel} by partition: ${topList(cpuBars, "Partition", "cpu_hours", (v) => `${fmtCount(Math.round(v))} CPU-hours`, 4)}.`}>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={cpuBars} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" tickFormatter={(v) => fmtCount(v)} />
                  <YAxis type="category" dataKey="Partition" width={130} interval={0} tick={{ fontSize: 12 }} />
                  <Tooltip
                    formatter={(v) => [`${Math.round(v).toLocaleString()}`, cpuHoursLabel]}
                    labelFormatter={(label, payload) => {
                      const r = payload?.[0]?.payload;
                      if (!r) return label;
                      const avg = r.avg_cpus_per_job != null ? `, ${Number(r.avg_cpus_per_job).toFixed(1)} avg CPUs` : "";
                      return `${label} (${Number(r.job_count || 0).toLocaleString()} jobs${avg})`;
                    }}
                  />
                  <Bar isAnimationActive={false} dataKey="cpu_hours" fill="#175E54" name={cpuHoursLabel} />
                </BarChart>
              </ResponsiveContainer>
            </ChartFigure>
          </div>
        )}
      </div>

      {cpuData.length > 0 && (
        <div className="bg-white rounded-lg shadow border border-black-20 overflow-hidden">
          <div className="p-4 border-b border-black-20">
            <h3 className="text-lg font-semibold text-black-su">Partition Details</h3>
          </div>
          <table className="w-full text-sm text-left">
            <thead className="bg-fog">
              <tr>
                <th className="px-4 py-2 font-medium text-black-su">Partition</th>
                <th className="px-4 py-2 font-medium text-black-su">Job Count</th>
                <th className="px-4 py-2 font-medium text-black-su">Total CPUs</th>
                <th className="px-4 py-2 font-medium text-black-su">{cpuHoursLabel}</th>
                <th className="px-4 py-2 font-medium text-black-su">Avg CPUs/Job</th>
                {showMemory && (
                  <th className="px-4 py-2 font-medium text-black-su">Avg RAM/Job</th>
                )}
                <th className="px-4 py-2 font-medium text-black-su" title={durationTitle}>
                  {durationLabel}
                </th>
                {showWaits && (
                  <th className="px-4 py-2 font-medium text-black-su">Avg Queue Wait</th>
                )}
              </tr>
            </thead>
            <tbody>
              {cpuData.map((row, i) => (
                <tr key={i} className="border-t border-black-20 hover:bg-black-10">
                  <td className="px-4 py-2">{row.Partition}</td>
                  <td className="px-4 py-2">
                    {row.job_count?.toLocaleString()}
                  </td>
                  <td className="px-4 py-2">
                    {row.total_cpus?.toLocaleString()}
                  </td>
                  <td className="px-4 py-2">
                    {row.cpu_hours != null ? Math.round(row.cpu_hours).toLocaleString() : "—"}
                  </td>
                  <td className="px-4 py-2">
                    {row.avg_cpus_per_job?.toFixed(1)}
                  </td>
                  {showMemory && (
                    <td className="px-4 py-2">
                      {row.avg_mem_gb != null ? `${Number(row.avg_mem_gb).toFixed(2)} GB` : "—"}
                    </td>
                  )}
                  <td className="px-4 py-2">
                    {fmtDuration(row.avg_elapsed_seconds)}
                  </td>
                  {showWaits && (
                    <td className="px-4 py-2">
                      {fmtDuration(row.avg_wait_seconds)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
