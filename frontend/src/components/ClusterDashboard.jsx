import { useApi } from "../hooks/useApi";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";

const COLORS = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
  "#84cc16",
];

export default function ClusterDashboard() {
  const { data, loading, error } = useApi("/api/cluster");

  if (loading)
    return <div className="text-gray-500 p-4">Loading cluster data...</div>;
  if (error) return <div className="text-red-500 p-4">Error: {error}</div>;

  const partitionData = data.partitions
    ? Object.entries(data.partitions).map(([name, value]) => ({ name, value }))
    : [];

  const cpuData = data.cpu_by_partition || [];

  return (
    <div className="space-y-6">
      {data.nodes_used && (
        <div className="bg-white rounded-lg shadow p-4">
          <span className="text-gray-500">Unique nodes used: </span>
          <span className="font-bold text-xl">{data.nodes_used}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {partitionData.length > 0 && (
          <div className="bg-white rounded-lg shadow p-4">
            <h3 className="text-lg font-semibold mb-3">Jobs by Partition</h3>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={partitionData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={100}
                  label={({ name, value }) => `${name}: ${value}`}
                >
                  {partitionData.map((_, i) => (
                    <Cell
                      key={i}
                      fill={COLORS[i % COLORS.length]}
                    />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}

        {cpuData.length > 0 && (
          <div className="bg-white rounded-lg shadow p-4">
            <h3 className="text-lg font-semibold mb-3">
              CPU Usage by Partition
            </h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={cpuData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="Partition" />
                <YAxis />
                <Tooltip />
                <Bar dataKey="sum" fill="#10b981" name="Total CPUs" />
                <Bar dataKey="mean" fill="#3b82f6" name="Avg CPUs/Job" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {cpuData.length > 0 && (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="p-4 border-b">
            <h3 className="text-lg font-semibold">Partition Details</h3>
          </div>
          <table className="w-full text-sm text-left">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 font-medium">Partition</th>
                <th className="px-4 py-2 font-medium">Total CPUs</th>
                <th className="px-4 py-2 font-medium">Avg CPUs/Job</th>
                <th className="px-4 py-2 font-medium">Job Count</th>
              </tr>
            </thead>
            <tbody>
              {cpuData.map((row, i) => (
                <tr key={i} className="border-t hover:bg-gray-50">
                  <td className="px-4 py-2">{row.Partition}</td>
                  <td className="px-4 py-2">{row.sum?.toLocaleString()}</td>
                  <td className="px-4 py-2">{row.mean?.toFixed(1)}</td>
                  <td className="px-4 py-2">{row.count?.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
