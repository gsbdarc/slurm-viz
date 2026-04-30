import { useState } from "react";
import { useApi } from "../hooks/useApi";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
} from "recharts";

export default function JobsDashboard() {
  const [filters, setFilters] = useState({
    state: "",
    user: "",
    partition: "",
  });
  const params = new URLSearchParams(
    Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
  );
  const { data, loading, error } = useApi(`/api/jobs?${params}`);
  const { data: summary } = useApi("/api/summary");

  if (loading) return <div className="text-gray-500 p-4">Loading jobs...</div>;
  if (error) return <div className="text-red-500 p-4">Error: {error}</div>;

  const stateData = summary?.state_counts
    ? Object.entries(summary.state_counts).map(([name, value]) => ({
        name,
        value,
      }))
    : [];

  const timelineData = (() => {
    if (!data?.jobs?.length) return [];
    const dateField = data.jobs[0].Submit || data.jobs[0].Start;
    if (!dateField) return [];
    const field = data.jobs[0].Submit ? "Submit" : "Start";
    const counts = {};
    data.jobs.forEach((job) => {
      if (!job[field]) return;
      const day = String(job[field]).slice(0, 10);
      counts[day] = (counts[day] || 0) + 1;
    });
    return Object.entries(counts)
      .sort()
      .map(([date, count]) => ({ date, count }));
  })();

  return (
    <div className="space-y-6">
      <div className="flex gap-3">
        <input
          className="border rounded px-3 py-1.5 text-sm"
          placeholder="Filter by state..."
          value={filters.state}
          onChange={(e) => setFilters({ ...filters, state: e.target.value })}
        />
        <input
          className="border rounded px-3 py-1.5 text-sm"
          placeholder="Filter by user..."
          value={filters.user}
          onChange={(e) => setFilters({ ...filters, user: e.target.value })}
        />
        <input
          className="border rounded px-3 py-1.5 text-sm"
          placeholder="Filter by partition..."
          value={filters.partition}
          onChange={(e) =>
            setFilters({ ...filters, partition: e.target.value })
          }
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {stateData.length > 0 && (
          <div className="bg-white rounded-lg shadow p-4">
            <h3 className="text-lg font-semibold mb-3">Jobs by State</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={stateData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" />
                <YAxis />
                <Tooltip />
                <Bar dataKey="value" fill="#3b82f6" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {timelineData.length > 0 && (
          <div className="bg-white rounded-lg shadow p-4">
            <h3 className="text-lg font-semibold mb-3">
              Job Submissions Over Time
            </h3>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={timelineData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Line
                  type="monotone"
                  dataKey="count"
                  stroke="#3b82f6"
                  strokeWidth={2}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="p-4 border-b">
          <h3 className="text-lg font-semibold">
            Jobs ({data.total?.toLocaleString()} total, showing{" "}
            {data.jobs?.length})
          </h3>
        </div>
        <div className="overflow-x-auto max-h-96">
          <table className="w-full text-sm text-left">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                {data.jobs?.[0] &&
                  Object.keys(data.jobs[0])
                    .slice(0, 8)
                    .map((col) => (
                      <th key={col} className="px-4 py-2 font-medium">
                        {col}
                      </th>
                    ))}
              </tr>
            </thead>
            <tbody>
              {data.jobs?.slice(0, 100).map((job, i) => (
                <tr key={i} className="border-t hover:bg-gray-50">
                  {Object.values(job)
                    .slice(0, 8)
                    .map((val, j) => (
                      <td key={j} className="px-4 py-2 whitespace-nowrap">
                        {String(val ?? "")}
                      </td>
                    ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
