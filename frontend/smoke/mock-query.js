/**
 * Stand-in for `useRedivisQuery` during the smoke test: returns one canned result per cache-key
 * name, never loading, so every tab renders its full, data-populated branch.
 *
 * The rows are small but shaped like the real query results — including nulls where the dashboard
 * shows "—" — because the crashes worth catching live in the code that turns rows into charts,
 * summaries and table cells. They are not checked for correctness; the sacct comparisons in #10
 * and #11 do that.
 *
 * A tab asking for a key with no entry here fails the run loudly, so a new query cannot silently
 * render its empty branch and pass. Add a result below when you add a `ck(cluster, "name", …)`.
 */
const day = "2026-09-01";
const day2 = "2026-09-02";

const job = (id, extra = {}) => ({
  JobID: id, JobName: "j", User: "alice", Partition: "normal", State: "COMPLETED", NCPUS: 4,
  ElapsedRaw: 3600, Submit: `${day}T10:00:00`, Start: `${day}T10:01:00`, End: `${day}T11:01:00`,
  NodeList: "yen-gpu2", Agent: null, ReqMem_GB: 16, gpu_count: 1, wait_seconds: 60,
  mem_used_pct: 12.5, cpu_used_pct: 40, gpu_util_pct: 88, gpu_mem_pct: 30,
  ...extra,
});

const summary = {
  total_jobs: 120, unique_users: 3, unique_partitions: 2, total_ec2_cost_usd: 42,
  state_counts: { COMPLETED: 100, FAILED: 20 },
};

export const DATA = {
  summary,
  fsummary: summary,
  jobs: {
    jobs: [
      job("1"),
      // Blank usage and a sub-1% reading exercise the "—" and "<1%" paths.
      job("2", { mem_used_pct: null, cpu_used_pct: 0.4, gpu_count: 0, gpu_util_pct: null }),
    ],
    total: 2,
    total_ec2_cost_usd: 3,
  },
  timeline: { granularity: "day", data: [{ period: day, count: 70 }, { period: day2, count: 50 }] },
  wait: {
    granularity: "day",
    data: [{ period: day, avg_wait_minutes: 3, median_wait_minutes: 1, max_wait_minutes: 90 }],
  },
  filters: {
    users: ["alice", "bob"], partitions: ["normal", "gpu"], states: ["COMPLETED"], groups: ["g1"],
    nodes: ["yen-gpu2"], nodesTruncated: false,
  },
  cluster: {
    cpu_by_partition: [{
      Partition: "normal", job_count: 100, total_cpus: 400, avg_cpus_per_job: 4, avg_mem_gb: 16,
      avg_elapsed_seconds: 3600, avg_wait_seconds: 60, ec2_cost_usd: 30,
    }],
    partitions: { normal: 100, gpu: 20 },
    nodes_used: 5,
    nodes_truncated: false,
  },
  users: [
    {
      User: "alice", Group: "g1", job_count: 100, total_cpus: 400, total_elapsed: 360000,
      cpu_hours: 400, ec2_cost_usd: 30, total_wait_hours: 1, usage_jobs: 90, mem_weighted_pct: 40,
      mem_unused_gib_hours: 1000, cpu_weighted_pct: 55, cpu_idle_hours: 180, gpu_hours: 10,
      gpu_idle_hours: 2,
    },
    {
      // A user with no measured jobs: every usage column null or zero.
      User: "bob", Group: "g1", job_count: 20, total_cpus: 20, total_elapsed: 7200, cpu_hours: 2,
      ec2_cost_usd: 1, total_wait_hours: 0, usage_jobs: 0, mem_weighted_pct: null,
      mem_unused_gib_hours: 0, cpu_weighted_pct: null, cpu_idle_hours: 0, gpu_hours: 0,
      gpu_idle_hours: 0,
    },
  ],
  groups: [{ Group: "g1", job_count: 120, user_count: 2, total_cpus: 420, cpu_hours: 402, total_wait_hours: 1 }],
  usersPeriod: {
    granularity: "month",
    data: [
      { period: day, Partition: "normal", unique_users: 2 },
      { period: day, Partition: "gpu", unique_users: 1 },
    ],
  },
  agentSummaries: [
    { agent: "claude-code", job_count: 3, unique_users: 1, cpu_hours: 2, first_submit: day, last_submit: day2, ec2_cost_usd: 1 },
    { agent: null, job_count: 117, unique_users: 3, cpu_hours: 400, first_submit: day, last_submit: day2, ec2_cost_usd: 41 },
  ],
  agentsPeriod: {
    granularity: "month",
    data: [{ period: day, agent: "claude-code", job_count: 3, unique_users: 1 }],
  },
  agentUsers: [{ User: "alice", agent: "claude-code", job_count: 3, cpu_hours: 2, last_submit: day2 }],
  utilization: {
    summary: {
      jobs_in_range: 120, mem_jobs: 90, mem_median: 3.1, mem_weighted: 0.38,
      mem_unused_gib_hours: 1000, cpu_jobs: 88, cpu_median: 30, cpu_weighted: 0.6,
      cpu_idle_hours: 180, gpu_jobs: 5, gpu_util_median: 42, gpu_hours: 10, gpu_idle_hours: 2,
      gpu_mem_jobs: 5, gpu_mem_median: 6.8, gpu_mem_weighted: 0.6,
    },
    histogram: [
      { metric: "mem", bin: 0, jobs: 60 }, { metric: "mem", bin: 3, jobs: 30 },
      { metric: "cpu", bin: 4, jobs: 88 }, { metric: "gpu_util", bin: 9, jobs: 5 },
      { metric: "gpu_mem", bin: 0, jobs: 5 },
    ],
  },
  utilJobs: { jobs: [job("1")], total: 1 },
  sampling: { jobs: 100, never_ran: 5, single_snapshot: 40 },
};

/** Cache-key names the tabs asked for, so the runner can report what was exercised. */
export const requested = new Set();

export function useRedivisQuery(_queryFn, cacheKey) {
  if (!cacheKey) return { data: null, loading: false, error: null };
  // Keys are built by `ck(cluster, name, …)`: "<cluster>_<name>_…".
  const name = cacheKey.split("_")[1];
  requested.add(name);
  if (!(name in DATA)) {
    throw new Error(`smoke/mock-query.js has no result for query "${name}" — add one to DATA`);
  }
  return { data: DATA[name], loading: false, error: null };
}
