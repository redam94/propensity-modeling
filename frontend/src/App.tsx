import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getHealth, isActive, listAnalyses } from "./api/client";
import { Icon } from "./components/ui";
import { lastConfigurePath } from "./lib/lastDataset";
import UploadPage from "./pages/UploadPage";
import ConfigurePage from "./pages/ConfigurePage";
import RunsPage from "./pages/RunsPage";
import ResultsPage from "./pages/ResultsPage";

function Sidebar() {
  const location = useLocation();
  const health = useQuery({ queryKey: ["health"], queryFn: getHealth, refetchInterval: 15_000, retry: false });
  const runs = useQuery({
    queryKey: ["analyses"],
    queryFn: listAnalyses,
    refetchInterval: (q) => (q.state.data?.some((j) => isActive(j.status)) ? 1500 : 10_000),
  });
  const active = runs.data?.filter((j) => isActive(j.status)).length ?? 0;
  const configurePath = lastConfigurePath();
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <Icon.chart />
        </div>
        <div className="brand-text">
          Lift Analyzer
          <small>Propensity modeling</small>
        </div>
      </div>
      <NavLink to="/upload" className="nav-link" title="Data">
        <Icon.upload />
        <span className="nav-label">Data</span>
      </NavLink>
      <NavLink
        to={configurePath}
        className={({ isActive: a }) => `nav-link${a || location.pathname.startsWith("/configure") ? " active" : ""}`}
        title="Configure"
      >
        <Icon.sliders />
        <span className="nav-label">Configure</span>
      </NavLink>
      <NavLink to="/runs" className="nav-link" title="Runs & results">
        <Icon.list />
        <span className="nav-label">Runs &amp; results</span>
        {active > 0 && <span className="count">{active}</span>}
      </NavLink>
      <div className="sidebar-foot" title={health.data ? `${health.data.workers} worker processes` : "API status"}>
        <span className={`dot ${health.isSuccess ? "ok" : health.isError ? "bad" : "wait"}`} />
        <span className="label">
          {health.isSuccess ? `API online · ${health.data.workers} workers` : health.isError ? "API offline" : "Connecting…"}
        </span>
      </div>
    </aside>
  );
}

export default function App() {
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/upload" replace />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/configure" element={<ConfigurePage />} />
          <Route path="/configure/:datasetId" element={<ConfigurePage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:analysisId" element={<ResultsPage />} />
          <Route path="*" element={<Navigate to="/upload" replace />} />
        </Routes>
      </main>
    </div>
  );
}
