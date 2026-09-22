import { useRedivisQuery } from "../hooks/useRedivisQuery";
import { getSummary, ck } from "../redivis/queries";
import { formatUsd, PRICING_DISCLOSURE } from "../lib/ec2";
import LoadingProgress from "./LoadingProgress";

export default function SummaryCards({ cluster, startDate, endDate, node, group }) {
  const showCost = cluster.features.ec2Cost;

  // This key is duplicated verbatim in JobsDashboard so the two share one query. Keep the argument
  // order identical there if it ever changes.
  const { data, loading, error } = useRedivisQuery(
    () => getSummary(cluster, startDate, endDate, { node, group }),
    ck(cluster, "summary", startDate, endDate, node || "", group || ""),
  );

  if (loading) return <LoadingProgress completed={0} total={1} label="Loading summary" details={[]} />;
  if (error) return <div className="text-digital-red p-4">Error: {error}</div>;

  const cards = [
    { label: "Total Jobs", value: data.total_jobs?.toLocaleString() },
    { label: "Unique Users", value: data.unique_users },
    { label: "Partitions", value: data.unique_partitions },
  ];

  if (showCost) {
    cards.push({ label: "EC2 Equivalent", value: formatUsd(data.total_ec2_cost_usd) });
  }

  // `state_counts` is null where the source never observes a job's final state.
  if (cluster.features.jobStates && data.state_counts) {
    Object.entries(data.state_counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .forEach(([state, count]) => {
        cards.push({ label: state, value: count.toLocaleString() });
      });
  }

  return (
    <div className="mb-6">
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
        {cards.map((c) => (
          <div
            key={c.label}
            className="bg-white rounded-lg shadow border border-black-20 p-3 text-center"
          >
            <div className="text-xl font-bold text-black-su">{c.value}</div>
            <div className="text-xs text-cool-grey mt-1">{c.label}</div>
          </div>
        ))}
      </div>
      {(showCost || node) && (
        <details className="mt-2 text-xs text-cool-grey">
          <summary className="cursor-pointer select-none hover:text-black-su w-fit">
            {showCost ? "How the EC2 equivalent is estimated" : "About the node filter"}
          </summary>
          {showCost && <p className="mt-1 leading-snug max-w-4xl">{PRICING_DISCLOSURE}</p>}
          {node && (
            <p className="mt-1 leading-snug max-w-4xl">
              Multi-node jobs are counted in full for every node they touched, so per-node figures do
              not sum to the cluster total.
            </p>
          )}
        </details>
      )}
    </div>
  );
}
