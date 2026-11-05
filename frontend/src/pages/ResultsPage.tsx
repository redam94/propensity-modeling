import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteAnalysis, downloadExport, getAnalysis, isActive } from "../api/client";
import type { AnalysisResult, JobDetail } from "../api/types";
import { Callout, Card, Empty, ErrorBox, Icon, Kpi, Loading, ProgressBar, Spinner, StatusBadge } from "../components/ui";
import { elapsedSeconds, fmtDateTime, fmtDuration, fmtInt, fmtNum, fmtPct } from "../lib/format";
import BalanceTab from "./results/BalanceTab";
import ConfigTab from "./results/ConfigTab";
import LiftTab from "./results/LiftTab";
import ModelTab from "./results/ModelTab";
import OverlapTab from "./results/OverlapTab";
import SubgroupsTab from "./results/SubgroupsTab";

const TABS = ["lift", "overlap", "balance", "model", "subgroups", "config"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  lift: "Lift",
  overlap: "Overlap",
  balance: "Balance",
  model: "Model",
  subgroups: "Subgroups",
  config: "Config",
};

function JobPending({ job }: { job: JobDetail }) {
  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => deleteAnalysis(job.analysis_id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["analysis", job.analysis_id] });
      qc.invalidateQueries({ queryKey: ["analyses"] });
    },
  });
  const el = elapsedSeconds(job.started_at ?? job.submitted_at);
  return (
    <Card>
      <div className="stack" style={{ alignItems: "center", padding: "32px 0", textAlign: "center" }}>
        <StatusBadge status={job.status} />
        <h2>{job.status === "queued" ? "Waiting for a free worker…" : job.stage ? `${job.stage.charAt(0).toUpperCase()}${job.stage.slice(1)}…` : "Running…"}</h2>
        <div style={{ width: 420, maxWidth: "100%" }}>
          <ProgressBar value={job.progress} status={job.status} />
        </div>
        <div className="muted small">
          {Math.round(job.progress * 100)}% · elapsed {fmtDuration(el)} · this page updates automatically
        </div>
        <div className="row">
          <button className="btn danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            {cancel.isPending ? <Spinner small /> : null} Cancel run
          </button>
          <Link className="btn" to="/runs">
            All runs
          </Link>
        </div>
        {cancel.isError && <ErrorBox error={cancel.error} />}
      </div>
    </Card>
  );
}

function SampleKpis({ r }: { r: AnalysisResult }) {
  const s = r.sample;
  const dropped = s.n_dropped_treatment_missing + s.n_dropped_feature_missing;
  const trimmed = r.overlap.n_trimmed_exposed + r.overlap.n_trimmed_control;
  return (
    <div className="kpis">
      <Kpi tone="exposed" label="Exposed analysed" value={fmtInt(s.n_analysed_exposed)} hint={`of ${fmtInt(s.n_exposed)} exposed`} />
      <Kpi tone="control" label="Control analysed" value={fmtInt(s.n_analysed_control)} hint={`of ${fmtInt(s.n_control)} control`} />
      <Kpi
        label="Dropped"
        value={fmtInt(dropped)}
        hint={`${fmtInt(s.n_dropped_treatment_missing)} no group · ${fmtInt(s.n_dropped_feature_missing)} missing features`}
      />
      <Kpi label="Trimmed" value={fmtInt(trimmed)} hint={`${fmtInt(r.overlap.n_trimmed_exposed)} exp. · ${fmtInt(r.overlap.n_trimmed_control)} ctl.`} />
      <Kpi label="PS model AUC" value={fmtNum(r.model.auc, 3)} />
      <Kpi label="PS overlap (OVL)" value={fmtPct(r.overlap.overlap_coefficient)} />
    </div>
  );
}

