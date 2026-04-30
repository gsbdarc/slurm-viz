import { useApi } from "../hooks/useApi";
import LoadingProgress from "./LoadingProgress";

export default function SummaryCards({ dateParams }) {
  const { data, loading, error } = useApi(`/api/summary?${dateParams}`);

  if (loading) return <LoadingProgress completed={0} total={1} label="Loading summary" details={[]} />;
  if (error) return <div className="text-spirited p-4">Error: {error}</div>;

  const cards = [
    { label: "Total Jobs", value: data.total_jobs?.toLocaleString() },
    { label: "Unique Users", value: data.unique_users },
    { label: "Partitions", value: data.unique_partitions },
  ];

  if (data.state_counts) {
    Object.entries(data.state_counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .forEach(([state, count]) => {
        cards.push({ label: state, value: count.toLocaleString() });
      });
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3 mb-6">
      {cards.map((c) => (
        <div
          key={c.label}
          className="bg-white rounded-lg shadow border border-black-20 p-3 text-center"
        >
          <div className="text-xl font-bold text-black-su">{c.value}</div>
          <div className="text-xs text-black-60 mt-1">{c.label}</div>
        </div>
      ))}
    </div>
  );
}
