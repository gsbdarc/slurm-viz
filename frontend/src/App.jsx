import { useState, useEffect } from "react";
import SummaryCards from "./components/SummaryCards";
import JobsDashboard from "./components/JobsDashboard";
import ClusterDashboard from "./components/ClusterDashboard";
import UserDashboard from "./components/UserDashboard";

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

function AuthButton() {
  const [status, setStatus] = useState(null);
  const [authUrl, setAuthUrl] = useState(null);
  const [polling, setPolling] = useState(false);

  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    if (!polling) return;
    const id = setInterval(() => {
      fetch("/api/auth/poll")
        .then((r) => r.json())
        .then((res) => {
          if (res.status === "authenticated") {
            setPolling(false);
            setAuthUrl(null);
            setStatus({ authenticated: true });
            window.location.reload();
          } else if (res.status === "error") {
            setPolling(false);
            setAuthUrl(null);
          }
        });
    }, 5000);
    return () => clearInterval(id);
  }, [polling]);

  const handleAuth = () => {
    fetch("/api/auth/start", { method: "POST" })
      .then((r) => r.json())
      .then((res) => {
        if (res.verification_url) {
          setAuthUrl(res.verification_url);
          setPolling(true);
          window.open(res.verification_url, "_blank");
        }
      });
  };

  const handleLogout = () => {
    fetch("/api/auth/logout", { method: "POST" })
      .then((r) => r.json())
      .then(() => window.location.reload());
  };

  if (status?.authenticated) {
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

  if (authUrl) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-poppy animate-pulse">
          Waiting for login...
        </span>
        <a
          href={authUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-digital-blue underline"
        >
          Open Redivis
        </a>
      </div>
    );
  }

  return (
    <button
      onClick={handleAuth}
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

export default function App() {
  const [tab, setTab] = useState("jobs");
  const [startDate, setStartDate] = useState(daysAgo(30));
  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10));

  const dateParams = `start=${startDate}&end=${endDate}`;

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
            <AuthButton />
          </div>
        </div>
      </header>

      <div className="sticky top-0 z-10 bg-fog-light border-b border-black-20 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-3">
          <DateRangePicker
            startDate={startDate}
            endDate={endDate}
            onChange={(s, e) => {
              setStartDate(s);
              setEndDate(e);
            }}
          />
        </div>
      </div>

      <main className="max-w-7xl mx-auto px-4 py-4">
        <SummaryCards dateParams={dateParams} />
        {tab === "jobs" && <JobsDashboard dateParams={dateParams} />}
        {tab === "cluster" && <ClusterDashboard dateParams={dateParams} />}
        {tab === "users" && <UserDashboard dateParams={dateParams} />}
      </main>

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