function Results({ job, result }: { job: JobDetail; result: AnalysisResult }) {
  const [params, setParams] = useSearchParams();
  const tabParam = params.get("tab") as Tab | null;
  const tab: Tab = tabParam && TABS.includes(tabParam) ? tabParam : "lift";
  const [methodKey, setMethodKey] = useState<string>(result.methods[0]?.method ?? "");
  const method = result.methods.find((m) => m.method === methodKey) ?? result.methods[0];
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<unknown>(null);

  const doExport = async () => {
    setExporting(true);
    setExportError(null);
    try {
      await downloadExport(result.analysis_id);
    } catch (e) {
      setExportError(e);
    } finally {
      setExporting(false);
    }
  };

  const allWarnings = [
    ...result.warnings.map((w) => ({ w, src: "" })),
    ...result.methods.flatMap((m) => m.warnings.map((w) => ({ w, src: m.label }))),
  ];

  return (
    <div className="stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <div className="row" style={{ gap: 10 }}>
            <h1>{job.name || result.config.name || "Untitled run"}</h1>
            <StatusBadge status={job.status} />
          </div>
          <div className="sub">
            <span className="mono">{result.analysis_id}</span> · {fmtDateTime(result.created_at)} · computed in {fmtDuration(result.duration_seconds)} ·
            treatment <b>{result.config.treatment_column}</b> · {result.config.outcome_columns.length} outcomes
          </div>
        </div>
        <div className="page-actions">
          <Link className="btn" to={`/configure/${result.config.dataset_id}${result.config.sheet ? `?sheet=${encodeURIComponent(result.config.sheet)}` : ""}`}>
            New run on this data
          </Link>
          <button className="btn primary" onClick={doExport} disabled={exporting}>
            {exporting ? <Spinner small /> : <Icon.download />} Export to Excel
          </button>
        </div>
      </div>
      {exportError != null && <ErrorBox title="Export failed" error={exportError} />}

      <SampleKpis r={result} />

      {allWarnings.length > 0 && (
        <Callout kind="warn" title={`${allWarnings.length} warning${allWarnings.length > 1 ? "s" : ""}`}>
          <ul>
            {allWarnings.slice(0, 12).map(({ w, src }, i) => (
              <li key={i}>
                {src && <b>{src}: </b>}
                {w}
              </li>
            ))}
            {allWarnings.length > 12 && <li className="muted">…and {allWarnings.length - 12} more</li>}
          </ul>
        </Callout>
      )}

      <div>
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`tab${tab === t ? " on" : ""}`}
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set("tab", t);
                setParams(next, { replace: true });
              }}
            >
              {TAB_LABEL[t]}
              {t === "subgroups" && method && method.subgroups.length > 0 && <span className="muted"> · {new Set(method.subgroups.map((s) => s.subgroup_column)).size}</span>}
            </button>
          ))}
        </div>
        {tab === "lift" && <LiftTab result={result} method={method} onMethod={setMethodKey} />}
        {tab === "overlap" && <OverlapTab result={result} />}
        {tab === "balance" && <BalanceTab result={result} method={method} onMethod={setMethodKey} />}
        {tab === "model" && <ModelTab result={result} />}
        {tab === "subgroups" && <SubgroupsTab result={result} method={method} onMethod={setMethodKey} />}
        {tab === "config" && <ConfigTab config={result.config} />}
      </div>
    </div>
  );
}

export default function ResultsPage() {
  const { analysisId } = useParams();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["analysis", analysisId],
    queryFn: () => getAnalysis(analysisId!),
    enabled: !!analysisId,
    refetchInterval: (query) => (query.state.data && isActive(query.state.data.status) ? 1500 : false),
    staleTime: (query) => (query.state.data?.status === "completed" ? Infinity : 0),
  });

  if (q.isLoading) return <Loading label="Loading analysis…" />;
  if (q.isError)
    return (
      <div className="stack">
        <ErrorBox title="Could not load analysis" error={q.error} onRetry={() => q.refetch()} />
        <div>
          <button className="btn" onClick={() => navigate("/runs")}>
            Back to runs
          </button>
        </div>
      </div>
    );
  const job = q.data;
  if (!job) return null;

  if (isActive(job.status)) {
    return (
      <div className="stack">
        <div className="page-head">
          <div>
            <h1>{job.name || "Untitled run"}</h1>
            <div className="sub mono">{job.analysis_id}</div>
          </div>
        </div>
        <JobPending job={job} />
      </div>
    );
  }
  if (job.status === "failed" || job.status === "cancelled") {
    return (
      <div className="stack">
        <div className="page-head">
          <div>
            <div className="row" style={{ gap: 10 }}>
              <h1>{job.name || "Untitled run"}</h1>
              <StatusBadge status={job.status} />
            </div>
            <div className="sub mono">{job.analysis_id}</div>
          </div>
          <div className="page-actions">
            <Link className="btn" to={`/configure/${job.dataset_id}`}>
              Reconfigure
            </Link>
            <Link className="btn" to="/runs">
              All runs
            </Link>
          </div>
        </div>
        {job.status === "failed" ? (
          <ErrorBox title="The analysis failed" error={job.error ?? "Unknown error"} />
        ) : (
          <Callout kind="info" title="Run cancelled">
            This analysis was cancelled before it finished.
          </Callout>
        )}
      </div>
    );
  }
  if (!job.result)
    return (
      <Card>
        <Empty title="No result payload">The job is marked completed but returned no result.</Empty>
      </Card>
    );
  return <Results job={job} result={job.result} />;
}
