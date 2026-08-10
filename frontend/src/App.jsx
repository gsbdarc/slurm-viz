import { useState, useEffect } from "react";
import * as redivis from "redivis";
import SummaryCards from "./components/SummaryCards";
import JobsDashboard from "./components/JobsDashboard";
import ClusterDashboard from "./components/ClusterDashboard";
import UserDashboard from "./components/UserDashboard";
import { useRedivisQuery } from "./hooks/useRedivisQuery";
import { getFilterOptions } from "./redivis/queries";

const TABS = [
  { id: "jobs", label: "Jobs" },
  { id: "cluster", label: "Cluster" },
  { id: "users", label: "Users" },
];

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

function NodePicker({ nodes, node, onChange, loading }) {
  return (
    <div className="flex items-center gap-2">
      <select
        className="border border-black-20 rounded px-3 py-1.5 text-sm bg-white"
        value={node}
        onChange={(e) => onChange(e.target.value)}
        disabled={loading}
      >
        <option value="">{loading ? "Loading nodes..." : "All nodes"}</option>
        {nodes.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
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

export default function App() {
  const [tab, setTab] = useState("jobs");
  const [startDate, setStartDate] = useState(daysAgo(30));
  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10));
  const [node, setNode] = useState("");
  const [authed, setAuthed] = useState(null);

  useEffect(() => {
    redivis.isAuthorized().then(setAuthed);
  }, []);

  // Shares a cache key with the per-tab calls, so this adds no extra query.
  const { data: filterOptions, loading: loadingFilters } = useRedivisQuery(
    authed ? () => getFilterOptions(startDate, endDate) : null,
    authed ? `filters_${startDate}_${endDate}` : null,
  );

  const nodes = filterOptions?.nodes || [];

  // Node lists are scoped to the date range — a node selected for one range may not exist in the
  // next, which would silently show zero jobs.
  const handleDateChange = (s, e) => {
    setStartDate(s);
    setEndDate(e);
    setNode("");
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
          <h1 className="text-xl font-bold text-white font-serif">Yen Cluster Slurm Statistics</h1>
          <div className="flex items-center gap-3">
            <nav className="flex gap-1">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`px-4 py-2 rounded-md text-sm font-semibold transition-colors ${
                    tab === t.id
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
                onChange={handleDateChange}
              />
              <NodePicker
                nodes={nodes}
                node={node}
                onChange={setNode}
                loading={loadingFilters}
              />
            </div>
          </div>

          <main className="max-w-7xl mx-auto px-4 py-4">
            <SummaryCards startDate={startDate} endDate={endDate} node={node} />
            {tab === "jobs" && <JobsDashboard startDate={startDate} endDate={endDate} node={node} />}
            {tab === "cluster" && <ClusterDashboard startDate={startDate} endDate={endDate} node={node} />}
            {tab === "users" && <UserDashboard startDate={startDate} endDate={endDate} node={node} />}
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
