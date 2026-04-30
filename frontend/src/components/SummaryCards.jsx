import { useApi } from "../hooks/useApi";

export default function SummaryCards() {
  const { data, loading, error } = useApi("/api/summary");

  if (loading) return <div className="text-gray-500 p-4">Loading summary...</div>;
  if (error) return <div className="text-red-500 p-4">Error: {error}</div>;

  const cards = [
    { label: "Total Jobs", value: data.total_jobs?.toLocaleString() },
    { label: "Unique Users", value: data.unique_users },
    { label: "Partitions", value: data.unique_partitions },
  ];

  if (data.state_counts) {
    const top = Object.entries(data.state_counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    top.forEach(([state, count]) => {
      cards.push({ label: state, value: count.toLocaleString() });
    });
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
      {cards.map((c) => (
        <div
          key={c.label}
          className="bg-white rounded-lg shadow p-4 text-center"
        >
          <div className="text-2xl font-bold text-gray-900">{c.value}</div>
          <div className="text-sm text-gray-500 mt-1">{c.label}</div>
        </div>
      ))}
    </div>
  );
}
