import { useRedivisQuery } from "../hooks/useRedivisQuery";
import { getClusterUtilization } from "../redivis/queries";
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
  LabelList,
} from "recharts";

const COLORS = [
  "#8C1515",
  "#175E54",
  "#006CB8",
  "#E98300",
  "#007C92",
  "#620059",
  "#E04F39",
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

export default function ClusterDashboard({ startDate, endDate, node }) {
  const { data, loading, error } = useRedivisQuery(
    () => getClusterUtilization(startDate, endDate, { node }),
    `cluster_${startDate}_${endDate}_${node || ""}`,
  );

  const details = [];
  if (data?.cpu_by_partition?.length) details.push(`${data.cpu_by_partition.length} partitions`);
  if (data?.nodes_used) details.push(`${data.nodes_used} nodes`);

  if (loading)
    return <LoadingProgress completed={0} total={1} label="Loading cluster" details={details} />;
  if (error) return <div className="text-spirited p-4">Error: {error}</div>;

  const partitionData = data.partitions
    ? Object.entries(data.partitions).map(([name, value]) => ({ name, value }))
    : [];

  const cpuData = data.cpu_by_partition || [];

  return (
    <div className="space-y-6">
      {data.nodes_used && (
        <div className="bg-white rounded-lg shadow border border-black-20 p-4">
          <span className="text-black-60">Unique nodes used: </span>
          <span className="font-bold text-xl text-black-su">{data.nodes_used}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {partitionData.length > 0 && (
          <div className="bg-white rounded-lg shadow border border-black-20 p-4">
            <h3 className="text-lg font-semibold text-black-su mb-3">Jobs by Partition</h3>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={partitionData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={100}
                  innerRadius={40}
                  paddingAngle={2}
                  label={({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}
                  labelLine={{ stroke: "#585754" }}
                >
                  {partitionData.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => v.toLocaleString()} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}

        {cpuData.length > 0 && (
          <div className="bg-white rounded-lg shadow border border-black-20 p-4">
            <h3 className="text-lg font-semibold text-black-su mb-3">
              CPU Usage by Partition
            </h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={cpuData} margin={{ top: 20 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="Partition" />
                <YAxis />
                <Tooltip formatter={(v, name) => [typeof v === "number" ? (v % 1 === 0 ? v.toLocaleString() : v.toFixed(1)) : v, name]} />
                <Bar dataKey="total_cpus" fill="#175E54" name="Total CPUs">
                  <LabelList
                    dataKey="avg_cpus_per_job"
                    position="top"
                    formatter={(v) => `${typeof v === "number" ? v.toFixed(1) : v} avg CPUs`}
                    style={{ fontSize: 11, fill: "#585754" }}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
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
                <th className="px-4 py-2 font-medium text-black-su">Avg CPUs/Job</th>
                <th className="px-4 py-2 font-medium text-black-su">Avg RAM/Job</th>
                <th className="px-4 py-2 font-medium text-black-su">Avg Duration</th>
                <th className="px-4 py-2 font-medium text-black-su">Avg Queue Wait</th>
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
                    {row.avg_cpus_per_job?.toFixed(1)}
                  </td>
                  <td className="px-4 py-2">
                    {row.avg_mem_gb != null ? `${Number(row.avg_mem_gb).toFixed(2)} GB` : "—"}
                  </td>
                  <td className="px-4 py-2">
                    {fmtDuration(row.avg_elapsed_seconds)}
                  </td>
                  <td className="px-4 py-2">
                    {fmtDuration(row.avg_wait_seconds)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
