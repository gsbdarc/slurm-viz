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

export default function UserDashboard() {
  const { data, loading, error } = useApi("/api/users");

  if (loading)
    return <div className="text-gray-500 p-4">Loading user data...</div>;
  if (error) return <div className="text-red-500 p-4">Error: {error}</div>;

  const users = data.users || [];
  const topUsers = users.slice(0, 10);

  const cpuHoursField = topUsers[0]?.cpu_hours != null ? "cpu_hours" : null;
  const jobCountField = Object.keys(topUsers[0] || {}).find((k) =>
    k.includes("count"),
  );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {cpuHoursField && (
          <div className="bg-white rounded-lg shadow p-4">
            <h3 className="text-lg font-semibold mb-3">
              Top Users by CPU Hours
            </h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={topUsers} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" />
                <YAxis dataKey="User" type="category" width={100} />
                <Tooltip
                  formatter={(v) =>
                    typeof v === "number" ? v.toFixed(1) : v
                  }
                />
                <Bar dataKey="cpu_hours" fill="#3b82f6" name="CPU Hours" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {topUsers.length > 0 && jobCountField && (
          <div className="bg-white rounded-lg shadow p-4">
            <h3 className="text-lg font-semibold mb-3">
              Job Distribution (Top 10)
            </h3>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={topUsers}
                  dataKey={jobCountField}
                  nameKey="User"
                  cx="50%"
                  cy="50%"
                  outerRadius={100}
                  label={({ User, value }) => `${User}: ${value}`}
                >
                  {topUsers.map((_, i) => (
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
      </div>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="p-4 border-b">
          <h3 className="text-lg font-semibold">
            All Users ({users.length})
          </h3>
        </div>
        <div className="overflow-x-auto max-h-96">
          <table className="w-full text-sm text-left">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                {users[0] &&
                  Object.keys(users[0]).map((col) => (
                    <th key={col} className="px-4 py-2 font-medium">
                      {col}
                    </th>
                  ))}
              </tr>
            </thead>
            <tbody>
              {users.map((user, i) => (
                <tr key={i} className="border-t hover:bg-gray-50">
                  {Object.values(user).map((val, j) => (
                    <td key={j} className="px-4 py-2 whitespace-nowrap">
                      {typeof val === "number"
                        ? val % 1 === 0
                          ? val.toLocaleString()
                          : val.toFixed(1)
                        : String(val ?? "")}
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
