import { useState } from "react";
import { useRedivisQuery } from "../hooks/useRedivisQuery";
import {
  getAgentSummaries,
  getAgentsByPeriod,
  getAgentUsers,
  ck,
} from "../redivis/queries";
import { formatUsd } from "../lib/ec2";
import { formatPeriod, periodSortKey, periodLabel } from "../lib/periods";
import LoadingProgress from "./LoadingProgress";
import {
  BarChart,
  Bar,
  Cell,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import ChartFigure, { fmtCount, topList, peak, total } from "./ChartFigure";

/** Stable per-agent colour, so a series keeps its colour across all three charts. */
const AGENT_COLORS = {
  "claude-code": "#B1040E",
  codex: "#008566",
};
const FALLBACK_COLORS = ["#B36700", "#4298B5", "#620059", "#007C92"];

function colorFor(agent, index) {
  // `index` is the agent's position in the agent list, never a row's rank; -1 (not listed) maps to 0.
  return AGENT_COLORS[agent] || FALLBACK_COLORS[Math.max(index, 0) % FALLBACK_COLORS.length];
}

function fmtInt(n) {
  return n == null ? "—" : Number(n).toLocaleString();
}

function fmtHours(n) {
  return n == null ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function fmtDate(val) {
  if (!val) return "—";
  const d = new Date(val);
  return isNaN(d.getTime())
    ? String(val)
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function Card({ label, value, sub }) {
  return (
    <div className="bg-white rounded-lg shadow border border-black-20 p-4">
      <div className="text-sm text-cool-grey">{label}</div>
      <div className="text-2xl font-semibold text-black-su mt-1">{value}</div>
      {sub && <div className="text-xs text-cool-grey mt-1">{sub}</div>}
    </div>
  );
}

function AgentUserTable({ rows }) {
  const [sort, setSort] = useState({ col: "job_count", asc: false });
  const handleSort = (col) =>
    setSort((prev) => (prev.col === col ? { col, asc: !prev.asc } : { col, asc: false }));

  const cols = [
    { key: "User", label: "User" },
    { key: "agent", label: "Agent" },
    { key: "job_count", label: "Jobs", numeric: true },
    { key: "cpu_hours", label: "CPU Hours", numeric: true },
    { key: "last_submit", label: "Last Submit", date: true },
  ];

  const sorted = [...rows].sort((a, b) => {
    if (!sort.col) return 0;
    let av = a[sort.col];
    let bv = b[sort.col];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") {
      return sort.asc ? av - bv : bv - av;
    }
    return sort.asc
      ? String(av).localeCompare(String(bv))
      : String(bv).localeCompare(String(av));
  });

  return (
    <div className="bg-white rounded-lg shadow border border-black-20 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-fog border-b border-black-20">
            <tr>
              {cols.map((c) => (
                <th
                  key={c.key}
                  onClick={() => handleSort(c.key)}
                  className={`px-3 py-2 font-medium text-black-su cursor-pointer select-none ${
                    c.numeric ? "text-right" : "text-left"
                  }`}
                >
                  {c.label}
                  {sort.col === c.key && (sort.asc ? " ▲" : " ▼")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={`${r.User}-${r.agent}-${i}`} className="border-b border-black-10">
                {cols.map((c) => (
                  <td
                    key={c.key}
                    className={`px-3 py-2 ${c.numeric ? "text-right tabular-nums" : "text-left"}`}
                  >
                    {c.date
                      ? fmtDate(r[c.key])
                      : c.numeric
                        ? c.key === "cpu_hours"
                          ? fmtHours(r[c.key])
                          : fmtInt(r[c.key])
                        : (r[c.key] ?? "—")}
                  </td>
                ))}
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={cols.length} className="px-3 py-6 text-center text-cool-grey">
                  No agent-submitted jobs in this range.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Agent usage over time.
 *
 * Everything here counts jobs whose `WorkDir` or `SubmitLine` carries an agent's scratch or worktree
 * path — see `agentDetection` in `lib/clusters.js` for the markers and for why job names are not
 * one. That makes every number on this tab a **floor**: an agent that submits a script living in
 * the project tree, with no scratch path on the command line, is indistinguishable from a person
 * and is counted as one. The banner says so rather than leaving the reader to assume a census.
 */
export default function AgentsDashboard({ cluster, startDate, endDate, node, group }) {
  const showCost = cluster.features.ec2Cost;
  const filters = {
    node: node || undefined,
    group: group || undefined,
  };
  const fk = `${node || ""}_${group || ""}`;

  const { data: summaries, loading: lSum, error } = useRedivisQuery(
    () => getAgentSummaries(cluster, startDate, endDate, filters),
    ck(cluster, "agentSummaries", startDate, endDate, fk),
  );
  const { data: byPeriod, loading: lPeriod } = useRedivisQuery(
    () => getAgentsByPeriod(cluster, startDate, endDate, filters),
    ck(cluster, "agentsPeriod", startDate, endDate, fk),
  );
  const { data: agentUsers, loading: lUsers } = useRedivisQuery(
    () => getAgentUsers(cluster, startDate, endDate, filters),
    ck(cluster, "agentUsers", startDate, endDate, fk),
  );

  const queries = [lSum, lPeriod, lUsers];
  const completed = queries.filter((l) => !l).length;
  const anyLoading = completed < queries.length;

  const details = [];
  if (!lSum && summaries?.length) details.push(`${summaries.length} agent groups`);
  if (!lPeriod && byPeriod?.data?.length) details.push(`${byPeriod.data.length} period records`);
  if (!lUsers && agentUsers?.length) details.push(`${agentUsers.length} user/agent pairs`);

  if (lSum && !summaries)
    return (
      <LoadingProgress
        completed={completed}
        total={queries.length}
        label="Loading agent usage"
        details={details}
      />
    );
  if (error) return <div className="text-digital-red p-4">Error: {error}</div>;

  // The NULL-agent row is the rest of the cluster's work. Split it out so the headline can be a
  // share rather than a bare count — "409 jobs" means nothing without the denominator.
  const rows = summaries || [];
  const agentRows = rows.filter((r) => r.agent);
  const humanRow = rows.find((r) => !r.agent);

  const agentJobs = agentRows.reduce((s, r) => s + Number(r.job_count || 0), 0);
  const totalJobs = agentJobs + Number(humanRow?.job_count || 0);
  const agentCpuHours = agentRows.reduce((s, r) => s + Number(r.cpu_hours || 0), 0);
  const totalCpuHours = agentCpuHours + Number(humanRow?.cpu_hours || 0);
  const agentCost = agentRows.reduce((s, r) => s + Number(r.ec2_cost_usd || 0), 0);

  const jobShare = totalJobs ? (100 * agentJobs) / totalJobs : 0;
  const cpuShare = totalCpuHours ? (100 * agentCpuHours) / totalCpuHours : 0;

  // Distinct users cannot be summed across agents — one person may use both. The exact figure comes
  // from the per-user rows, which are one row per (user, agent) pair.
  const agentUserCount = new Set((agentUsers || []).map((r) => r.User)).size;

  const gran = byPeriod?.granularity || "month";
  const periodRows = byPeriod?.data || [];
  const agentNames = [...new Set(periodRows.map((r) => r.agent))].sort();

  // Pivot (period, agent) rows into one row per period with a column per agent, which is what a
  // grouped Recharts series needs. Missing combinations are filled with 0 rather than left
  // undefined, so a line drops to the axis instead of breaking.
  const periodMap = {};
  periodRows.forEach((r) => {
    const key = periodSortKey(r.period);
    if (!periodMap[key]) {
      periodMap[key] = { period: formatPeriod(r.period, gran), _sort: key };
      agentNames.forEach((a) => {
        periodMap[key][a] = 0;
        periodMap[key][`${a}__users`] = 0;
      });
    }
    periodMap[key][r.agent] = Number(r.job_count || 0);
    periodMap[key][`${r.agent}__users`] = Number(r.unique_users || 0);
  });
  const periodData = Object.values(periodMap).sort((a, b) => a._sort.localeCompare(b._sort));

  const topUsers = [...(agentUsers || [])]
    .sort((a, b) => Number(b.job_count || 0) - Number(a.job_count || 0))
    .slice(0, 10);

  const scopeParts = [node && `node: ${node}`, group && `group: ${group}`].filter(Boolean);
  const scopeSuffix = scopeParts.length ? ` (${scopeParts.join(", ")})` : "";

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg shadow border border-black-20 p-3 text-sm text-cool-grey">
        Counts jobs whose <code>WorkDir</code> or <code>SubmitLine</code> contains an AI coding
        agent's scratch or worktree path. An agent that submits a script from the project tree
        leaves no such path and is counted as human work, so these are lower bounds — a floor, not
        a census.
      </div>

      {anyLoading && summaries && (
        <LoadingProgress
          completed={completed}
          total={queries.length}
          label="Updating results"
          details={details}
        />
      )}

      {!anyLoading && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card
              label="Agent-submitted jobs"
              value={fmtInt(agentJobs)}
              sub={`${jobShare.toFixed(1)}% of ${fmtInt(totalJobs)} jobs${scopeSuffix}`}
            />
            <Card label="Users with agent jobs" value={fmtInt(agentUserCount)} />
            <Card
              label="Agent CPU hours"
              value={fmtHours(agentCpuHours)}
              sub={`${cpuShare.toFixed(1)}% of cluster CPU hours`}
            />
            {showCost ? (
              <Card label="Agent EC2 equivalent" value={formatUsd(agentCost)} />
            ) : (
              <Card label="Agents detected" value={fmtInt(agentRows.length)} />
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white rounded-lg shadow border border-black-20 p-4">
              <h3 className="font-semibold text-black-su mb-3">
                Agent jobs per {periodLabel(gran).toLowerCase()}
              </h3>
              <ChartFigure summary={`Agent-submitted jobs per ${periodLabel(gran).toLowerCase()}: ${agentNames.map((a) => `${a} ${fmtCount(total(periodData, (r) => r[a]))}`).join(", ") || "none"} in total${(() => { const p = peak(periodData, "period", (r) => agentNames.reduce((s, a) => s + (r[a] || 0), 0)); return p ? `; busiest ${p.at} with ${fmtCount(p.value)}` : ""; })()}.`}>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={periodData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Legend />
                    {agentNames.map((a, i) => (
                      <Bar key={a} dataKey={a} stackId="jobs" fill={colorFor(a, i)} name={a} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </ChartFigure>
            </div>

            <div className="bg-white rounded-lg shadow border border-black-20 p-4">
              <h3 className="font-semibold text-black-su mb-3">
                Distinct users per {periodLabel(gran).toLowerCase()}
              </h3>
              <ChartFigure summary={`Distinct users with agent jobs per ${periodLabel(gran).toLowerCase()}: ${agentNames.map((a) => { const p = peak(periodData, "period", (r) => r[`${a}__users`]); return `${a} up to ${p ? fmtCount(p.value) : 0}`; }).join(", ") || "none"}.`}>
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart data={periodData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip />
                    <Legend />
                    {agentNames.map((a, i) => (
                      <Line
                        key={a}
                        type="monotone"
                        dataKey={`${a}__users`}
                        stroke={colorFor(a, i)}
                        name={a}
                        dot={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </ChartFigure>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white rounded-lg shadow border border-black-20 p-4">
              <h3 className="font-semibold text-black-su mb-3">Top users by agent jobs</h3>
              <ChartFigure summary={`Top users by agent jobs: ${topList(topUsers, (r) => `${r.User} via ${r.agent}`, "job_count", (v) => `${fmtCount(v)} jobs`)}.`}>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={topUsers} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis type="number" tick={{ fontSize: 11 }} />
                    <YAxis
                      type="category"
                      dataKey="User"
                      width={110}
                      tick={{ fontSize: 11 }}
                    />
                    <Tooltip />
                    {/* One bar series, coloured per row by that row's agent — `Cell` is how Recharts
                        varies fill within a series; a nested `Bar` would not render. */}
                    <Bar dataKey="job_count" name="Jobs">
                      {topUsers.map((r, i) => (
                        <Cell key={i} fill={colorFor(r.agent, agentNames.indexOf(r.agent))} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ChartFigure>
              {/* Per-row colour is the only thing saying which agent a bar belongs to, so it needs a
                  key — Recharts' own Legend would show a single "Jobs" swatch for the one series. */}
              <ul className="flex flex-wrap gap-4 mt-2 text-xs text-black-su">
                {[...new Set(topUsers.map((r) => r.agent))].map((a) => (
                  <li key={a} className="flex items-center gap-1.5">
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-sm"
                      style={{ background: colorFor(a, agentNames.indexOf(a)) }}
                    />
                    {a}
                  </li>
                ))}
              </ul>
            </div>

            <div className="bg-white rounded-lg shadow border border-black-20 p-4">
              <h3 className="font-semibold text-black-su mb-3">By agent</h3>
              <table className="w-full text-sm">
                <thead className="bg-fog border-b border-black-20">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-black-su">Agent</th>
                    <th className="px-3 py-2 text-right font-medium text-black-su">Jobs</th>
                    <th className="px-3 py-2 text-right font-medium text-black-su">Users</th>
                    <th className="px-3 py-2 text-right font-medium text-black-su">CPU Hours</th>
                    <th className="px-3 py-2 text-left font-medium text-black-su">Last Submit</th>
                  </tr>
                </thead>
                <tbody>
                  {agentRows.map((r) => (
                    <tr key={r.agent} className="border-b border-black-10">
                      <td className="px-3 py-2">
                        <span
                          className="inline-block w-2 h-2 rounded-full mr-2"
                          style={{ background: colorFor(r.agent, agentNames.indexOf(r.agent)) }}
                        />
                        {r.agent}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtInt(r.job_count)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {fmtInt(r.unique_users)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {fmtHours(r.cpu_hours)}
                      </td>
                      <td className="px-3 py-2">{fmtDate(r.last_submit)}</td>
                    </tr>
                  ))}
                  {agentRows.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-center text-cool-grey">
                        No agent-submitted jobs in this range.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <h3 className="font-semibold text-black-su mb-3">Agent usage by user</h3>
            <AgentUserTable rows={agentUsers || []} />
          </div>
        </>
      )}
    </div>
  );
}
