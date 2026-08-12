import { useState, useEffect } from "react";
import * as redivis from "redivis";
import SummaryCards from "./components/SummaryCards";
import JobsDashboard from "./components/JobsDashboard";
import ClusterDashboard from "./components/ClusterDashboard";
import UserDashboard from "./components/UserDashboard";
import GroupDashboard from "./components/GroupDashboard";
import { useRedivisQuery } from "./hooks/useRedivisQuery";
import { getFilterOptions, getSamplingStats, ck } from "./redivis/queries";
import { CLUSTER_LIST, DEFAULT_CLUSTER, getCluster } from "./lib/clusters";

const TABS = [
  { id: "jobs", label: "Jobs" },
  { id: "cluster", label: "Cluster" },
  { id: "users", label: "Users" },
  { id: "groups", label: "Groups", feature: "groups" },
];

/** Tabs this cluster can populate — same feature-gating idiom as `jobColumnsFor`. */
function tabsFor(cluster) {
  return TABS.filter((t) => !t.feature || cluster.features[t.feature]);
}

function pct(part, whole) {
  if (!whole) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const PRESETS = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "1y", days: 365 },
];

function AuthButton({ authed, onAuthChange }) {
  const [loggingIn, setLoggingIn] = useState(false);

  const handleLogin = async () => {
    setLoggingIn(true);
    try {
      await redivis.authorize();
      onAuthChange(true);
    } catch {
      // user closed popup or error
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    await redivis.deauthorize();
    onAuthChange(false);
  };

  if (authed) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-digital-green-light font-medium">
          Authenticated
        </span>
        <button
          onClick={handleLogout}
          className="text-sm text-black-40 hover:text-white px-2 py-1"
        >
          Logout
        </button>
      </div>
    );
  }

  if (loggingIn) {
    return (
      <span className="text-sm text-poppy animate-pulse">
        Waiting for login...
      </span>
    );
  }

  return (
    <button
      onClick={handleLogin}
      className="px-3 py-1.5 rounded-md text-sm font-medium bg-poppy text-white hover:bg-poppy-light"
    >
      Authenticate with Redivis
    </button>
  );
}

function DateRangePicker({ startDate, endDate, onChange }) {
  const [activePreset, setActivePreset] = useState("30d");

  const applyPreset = (label, days) => {
    setActivePreset(label);
    onChange(daysAgo(days), new Date().toISOString().slice(0, 10));
  };

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="flex gap-1">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            onClick={() => applyPreset(p.label, p.days)}
            className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
              activePreset === p.label
                ? "bg-digital-red text-white"
                : "bg-white text-black-80 hover:bg-black-10 border border-black-20"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 text-sm">
        <input
          type="date"
          value={startDate}
          onChange={(e) => {
            setActivePreset(null);
            onChange(e.target.value, endDate);
          }}
          className="border border-black-20 rounded px-2 py-1"
        />
        <span className="text-black-60">to</span>
        <input
          type="date"
          value={endDate}
          onChange={(e) => {
            setActivePreset(null);
            onChange(startDate, e.target.value);
          }}
          className="border border-black-20 rounded px-2 py-1"
        />
      </div>
    </div>
  );
}

/**
 * A combobox rather than a `<select>`, because the node list is a suggestion, not the set of legal
 * answers: filtering matches the typed name against the node lists in SQL, so a node the list
 * doesn't offer — a rare one on a large cluster, or one dropped by the token cap — still filters
 * correctly. A `<select>` cannot express that, and 1,000+ options is unusable anyway.
 *
 * The typed value is committed on Enter, on blur, and on an exact match (which is what picking from
 * the datalist produces). Committing per keystroke would fire the whole query fan-out on every
 * letter.
 */
function NodePicker({ nodes, node, onChange, loading, truncated }) {
  const [text, setText] = useState(node);

  useEffect(() => {
    setText(node);
  }, [node]);

  const commit = (value) => {
    const trimmed = value.trim();
    if (trimmed !== node) onChange(trimmed);
  };

  const suggestions = text
    ? nodes.filter((n) => n.toLowerCase().includes(text.toLowerCase())).slice(0, 200)
    : nodes.slice(0, 200);

  return (
    <div className="flex items-center gap-2">
      <input
        list="node-options"
        className="border border-black-20 rounded px-3 py-1.5 text-sm bg-white w-48"
        placeholder={loading ? "Loading nodes..." : "All nodes"}
        value={text}
        disabled={loading}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          // An exact hit is almost certainly a datalist selection, so don't make them press Enter.
          if (nodes.includes(next.trim())) commit(next);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(text);
        }}
        onBlur={() => commit(text)}
      />
      <datalist id="node-options">
        {suggestions.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      {truncated && (
        <span className="text-xs text-black-60 max-w-56 leading-tight">
          Showing the {nodes.length.toLocaleString()} busiest nodes — you can type any node name.
        </span>
      )}
      {node && (
        <button
          onClick={() => onChange("")}
          className="text-sm text-black-60 hover:text-black-su px-2"
        >
          Clear
        </button>
      )}
    </div>
  );
}

