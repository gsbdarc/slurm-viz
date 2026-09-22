/**
 * Server-renders every dashboard tab for every cluster and reports which ones crash.
 *
 * Bundled and run by `run.mjs`; see there for why this exists. A tab is skipped on a cluster whose
 * `features` hide it in the app (the same gating as `TABS` in App.jsx), so the test covers exactly
 * what users can reach. When you add a tab, add it to `TABS` below.
 */
import { renderToString } from "react-dom/server";
import { CLUSTER_LIST } from "../src/lib/clusters.js";
import SummaryCards from "../src/components/SummaryCards.jsx";
import JobsDashboard from "../src/components/JobsDashboard.jsx";
import ClusterDashboard from "../src/components/ClusterDashboard.jsx";
import UtilizationDashboard from "../src/components/UtilizationDashboard.jsx";
import UserDashboard from "../src/components/UserDashboard.jsx";
import GroupDashboard from "../src/components/GroupDashboard.jsx";
import AgentsDashboard from "../src/components/AgentsDashboard.jsx";
import { requested } from "./mock-query.js";

const TABS = [
  { name: "SummaryCards", Tab: SummaryCards },
  { name: "Jobs", Tab: JobsDashboard },
  { name: "Cluster", Tab: ClusterDashboard },
  { name: "Utilization", Tab: UtilizationDashboard, feature: "usage" },
  { name: "Users", Tab: UserDashboard },
  { name: "Groups", Tab: GroupDashboard, feature: "groups" },
  { name: "Agents", Tab: AgentsDashboard, feature: "agentDetection" },
];

export function run() {
  let runs = 0;
  let fails = 0;
  for (const cluster of CLUSTER_LIST) {
    for (const { name, Tab, feature } of TABS) {
      if (feature && !cluster.features[feature]) continue;
      runs++;
      const label = `${cluster.id.padEnd(9)} ${name.padEnd(13)}`;
      try {
        const html = renderToString(
          <Tab cluster={cluster} startDate="2026-08-23" endDate="2026-09-22" node="" group="" />,
        );
        // A tab that catches its own failure renders an "Error:" banner rather than throwing.
        if (/Error:/.test(html)) {
          fails++;
          console.log(`FAIL ${label} rendered an error banner`);
        } else {
          const charts = (html.match(/role="img"/g) || []).length;
          console.log(`ok   ${label} ${charts} chart${charts === 1 ? "" : "s"}`);
        }
      } catch (e) {
        fails++;
        console.log(`FAIL ${label} ${e.constructor.name}: ${e.message}`);
      }
    }
  }
  console.log(`\n${runs - fails}/${runs} renders passed · queries exercised: ${[...requested].sort().join(", ")}`);
  return fails;
}
