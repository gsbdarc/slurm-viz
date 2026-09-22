import { formatUsd } from "../lib/ec2";

/**
 * The job list shared by the Jobs and Utilization tabs: column catalogue, per-cluster column
 * gating, and the sortable table itself.
 */

export const JOB_COLUMNS = [
  { key: "JobID", label: "Job ID" },
  { key: "JobName", label: "Name" },
  { key: "User", label: "User" },
  { key: "Partition", label: "Partition" },
  { key: "State", label: "State", feature: "jobStates" },
  {
    key: "Agent",
    label: "Agent",
    feature: "agentDetection",
    title:
      "The AI coding agent whose scratch or worktree path appears in this job's WorkDir or " +
      "SubmitLine. Blank means no such path — most often a person, but also an agent that " +
      "submitted a script from the project tree, which leaves no trace. A floor, not a census.",
  },
  { key: "NCPUS", label: "CPUs", numeric: true },
  {
    key: "cpu_used_pct",
    label: "CPU Used",
    numeric: true,
    percent: true,
    feature: "usage",
    title:
      "CPU time the job consumed, as a share of its CPUs × elapsed time. Blank for jobs still " +
      "running, jobs that never started, resized jobs (Slurm splits them into two records and " +
      "misattributes the usage), and anything submitted before 2026-01-22 — blank means unknown, " +
      "not zero.",
  },
  { key: "ReqMem_GB", label: "Memory (GiB)", numeric: true, feature: "memory" },
  {
    key: "mem_used_pct",
    label: "Mem Used",
    numeric: true,
    percent: true,
    feature: "usage",
    title:
      "Peak memory the job used, as a share of the memory it requested. Can exceed 100%: Slurm " +
      "rounds the allocation up to a per-core minimum, and the job may use that headroom. Blank " +
      "for jobs still running, jobs that never started, resized jobs, and anything submitted " +
      "before 2026-01-22 — blank means unknown, not zero.",
  },
  { key: "gpu_count", label: "GPUs", numeric: true, feature: "gpus" },
  {
    key: "gpu_util_pct",
    label: "GPU Peak",
    numeric: true,
    percent: true,
    feature: "usage",
    title:
      "The busiest moment of GPU use Slurm saw, per GPU, sampled every 30 seconds. A peak, not an " +
      "average: a job busy for one minute and idle for a day still reads high. 0% means no sample " +
      "ever caught the GPU working. Can slightly exceed 100% when several processes share a GPU. " +
      "Blank for jobs with no GPU, jobs under 30 seconds (never sampled), resized jobs, jobs still " +
      "running, and anything submitted before 2026-01-22.",
  },
  {
    key: "gpu_mem_pct",
    label: "GPU Mem Used",
    numeric: true,
    percent: true,
    feature: "usage",
    title:
      "Peak GPU memory the job held, as a share of the memory on the GPUs it was given (A30 24 GiB, " +
      "A40 48 GiB, H200 141 GiB). Blank for jobs with no GPU, jobs under 30 seconds, resized jobs, " +
      "jobs spanning two GPU models, jobs still running, and anything submitted before 2026-01-22.",
  },
  { key: "ec2_cost_usd", label: "EC2 Cost", currency: true, feature: "ec2Cost" },
  { key: "ec2_instance", label: "EC2 Instance", feature: "ec2Cost" },
  { key: "wait_seconds", label: "Queue Wait (s)", numeric: true, feature: "waitTimes" },
  { key: "ElapsedRaw", label: "Elapsed (s)", numeric: true },
  { key: "Submit", label: "Submit", date: true },
  { key: "Start", label: "Start", date: true },
  { key: "End", label: "End", date: true, feature: "hasEndColumn" },
  { key: "NodeList", label: "Nodes" },
];

/**
 * Columns a cluster can actually populate. `feature: null`-guarded entries would otherwise render a
 * column of em-dashes, which reads as "no GPUs were used" rather than "this dump can't tell you".
 */
export function jobColumnsFor(cluster) {
  const available = {
    ...cluster.features,
    hasEndColumn: Boolean(cluster.columns.end),
  };
  // Keyed on `sampling`, not on a state flag: a runtime is a lower bound because the source samples
  // a live queue, which is the actual cause, and stays right for a sampled cluster that does record
  // states.
  return JOB_COLUMNS.filter((c) => !c.feature || available[c.feature]).map((c) =>
    c.key === "ElapsedRaw" && cluster.sampling
      ? {
          ...c,
          label: "Observed runtime (s)",
          title:
            `Last runtime seen before the job left the queue, sampled ${cluster.sampling.label} — ` +
            "a lower bound, not the final elapsed time.",
        }
      : c,
  );
}

export default function JobTable({ data, sort, setSort, columns, showCost }) {
  const handleSort = (col) => {
    setSort((prev) =>
      prev.col === col ? { col, asc: !prev.asc } : { col, asc: true },
    );
  };

  const colMeta = Object.fromEntries(columns.map((c) => [c.key, c]));
  const sorted = [...(data.jobs || [])].sort((a, b) => {
    if (!sort.col) return 0;
    let av = a[sort.col], bv = b[sort.col];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const meta = colMeta[sort.col] || {};
    if (meta.numeric || meta.currency) {
      const na = Number(av), nb = Number(bv);
      return sort.asc ? na - nb : nb - na;
    }
    if (meta.date) {
      const da = new Date(av).getTime(), db = new Date(bv).getTime();
      return sort.asc ? da - db : db - da;
    }
    av = String(av);
    bv = String(bv);
    return sort.asc ? av.localeCompare(bv) : bv.localeCompare(av);
  });

  const fmtVal = (col, val) => {
    if (val == null) return "—";
    if (col.currency) return formatUsd(val);
    // "<1%" rather than "0%", which would read as idle for a job that did use a little.
    if (col.percent) {
      const n = Number(val);
      return n > 0 && n < 1 ? "<1%" : `${Math.round(n)}%`;
    }
    if (col.numeric && typeof val === "number")
      return val % 1 === 0 ? val.toLocaleString() : val.toFixed(2);
    return String(val);
  };

  const anyOversized = sorted.some((j) => j.ec2_oversized);

  return (
    <div className="bg-white rounded-lg shadow border border-black-20 overflow-hidden">
      <div className="p-4 border-b border-black-20">
        <h3 className="text-lg font-semibold text-black-su">
          Jobs ({data.total?.toLocaleString()} total, showing{" "}
          {data.jobs?.length})
        </h3>
        {showCost && (
          <p className="text-xs text-cool-grey mt-1">
            EC2 cost across all {data.total?.toLocaleString()} matching jobs:{" "}
            <span className="font-medium text-black-su">
              {formatUsd(data.total_ec2_cost_usd)}
            </span>
            {anyOversized && " · † job exceeds every catalog instance; cost shown is a lower bound"}
          </p>
        )}
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
            {sorted.slice(0, 200).map((job, i) => (
              <tr key={i} className="border-t border-black-20 hover:bg-black-10">
                {columns.map((col) => (
                  <td key={col.key} className="px-4 py-2 whitespace-nowrap">
                    {fmtVal(col, job[col.key])}
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
