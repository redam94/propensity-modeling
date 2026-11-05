import { useRef, useState, type DragEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { deleteDataset, getDataset, listDatasets, uploadDataset } from "../api/client";
import type { ColumnKind, DatasetProfile } from "../api/types";
import { Callout, Card, Empty, ErrorBox, Icon, Loading, ProgressBar, Spinner } from "../components/ui";
import { fmtInt } from "../lib/format";

const ACCEPT = ".xlsx,.xls,.csv";
const ACCEPT_RE = /\.(xlsx|xls|csv)$/i;

function rememberDataset(id: string) {
  try {
    localStorage.setItem("lastDatasetId", id);
  } catch {
    /* ignore */
  }
}

function kindCounts(p: DatasetProfile): [ColumnKind, number][] {
  const m = new Map<ColumnKind, number>();
  for (const c of p.columns) m.set(c.kind, (m.get(c.kind) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function roleSummary(p: DatasetProfile) {
  const n = (r: string) => p.columns.filter((c) => c.suggested_role === r).length;
  return { treatment: n("treatment"), outcome: n("outcome"), model: n("model_feature"), matching: n("matching_feature") };
}

function ProfileSummary({ profile, onSheet, sheetLoading }: { profile: DatasetProfile; onSheet: (s: string) => void; sheetLoading: boolean }) {
  const navigate = useNavigate();
  const roles = roleSummary(profile);
  const go = () => {
    rememberDataset(profile.dataset_id);
    navigate(`/configure/${profile.dataset_id}${profile.sheet ? `?sheet=${encodeURIComponent(profile.sheet)}` : ""}`);
  };
  return (
    <Card
      title={
        <span className="row" style={{ gap: 8 }}>
          <Icon.file /> {profile.filename}
        </span>
      }
      desc={`Dataset ${profile.dataset_id}`}
      actions={
        <button className="btn primary" onClick={go} disabled={sheetLoading}>
          Configure analysis →
        </button>
      }
    >
      <div className="stack">
        {profile.sheet_names.length > 1 && (
          <div className="row">
            <div className="field" style={{ minWidth: 240 }}>
              <label htmlFor="sheet">Worksheet</label>
              <select id="sheet" value={profile.sheet ?? ""} onChange={(e) => onSheet(e.target.value)} disabled={sheetLoading}>
                {profile.sheet_names.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            {sheetLoading && (
              <span className="row muted small" style={{ marginTop: 18 }}>
                <Spinner small /> Profiling sheet…
              </span>
            )}
          </div>
        )}
        <div className="kpis">
          <div className="kpi">
            <div className="label">Respondents</div>
            <div className="value">{fmtInt(profile.n_rows)}</div>
          </div>
          <div className="kpi">
            <div className="label">Columns</div>
            <div className="value">{fmtInt(profile.n_cols)}</div>
            <div className="hint">
              {kindCounts(profile)
                .map(([k, n]) => `${n} ${k}`)
                .join(" · ")}
            </div>
          </div>
          <div className="kpi">
            <div className="label">Suggested roles</div>
            <div className="value" style={{ fontSize: 15, marginTop: 6 }}>
              {roles.treatment ? "1 treatment" : "no treatment"} · {roles.outcome} outcomes
            </div>
            <div className="hint">
              {roles.model} model · {roles.matching} matching features
            </div>
          </div>
        </div>
        {roles.treatment === 0 && (
          <Callout kind="warn">No exposed/control column was detected automatically — you can pick it on the next step.</Callout>
        )}
      </div>
    </Card>
  );
}

export default function UploadPage() {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState(0);
  const [current, setCurrent] = useState<DatasetProfile | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const datasets = useQuery({ queryKey: ["datasets"], queryFn: listDatasets });

  const upload = useMutation({
    mutationFn: (file: File) => uploadDataset(file, { onProgress: setProgress }),
    onMutate: () => {
      setProgress(0);
      setLocalError(null);
    },
    onSuccess: (p) => {
      setCurrent(p);
      rememberDataset(p.dataset_id);
      qc.setQueryData(["dataset", p.dataset_id, p.sheet ?? null], p);
      qc.invalidateQueries({ queryKey: ["datasets"] });
    },
  });

  const sheet = useMutation({
    mutationFn: ({ id, s }: { id: string; s: string }) => getDataset(id, s),
    onSuccess: (p) => {
      setCurrent(p);
      qc.setQueryData(["dataset", p.dataset_id, p.sheet ?? null], p);
    },
  });

  const remove = useMutation({
    mutationFn: deleteDataset,
    onSuccess: (_, id) => {
      if (current?.dataset_id === id) setCurrent(null);
      qc.invalidateQueries({ queryKey: ["datasets"] });
    },
  });

  const handleFiles = (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    if (!ACCEPT_RE.test(f.name)) {
      setLocalError(`"${f.name}" is not supported. Upload an .xlsx, .xls or .csv file.`);
      return;
    }
    upload.mutate(f);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    handleFiles(e.dataTransfer.files);
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Data</h1>
          <div className="sub">Upload respondent-level survey data coded as exposed vs control.</div>
        </div>
      </div>

      <div
        className={`dropzone${over ? " over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        onClick={() => !upload.isPending && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <div className="icon">
          <Icon.upload />
        </div>
        {upload.isPending ? (
          <div className="stack" style={{ alignItems: "center", gap: 8 }}>
            <h3>{progress < 1 ? `Uploading… ${Math.round(progress * 100)}%` : "Profiling columns…"}</h3>
            <div style={{ width: 320 }}>
              <ProgressBar value={progress} status={progress >= 1 ? "queued" : "running"} />
            </div>
          </div>
        ) : (
          <>
            <h3>Drop an Excel or CSV file here</h3>
            <div className="muted">
              or <span style={{ color: "var(--primary)", fontWeight: 600 }}>browse</span> — .xlsx, .xls, .csv · one row per respondent
            </div>
          </>
        )}
      </div>

      {localError && <ErrorBox title="Unsupported file" error={localError} />}
      {upload.isError && <ErrorBox title="Upload failed" error={upload.error} />}
      {sheet.isError && <ErrorBox title="Could not load sheet" error={sheet.error} />}

      {current && (
        <ProfileSummary
          profile={current}
          sheetLoading={sheet.isPending}
          onSheet={(s) => sheet.mutate({ id: current.dataset_id, s })}
        />
      )}

      <Card title="Previous datasets" desc="Datasets stored on the analysis server" flush>
        {datasets.isLoading ? (
          <Loading />
        ) : datasets.isError ? (
          <div className="card-body">
            <ErrorBox error={datasets.error} onRetry={() => datasets.refetch()} />
          </div>
        ) : !datasets.data?.length ? (
          <Empty title="No datasets yet">Upload a file above to get started.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Sheet</th>
                  <th className="num">Rows</th>
                  <th className="num">Columns</th>
                  <th>ID</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {datasets.data.map((d) => (
                  <tr key={d.dataset_id} className={current?.dataset_id === d.dataset_id ? "selected" : ""}>
                    <td>
                      <button className="btn ghost sm" style={{ padding: 0 }} onClick={() => setCurrent(d)} title="Show summary">
                        <Icon.file /> {d.filename}
                      </button>
                    </td>
                    <td className="muted">{d.sheet ?? (d.sheet_names.length ? d.sheet_names[0] : "—")}</td>
                    <td className="num">{fmtInt(d.n_rows)}</td>
                    <td className="num">{fmtInt(d.n_cols)}</td>
                    <td className="mono muted">{d.dataset_id}</td>
                    <td className="num">
                      <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
                        <Link
                          className="btn sm"
                          to={`/configure/${d.dataset_id}${d.sheet ? `?sheet=${encodeURIComponent(d.sheet)}` : ""}`}
                          onClick={() => rememberDataset(d.dataset_id)}
                        >
                          Configure
                        </Link>
                        <button
                          className="btn sm danger"
                          disabled={remove.isPending}
                          onClick={() => {
                            if (confirm(`Delete dataset "${d.filename}"? Existing analysis results are kept.`)) remove.mutate(d.dataset_id);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {remove.isError && <ErrorBox title="Delete failed" error={remove.error} />}
    </div>
  );
}
