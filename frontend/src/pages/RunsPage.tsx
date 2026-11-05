import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteAnalysis, isActive, listAnalyses, listDatasets } from "../api/client";
import type { JobInfo } from "../api/types";
import { Card, Empty, ErrorBox, Loading, ProgressBar, StatusBadge } from "../components/ui";
import { elapsedSeconds, fmtDateTime, fmtDuration } from "../lib/format";
import { useTicker } from "../hooks/useTicker";

export default function RunsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const runs = useQuery({
    queryKey: ["analyses"],
    queryFn: listAnalyses,
    refetchInterval: (q) => (q.state.data?.some((j) => isActive(j.status)) ? 1500 : false),
  });
  const datasets = useQuery({ queryKey: ["datasets"], queryFn: listDatasets });
  const dsName = new Map((datasets.data ?? []).map((d) => [d.dataset_id, d.filename]));
  const anyActive = !!runs.data?.some((j) => isActive(j.status));
  useTicker(anyActive);

  const del = useMutation({
    mutationFn: deleteAnalysis,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["analyses"] }),
  });

  const act = (j: JobInfo) => {
    const active = isActive(j.status);
    const msg = active ? `Cancel run "${j.name ?? j.analysis_id}"?` : `Delete run "${j.name ?? j.analysis_id}" and its results?`;
    if (confirm(msg)) del.mutate(j.analysis_id);
  };

  const counts = (runs.data ?? []).reduce<Record<string, number>>((m, j) => ((m[j.status] = (m[j.status] ?? 0) + 1), m), {});

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Runs &amp; results</h1>
          <div className="sub">
            Analyses run in parallel worker processes. {anyActive && <>Live — refreshing every 1.5 s.</>}
          </div>
        </div>
        <div className="page-actions">
          {Object.entries(counts).map(([s, n]) => (
            <span key={s} className={`badge ${s}`}>
              {n} {s}
            </span>
          ))}
          <Link className="btn primary" to="/configure">
            New analysis
          </Link>
        </div>
      </div>
      {del.isError && <ErrorBox title="Action failed" error={del.error} />}
      <Card flush>
        {runs.isLoading ? (
          <Loading label="Loading runs…" />
        ) : runs.isError ? (
          <div className="card-body">
            <ErrorBox error={runs.error} onRetry={() => runs.refetch()} />
          </div>
        ) : !runs.data?.length ? (
          <Empty title="No analyses yet" actions={<Link className="btn primary" to="/configure">Configure an analysis</Link>}>
            Configure a dataset and run an analysis — it will appear here with live progress.
          </Empty>
        ) : (
          <div className="table-wrap tall">
            <table className="data">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Dataset</th>
                  <th>Status</th>
                  <th style={{ width: 260 }}>Progress</th>
                  <th>Submitted</th>
                  <th className="num">Duration</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.data.map((j) => {
                  const active = isActive(j.status);
                  const dur = elapsedSeconds(j.started_at, j.finished_at);
                  return (
                    <tr key={j.analysis_id} className="clickable" onClick={() => navigate(`/runs/${j.analysis_id}`)}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{j.name || "Untitled run"}</div>
                        <div className="mono muted small">{j.analysis_id}</div>
                      </td>
                      <td className="truncate" style={{ maxWidth: 220 }}>
                        {dsName.get(j.dataset_id) ?? <span className="mono muted">{j.dataset_id}</span>}
                      </td>
                      <td>
                        <StatusBadge status={j.status} />
                      </td>
                      <td>
                        {j.status === "failed" ? (
                          <div className="small truncate" style={{ color: "var(--danger)", maxWidth: 260 }} title={j.error ?? ""}>
                            {j.error ?? "Failed"}
                          </div>
                        ) : (
                          <div className="stack" style={{ gap: 4 }}>
                            <ProgressBar value={j.progress} status={j.status} />
                            <span className="small muted">
                              {j.status === "completed"
                                ? "Done"
                                : j.status === "cancelled"
                                  ? "Cancelled"
                                  : j.status === "queued"
                                    ? "Waiting for a worker…"
                                    : `${Math.round(j.progress * 100)}% · ${j.stage ?? "running"}`}
                            </span>
                          </div>
                        )}
                      </td>
                      <td className="nowrap muted">{fmtDateTime(j.submitted_at)}</td>
                      <td className="num">{dur == null ? "—" : fmtDuration(dur)}</td>
                      <td className="num" onClick={(e) => e.stopPropagation()}>
                        <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
                          {j.status === "completed" && (
                            <Link className="btn sm" to={`/runs/${j.analysis_id}`}>
                              Results
                            </Link>
                          )}
                          <button className="btn sm danger" onClick={() => act(j)} disabled={del.isPending && del.variables === j.analysis_id}>
                            {active ? "Cancel" : "Delete"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
