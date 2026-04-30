import { useState } from "react";
import SummaryCards from "./components/SummaryCards";
import JobsDashboard from "./components/JobsDashboard";
import ClusterDashboard from "./components/ClusterDashboard";
import UserDashboard from "./components/UserDashboard";

const TABS = [
  { id: "jobs", label: "Jobs" },
  { id: "cluster", label: "Cluster" },
  { id: "users", label: "Users" },
];

export default function App() {
  const [tab, setTab] = useState("jobs");

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900">Slurm Viz</h1>
          <nav className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                  tab === t.id
                    ? "bg-blue-600 text-white"
                    : "text-gray-600 hover:bg-gray-100"
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
        <SummaryCards />
        {tab === "jobs" && <JobsDashboard />}
        {tab === "cluster" && <ClusterDashboard />}
        {tab === "users" && <UserDashboard />}
      </main>
    </div>
  );
}