/**
 * A plain `<select>`, unlike the node combobox above.
 *
 * The distinction is real: node filtering matches a typed name against compact node lists in SQL, so
 * a name the list doesn't offer still filters correctly and the list is only a suggestion. Group
 * filtering is an equality test over a closed set, so the options *are* the legal answers and free
 * text could only ever return nothing.
 */
function GroupPicker({ groups, group, onChange }) {
  return (
    <div className="flex items-center gap-2">
      <select
        className="border border-black-20 rounded px-3 py-1.5 text-sm bg-white"
        value={group}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">All groups</option>
        {groups.map((g) => (
          <option key={g} value={g}>
            {g}
          </option>
        ))}
      </select>
      {group && (
        <button
          onClick={() => onChange("")}
          className="text-sm text-black-60 hover:text-black-su px-2"
        >
          Clear
        </button>
      )}
    </div>
  );
}

function ClusterToggle({ cluster, onChange }) {
  return (
    <div className="flex gap-1">
      {CLUSTER_LIST.map((c) => (
        <button
          key={c.id}
          onClick={() => onChange(c.id)}
          className={`px-3 py-1.5 rounded-md text-sm font-semibold transition-colors ${
            cluster === c.id
              ? "bg-digital-red text-white"
              : "text-black-20 hover:bg-black-80"
          }`}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("jobs");
  const [startDate, setStartDate] = useState(daysAgo(30));
  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10));
  const [node, setNode] = useState("");
  const [group, setGroup] = useState("");
  const [cluster, setCluster] = useState(DEFAULT_CLUSTER);
  const [authed, setAuthed] = useState(null);

  useEffect(() => {
    redivis.isAuthorized().then(setAuthed);
  }, []);

  const clusterConfig = getCluster(cluster);

  useEffect(() => {
    document.title = `${clusterConfig.title} – Stanford`;
  }, [clusterConfig.title]);

  // Shares a cache key with the per-tab calls, so this adds no extra query.
  const { data: filterOptions, loading: loadingFilters } = useRedivisQuery(
    authed ? () => getFilterOptions(clusterConfig, startDate, endDate) : null,
    authed ? ck(clusterConfig, "filters", startDate, endDate) : null,
  );

  // How much of the record the sampler actually caught, for the range and filters on screen. Only
  // runs where the source samples a live queue; on accounting data the figures would be nonsense.
  const samplingOn = Boolean(authed && clusterConfig.sampling);
  const { data: sampling } = useRedivisQuery(
    samplingOn
      ? () => getSamplingStats(clusterConfig, startDate, endDate, { node, group })
      : null,
    samplingOn
      ? ck(clusterConfig, "sampling", startDate, endDate, node || "", group || "")
      : null,
  );

  const nodes = filterOptions?.nodes || [];
  const nodesTruncated = filterOptions?.nodesTruncated || false;
  const groups = filterOptions?.groups || [];

  // Derived rather than synced: `setTab` stays the only writer of `tab`, so the main area cannot go
  // blank however `cluster` came to be set, and Sherlock → Yen → Sherlock returns you to Groups
  // instead of stranding you on Jobs.
  const tabs = tabsFor(clusterConfig);
  const activeTab = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;

  // Every panel takes the same five, so pass them as one object rather than repeating the list.
  const panelProps = {
    cluster: clusterConfig,
    startDate,
    endDate,
    node,
    group,
  };

  // Node lists are scoped to the date range. Keep the selection when the node still ran in the new
  // range (the common case when widening it), and drop it only when it didn't — otherwise the
  // picker would sit on a node with no jobs and every panel would read zero.
  //
  // Only when the list is known complete, though: it is a truncated suggestion list on a large
  // cluster, and a typed node that filters perfectly well may simply not be in it. Clearing those
  // would fight the user on every load.
  useEffect(() => {
    if (node && filterOptions && !nodesTruncated && !nodes.includes(node)) setNode("");
  }, [node, filterOptions, nodes, nodesTruncated]);

  // Node and group names are cluster-specific, so neither must survive into the other cluster's
  // query. The tab needs no fixing up here — `activeTab` above falls back on its own.
  const switchCluster = (id) => {
    if (id === cluster) return;
    setCluster(id);
    setNode("");
    setGroup("");
  };

  return (
    <div className="min-h-screen bg-fog-light font-sans">
      <div className="bg-cardinal-red">
        <div className="max-w-7xl mx-auto px-4 py-1.5 flex items-center">
          <a
            href="https://www.stanford.edu"
            className="su-brand-logo text-white no-underline"
          >
            Stanford University
          </a>
        </div>
      </div>

      <header className="bg-black-su shadow">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <h1 className="text-xl font-bold text-white font-serif">{clusterConfig.title}</h1>
          <div className="flex items-center gap-3">
            {/* Switching cluster is a change of context, not a filter, so it sits up here with the
                tabs rather than down in the filter bar with the date and node pickers. */}
            <ClusterToggle cluster={cluster} onChange={switchCluster} />
            <span className="w-px h-6 bg-black-80" aria-hidden="true" />
            <nav className="flex gap-1">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`px-4 py-2 rounded-md text-sm font-semibold transition-colors ${
                    activeTab === t.id
                      ? "bg-digital-red text-white"
                      : "text-black-20 hover:bg-black-80"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </nav>
            <AuthButton authed={authed} onAuthChange={setAuthed} />
          </div>
        </div>
      </header>

      {authed === false && (
        <div className="max-w-7xl mx-auto px-4 py-16 text-center">
          <h2 className="text-2xl font-semibold text-black-su mb-3">
            Sign in to view cluster statistics
          </h2>
          <p className="text-black-60 mb-6">
            Authenticate with your Redivis account to access Slurm job data.
          </p>
          <AuthButton authed={false} onAuthChange={setAuthed} />
        </div>
      )}

      {authed && (
        <>
          <div className="sticky top-0 z-10 bg-fog-light border-b border-black-20 shadow-sm">
            <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-4 flex-wrap">
              <DateRangePicker
                startDate={startDate}
                endDate={endDate}
                onChange={(s, e) => {
                  setStartDate(s);
                  setEndDate(e);
                }}
              />
              {clusterConfig.features.nodeFilter && (
                <NodePicker
                  nodes={nodes}
                  node={node}
                  onChange={setNode}
                  loading={loadingFilters}
                  truncated={nodesTruncated}
                />
              )}
              {clusterConfig.features.groups && (
                <GroupPicker groups={groups} group={group} onChange={setGroup} />
              )}
            </div>
          </div>

          {/* An undercounted total must not read as authoritative. The measured figures are appended
              once they arrive rather than gated behind a loading state, so the warning is never
              absent and the banner does not reflow on every date change. */}
          {clusterConfig.caveat && (
            <div className="bg-illuminating border-b border-black-20">
              <div className="max-w-7xl mx-auto px-4 py-2 text-xs text-black-su leading-snug">
                {clusterConfig.caveat}
                {sampling && sampling.jobs > 0 && (
                  <>
                    {" "}
                    <span className="font-semibold">
                      In this range, {pct(sampling.single_snapshot, sampling.jobs)} of{" "}
                      {sampling.jobs.toLocaleString()} jobs were caught in only one{" "}
                      {clusterConfig.sampling.label} snapshot, and{" "}
                      {pct(sampling.never_ran, sampling.jobs)} were never observed running.
                    </span>
                  </>
                )}
              </div>
            </div>
          )}

          <main className="max-w-7xl mx-auto px-4 py-4">
            <SummaryCards {...panelProps} />
            {activeTab === "jobs" && <JobsDashboard {...panelProps} />}
            {activeTab === "cluster" && <ClusterDashboard {...panelProps} />}
            {activeTab === "users" && <UserDashboard {...panelProps} />}
            {activeTab === "groups" && <GroupDashboard {...panelProps} />}
          </main>
        </>
      )}

      <footer className="bg-cardinal-red mt-8">
        <div className="max-w-7xl mx-auto px-4 py-6 flex flex-col sm:flex-row items-center justify-between gap-2">
          <span className="su-brand-logo text-white">
            Stanford University
          </span>
          <span className="text-white/70 text-sm">
            &copy; {new Date().getFullYear()} Stanford University
          </span>
        </div>
      </footer>
    </div>
  );
}
