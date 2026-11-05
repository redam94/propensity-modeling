import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getDataset, listDatasets, submitAnalysis } from "../api/client";
import type { ColumnKind, ColumnProfile, DatasetProfile, Estimand, Method, ModelType, TrimRule } from "../api/types";
import { Callout, Card, Empty, ErrorBox, Loading, Seg, Spinner } from "../components/ui";
import {
  ROLE_OPTIONS,
  assignRole,
  buildAnalysisConfig,
  canRecode,
  columnsWithRole,
  defaultTreatmentState,
  initialConfigState,
  needsPositiveLevels,
  validateConfig,
  valueKey,
  type ColumnRole,
  type ColumnState,
  type ConfigState,
  type OptionsState,
  type TreatmentState,
} from "../lib/configBuilder";
import { METHOD_LABELS, fmtInt, fmtScalar } from "../lib/format";
import { rememberDataset } from "../lib/lastDataset";

const KINDS: ColumnKind[] = ["numeric", "binary", "categorical", "datetime", "text", "empty"];
const PAGE_SIZES = [50, 100, 200];

/* ======================================================================== */
/* Column grid                                                              */
/* ======================================================================== */

interface RowProps {
  col: ColumnProfile;
  nRows: number;
  state: ColumnState;
  selected: boolean;
  onSelect: (name: string, on: boolean) => void;
  onRole: (name: string, role: ColumnRole) => void;
  onSubgroup: (name: string, on: boolean) => void;
}

const ColumnRow = memo(function ColumnRow({ col, nRows, state, selected, onSelect, onRole, onSubgroup }: RowProps) {
  const missPct = nRows > 0 ? (col.n_missing / nRows) * 100 : 0;
  const canSub = state.role !== "treatment" && state.role !== "outcome" && state.role !== "subgroup" && state.role !== "ignore";
  return (
    <tr className={selected ? "selected" : ""}>
      <td style={{ width: 32 }}>
        <input type="checkbox" checked={selected} onChange={(e) => onSelect(col.name, e.target.checked)} aria-label={`Select ${col.name}`} />
      </td>
      <td style={{ maxWidth: 280 }}>
        <div className="truncate" title={col.name} style={{ fontWeight: 550 }}>
          {col.name}
        </div>
        {col.suggested_role && col.suggested_role !== "ignore" && (
          <div className="small muted">suggested: {col.suggested_role.replace("_", " ")}</div>
        )}
      </td>
      <td>
        <span className={`kind ${col.kind}`}>{col.kind}</span>
      </td>
      <td className="num" title={`${col.n_missing} missing`}>
        <span style={{ color: missPct > 20 ? "var(--danger)" : missPct > 5 ? "var(--warning)" : undefined }}>
          {missPct === 0 ? "0" : missPct < 0.1 ? "<0.1" : missPct.toFixed(1)}%
        </span>
      </td>
      <td className="num">{fmtInt(col.n_unique)}</td>
      <td>
        {col.kind === "numeric" && col.min != null ? (
          <span className="small muted nowrap">
            {fmtScalar(col.min)} – {fmtScalar(col.max)} · μ {col.mean != null ? col.mean.toFixed(2) : "—"}
          </span>
        ) : (
          <div className="topvals" title={col.top_values.map((t) => `${fmtScalar(t.value)} (${t.count})`).join("\n")}>
            {col.top_values.slice(0, 5).map((t) => (
              <span key={valueKey(t.value)}>{fmtScalar(t.value)}</span>
            ))}
            {col.top_values.length > 5 && <span>+{col.n_unique - 5}</span>}
          </div>
        )}
      </td>
      <td>
        <select
          className={`role-select r-${state.role}`}
          value={state.role}
          onChange={(e) => onRole(col.name, e.target.value as ColumnRole)}
          aria-label={`Role for ${col.name}`}
        >
          {ROLE_OPTIONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.short}
            </option>
          ))}
        </select>
      </td>
      <td style={{ textAlign: "center" }}>
        <input
          type="checkbox"
          disabled={!canSub}
          checked={state.role === "subgroup" || (canSub && state.subgroup)}
          onChange={(e) => onSubgroup(col.name, e.target.checked)}
          title={canSub ? "Also report lift by this column's levels" : "Only feature columns can additionally be subgroups"}
          aria-label={`Use ${col.name} as subgroup`}
        />
      </td>
    </tr>
  );
});

function ColumnGrid({
  profile,
  columns,
  setColumns,
}: {
  profile: DatasetProfile;
  columns: Record<string, ColumnState>;
  setColumns: (fn: (prev: Record<string, ColumnState>) => Record<string, ColumnState>) => void;
}) {
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<ColumnKind | "all">("all");
  const [roleFilter, setRoleFilter] = useState<ColumnRole | "all">("all");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRole, setBulkRole] = useState<ColumnRole>("model");

  const filtered = useMemo(() => {
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return profile.columns.filter((c) => {
      if (kind !== "all" && c.kind !== kind) return false;
      if (roleFilter !== "all" && (columns[c.name]?.role ?? "ignore") !== roleFilter) return false;
      if (terms.length) {
        const hay = c.name.toLowerCase();
        return terms.every((t) => hay.includes(t));
      }
      return true;
    });
  }, [profile.columns, search, kind, roleFilter, columns]);

  useEffect(() => setPage(0), [search, kind, roleFilter, pageSize]);

  const nPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, nPages - 1);
  const pageRows = filtered.slice(safePage * pageSize, safePage * pageSize + pageSize);

  const roleCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of Object.values(columns)) m[s.role] = (m[s.role] ?? 0) + 1;
    return m;
  }, [columns]);

  const allFilteredSelected = filtered.length > 0 && filtered.every((c) => selected.has(c.name));
  const someFilteredSelected = filtered.some((c) => selected.has(c.name));

  const onSelect = useCallback((name: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  }, []);
  const onRole = useCallback(
    (name: string, role: ColumnRole) => setColumns((prev) => assignRole(prev, [name], role)),
    [setColumns],
  );
  const onSubgroup = useCallback(
    (name: string, on: boolean) => setColumns((prev) => ({ ...prev, [name]: { ...prev[name], subgroup: on } })),
    [setColumns],
  );

  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) filtered.forEach((c) => next.delete(c.name));
      else filtered.forEach((c) => next.add(c.name));
      return next;
    });
  };

  const applyBulk = () => {
    const names = profile.columns.filter((c) => selected.has(c.name)).map((c) => c.name);
    setColumns((prev) => assignRole(prev, names, bulkRole));
    setSelected(new Set());
  };

  return (
    <Card
      title="Column roles"
      desc={`${fmtInt(profile.n_cols)} columns · ${fmtInt(profile.n_rows)} respondents — suggested roles are prefilled`}
      flush
    >
      <div className="grid-toolbar">
        <input type="search" placeholder="Search columns…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search columns" />
        <select value={kind} onChange={(e) => setKind(e.target.value as ColumnKind | "all")} aria-label="Filter by kind">
          <option value="all">All kinds</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <div className="role-counts">
          <button aria-pressed={roleFilter === "all"} className={`role-pill${roleFilter === "all" ? " on" : ""}`} onClick={() => setRoleFilter("all")}>
            All {profile.n_cols}
          </button>
          {ROLE_OPTIONS.map((r) => (
            <button
              key={r.value}
              aria-pressed={roleFilter === r.value}
              className={`role-pill${roleFilter === r.value ? " on" : ""}`}
              onClick={() => setRoleFilter(roleFilter === r.value ? "all" : r.value)}
            >
              {r.short} {roleCounts[r.value] ?? 0}
            </button>
          ))}
        </div>
      </div>
      {selected.size > 0 && (
        <div className="bulkbar">
          <b>{selected.size}</b> selected
          <span className="muted">→ assign role</span>
          <select value={bulkRole} onChange={(e) => setBulkRole(e.target.value as ColumnRole)} aria-label="Bulk role">
            {ROLE_OPTIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <button className="btn sm primary" onClick={applyBulk}>
            Apply
          </button>
          <button className="btn sm ghost" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
          {bulkRole === "treatment" && selected.size > 1 && (
            <span className="small muted">Only the first selected column becomes the treatment.</span>
          )}
        </div>
      )}
      <div className="table-wrap tall">
        <table className="data">
          <thead>
            <tr>
              <th style={{ width: 32 }}>
                <input
                  type="checkbox"
                  checked={allFilteredSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = !allFilteredSelected && someFilteredSelected;
                  }}
                  onChange={toggleAll}
                  title={`Select all ${filtered.length} matching columns`}
                  aria-label="Select all visible"
                />
              </th>
              <th>Column</th>
              <th>Kind</th>
              <th className="num">Missing</th>
              <th className="num">Unique</th>
              <th>Values</th>
              <th>Role</th>
              <th title="Report lift by subgroup">Subgrp</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((c) => (
              <ColumnRow
                key={c.name}
                col={c}
                nRows={profile.n_rows}
                state={columns[c.name] ?? { role: "ignore", subgroup: false }}
                selected={selected.has(c.name)}
                onSelect={onSelect}
                onRole={onRole}
                onSubgroup={onSubgroup}
              />
            ))}
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={8}>
                  <Empty title="No columns match">Adjust the search or filters.</Empty>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="pager">
        <span>
          {filtered.length === 0
            ? "0 columns"
            : `${safePage * pageSize + 1}–${Math.min(filtered.length, (safePage + 1) * pageSize)} of ${filtered.length} columns`}
          {filtered.length !== profile.n_cols && ` (filtered from ${profile.n_cols})`}
        </span>
        <div className="row" style={{ gap: 6 }}>
          <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} aria-label="Rows per page" style={{ height: 28 }}>
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n} / page
              </option>
            ))}
          </select>
          <button className="btn sm" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
            ‹ Prev
          </button>
          <span>
            {safePage + 1} / {nPages}
          </span>
          <button className="btn sm" disabled={safePage >= nPages - 1} onClick={() => setPage(safePage + 1)}>
            Next ›
          </button>
        </div>
      </div>
    </Card>
  );
}

/* ======================================================================== */
/* Side panels                                                              */
/* ======================================================================== */

function TreatmentPanel({
  col,
  value,
  onChange,
}: {
  col: ColumnProfile | undefined;
  value: TreatmentState;
  onChange: (t: TreatmentState) => void;
}) {
  if (!col)
    return (
      <Card title="Treatment">
        <div className="muted">Set one column's role to <b>Treatment</b> — the column coding exposed vs control respondents.</div>
      </Card>
    );
  const exposed = new Set(value.exposed);
  const control = new Set(value.control);
  const toggleExposed = (k: string) => {
    const next = new Set(exposed);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    onChange({ ...value, exposed: [...next], control: value.control.filter((c) => !next.has(c)) });
  };
  const toggleControl = (k: string) => {
    const next = new Set(control);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    onChange({ ...value, control: [...next] });
  };
  const nExposed = col.top_values.filter((t) => exposed.has(valueKey(t.value))).reduce((a, t) => a + t.count, 0);
  const nControl = col.top_values
    .filter((t) => (value.controlMode === "rest" ? !exposed.has(valueKey(t.value)) : control.has(valueKey(t.value))))
    .reduce((a, t) => a + t.count, 0);
  return (
    <Card title="Treatment" desc={<>Column <b>{col.name}</b> · {col.n_unique} values</>}>
      <div className="stack" style={{ gap: 14 }}>
        <div>
          <div className="group-label exposed">Exposed · n≈{fmtInt(nExposed)}</div>
          <div className="chips">
            {col.top_values.map((t) => {
              const k = valueKey(t.value);
              return (
                <button key={k} type="button" aria-pressed={exposed.has(k)} className={`chip exposed${exposed.has(k) ? " on" : ""}`} onClick={() => toggleExposed(k)}>
                  <span className="chip-label">{fmtScalar(t.value)}</span>
                  <span className="n">{fmtInt(t.count)}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <div className="row between" style={{ marginBottom: 6 }}>
            <div className="group-label control" style={{ margin: 0 }}>
              Control · n≈{fmtInt(nControl)}
            </div>
            <Seg
              value={value.controlMode}
              onChange={(m) => onChange({ ...value, controlMode: m })}
              options={[
                { value: "rest", label: "All others" },
                { value: "explicit", label: "Choose" },
              ]}
            />
          </div>
          {value.controlMode === "rest" ? (
            <div className="small muted">Every other non-missing value is treated as control.</div>
          ) : (
            <div className="chips">
              {col.top_values.map((t) => {
                const k = valueKey(t.value);
                return (
                  <button
                    key={k}
                    type="button"
                    disabled={exposed.has(k)}
                    aria-pressed={control.has(k)}
                    className={`chip control${control.has(k) ? " on" : ""}`}
                    onClick={() => toggleControl(k)}
                  >
                    <span className="chip-label">{fmtScalar(t.value)}</span>
                    <span className="n">{fmtInt(t.count)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {col.n_unique > col.top_values.length && (
          <div className="small muted">Only the {col.top_values.length} most frequent values are shown.</div>
        )}
      </div>
    </Card>
  );
}

function OutcomesPanel({
  outcomes,
  byName,
  positives,
  onChange,
}: {
  outcomes: string[];
  byName: Map<string, ColumnProfile>;
  positives: Record<string, string[]>;
  onChange: (p: Record<string, string[]>) => void;
}) {
  if (!outcomes.length)
    return (
      <Card title="Outcomes">
        <div className="muted">Assign the <b>Outcome</b> role to brand KPIs (awareness, favourability, purchase intent…).</div>
      </Card>
    );
  const toggle = (name: string, k: string) => {
    const cur = new Set(positives[name] ?? []);
    if (cur.has(k)) cur.delete(k);
    else cur.add(k);
    onChange({ ...positives, [name]: [...cur] });
  };
  return (
    <Card title={`Outcomes (${outcomes.length})`} desc="Categorical outcomes need positive (top-box) levels; recoded to 1 / 0.">
      {outcomes.map((name) => {
        const col = byName.get(name);
        const required = needsPositiveLevels(col);
        const optional = !required && canRecode(col);
        const sel = new Set(positives[name] ?? []);
        return (
          <div className="outcome-item" key={name}>
            <div className="row between" style={{ marginBottom: required || optional ? 8 : 0 }}>
              <b className="truncate" style={{ maxWidth: 220 }} title={name}>
                {name}
              </b>
              <span className="row" style={{ gap: 6 }}>
                {col && <span className={`kind ${col.kind}`}>{col.kind}</span>}
                <span className="badge">
                  {sel.size > 0 || col?.kind === "binary" ? "proportion" : required ? "needs recode" : "mean"}
                </span>
              </span>
            </div>
            {(required || optional) && col && (
              <>
                {optional && <div className="small muted" style={{ marginBottom: 6 }}>Optional top-box recode:</div>}
                <div className="chips">
                  {col.top_values.map((t) => {
                    const k = valueKey(t.value);
                    return (
                      <button key={k} type="button" aria-pressed={sel.has(k)} className={`chip pos${sel.has(k) ? " on" : ""}`} onClick={() => toggle(name, k)}>
                        <span className="chip-label">{fmtScalar(t.value)}</span>
                        <span className="n">{fmtInt(t.count)}</span>
                      </button>
                    );
                  })}
                </div>
                {required && sel.size === 0 && (
                  <div className="small" style={{ color: "var(--danger)", marginTop: 6 }}>
                    Select at least one positive level.
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
    </Card>
  );
}

function NumField({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  help,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  help?: string;
  disabled?: boolean;
}) {
  const id = `f-${label.replace(/\W+/g, "-")}`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        value={Number.isFinite(value) ? value : ""}
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))}
      />
      {help && <span className="help">{help}</span>}
    </div>
  );
}

const ALL_METHODS: { value: Method; help: string }[] = [
  { value: "nn_matching", help: "Nearest-neighbour on logit PS" },
  { value: "ipw", help: "Inverse probability weights" },
  { value: "overlap_weights", help: "ATO, robust to poor overlap" },
  { value: "stratification", help: "PS quantile strata" },
];

function OptionsPanel({
  o,
  set,
  hasMatching,
}: {
  o: OptionsState;
  set: (patch: Partial<OptionsState>) => void;
  hasMatching: boolean;
}) {
  const toggleMethod = (m: Method) =>
    set({ methods: o.methods.includes(m) ? o.methods.filter((x) => x !== m) : [...o.methods, m] });
  const usesMatching = o.methods.includes("nn_matching");
  const usesWeights = o.methods.some((m) => m === "ipw" || m === "overlap_weights");
  return (
    <Card title="Analysis options">
      <div className="fields">
        <div className="field full">
          <label htmlFor="run-name">Run name</label>
          <input id="run-name" type="text" placeholder="e.g. Q3 campaign — wave 2" value={o.name} onChange={(e) => set({ name: e.target.value })} />
        </div>

        <div className="field full">
          <span className="field-label">Adjustment methods</span>
          <div className="stack" style={{ gap: 6 }}>
            {ALL_METHODS.map((m) => (
              <label key={m.value} className="check">
                <input type="checkbox" checked={o.methods.includes(m.value)} onChange={() => toggleMethod(m.value)} />
                <span>
                  {METHOD_LABELS[m.value]} <span className="small muted">— {m.help}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="field">
          <label htmlFor="model-type">PS model</label>
          <select id="model-type" value={o.model_type} onChange={(e) => set({ model_type: e.target.value as ModelType })}>
            <option value="logistic">Logistic regression</option>
            <option value="gradient_boosting">Gradient boosting</option>
            <option value="random_forest">Random forest</option>
          </select>
        </div>
        <div className="field">
          <span className="field-label">Estimand</span>
          <Seg<Estimand>
            value={o.estimand}
            onChange={(v) => set({ estimand: v })}
            options={[
              { value: "ATT", label: "ATT" },
              { value: "ATE", label: "ATE" },
            ]}
          />
        </div>

        <div className="field full">
          <label className="check">
            <input type="checkbox" checked={o.include_matching_in_model} onChange={(e) => set({ include_matching_in_model: e.target.checked })} />
            Include matching features in PS model
          </label>
          {!hasMatching && <span className="help">No matching features selected.</span>}
        </div>

        {usesMatching && (
          <>
            <div className="field">
              <label className="check field-label">
                <input type="checkbox" checked={o.useCaliper} onChange={(e) => set({ useCaliper: e.target.checked })} />
                Caliper (SD of logit PS)
              </label>
              <input type="number" step={0.05} min={0.01} value={o.useCaliper ? o.caliper : ""} disabled={!o.useCaliper} onChange={(e) => set({ caliper: Number(e.target.value) })} aria-label="Caliper" />
            </div>
            <NumField label="Match ratio (controls / exposed)" value={o.match_ratio} min={1} max={10} onChange={(v) => set({ match_ratio: v })} />
            <div className="field full">
              <label className="check">
                <input type="checkbox" checked={o.replacement} onChange={(e) => set({ replacement: e.target.checked })} />
                Match with replacement
              </label>
            </div>
          </>
        )}
        {usesWeights && (
          <div className="field">
            <label className="check field-label">
              <input type="checkbox" checked={o.useWeightClip} onChange={(e) => set({ useWeightClip: e.target.checked })} />
              Clip weights at quantile
            </label>
            <input type="number" step={0.005} min={0.5} max={1} value={o.useWeightClip ? o.weight_clip : ""} disabled={!o.useWeightClip} onChange={(e) => set({ weight_clip: Number(e.target.value) })} aria-label="Weight clip quantile" />
          </div>
        )}
        {o.methods.includes("stratification") && (
          <NumField label="Number of strata" value={o.n_strata} min={2} max={20} onChange={(v) => set({ n_strata: v })} />
        )}

        <div className="field">
          <label htmlFor="trim">Trim</label>
          <select id="trim" value={o.trim} onChange={(e) => set({ trim: e.target.value as TrimRule })}>
            <option value="none">None</option>
            <option value="common_support">Common support</option>
            <option value="crump">Crump (0.1 ≤ PS ≤ 0.9)</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="missing">Missing features</label>
          <select id="missing" value={o.missing_strategy} onChange={(e) => set({ missing_strategy: e.target.value as "impute" | "drop" })}>
            <option value="impute">Impute + indicator</option>
            <option value="drop">Drop rows</option>
          </select>
        </div>
        <NumField label="Bootstrap reps" value={o.n_bootstrap} min={0} max={2000} step={50} onChange={(v) => set({ n_bootstrap: v })} help="0 = analytic SEs" />
        <NumField label="Alpha" value={o.alpha} min={0.001} max={0.5} step={0.01} onChange={(v) => set({ alpha: v })} help={`${Math.round((1 - (o.alpha || 0)) * 100)}% CIs`} />
        <NumField label="Random seed" value={o.random_state} onChange={(v) => set({ random_state: v })} />
      </div>
    </Card>
  );
}

/* ======================================================================== */
/* Page                                                                     */
/* ======================================================================== */

function DatasetPicker() {
  const q = useQuery({ queryKey: ["datasets"], queryFn: listDatasets });
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Configure analysis</h1>
          <div className="sub">Choose a dataset to configure.</div>
        </div>
      </div>
      <Card flush>
        {q.isLoading ? (
          <Loading />
        ) : q.isError ? (
          <div className="card-body">
            <ErrorBox error={q.error} onRetry={() => q.refetch()} />
          </div>
        ) : !q.data?.length ? (
          <Empty title="No datasets uploaded" actions={<Link className="btn primary" to="/upload">Upload data</Link>} />
        ) : (
          <table className="data">
            <tbody>
              {q.data.map((d) => (
                <tr key={d.dataset_id}>
                  <td>
                    <b>{d.filename}</b> <span className="muted small">{d.sheet ?? ""}</span>
                  </td>
                  <td className="num muted">
                    {fmtInt(d.n_rows)} rows · {fmtInt(d.n_cols)} cols
                  </td>
                  <td className="num">
                    <Link className="btn sm primary" to={`/configure/${d.dataset_id}${d.sheet ? `?sheet=${encodeURIComponent(d.sheet)}` : ""}`}>
                      Configure
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Configurator({ profile }: { profile: DatasetProfile }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [state, setState] = useState<ConfigState>(() => initialConfigState(profile));
  const [showErrors, setShowErrors] = useState(false);

  const byName = useMemo(() => new Map(profile.columns.map((c) => [c.name, c])), [profile.columns]);

  const setColumns = useCallback(
    (fn: (prev: Record<string, ColumnState>) => Record<string, ColumnState>) =>
      setState((s) => {
        const next = fn(s.columns);
        const prevT = Object.keys(s.columns).find((n) => s.columns[n].role === "treatment");
        const nextT = Object.keys(next).find((n) => next[n].role === "treatment");
        const treatment = prevT !== nextT ? defaultTreatmentState(nextT ? byName.get(nextT) : undefined) : s.treatment;
        return { ...s, columns: next, treatment };
      }),
    [byName],
  );

  const treatmentName = columnsWithRole(state, "treatment")[0];
  const outcomes = profile.columns.filter((c) => state.columns[c.name]?.role === "outcome").map((c) => c.name);
  const nModel = columnsWithRole(state, "model", "model_matching").length;
  const nMatch = columnsWithRole(state, "matching", "model_matching").length;
  const nSub = buildAnalysisConfig(profile, state).subgroup_columns?.length ?? 0;

  const validation = useMemo(() => validateConfig(profile, state), [profile, state]);

  const submit = useMutation({
    mutationFn: () => submitAnalysis(buildAnalysisConfig(profile, state)),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["analyses"] });
      navigate(`/runs/${r.analysis_id}`);
    },
  });

  const onSubmit = () => {
    setShowErrors(true);
    if (validation.errors.length === 0) submit.mutate();
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Configure analysis</h1>
          <div className="sub">
            <b>{profile.filename}</b>
            {profile.sheet && <> · sheet “{profile.sheet}”</>} · {fmtInt(profile.n_rows)} respondents · {fmtInt(profile.n_cols)} columns
          </div>
        </div>
        <div className="page-actions">
          <button
            className="btn"
            onClick={() => {
              if (confirm("Reset all roles and options to the suggested defaults?")) setState(initialConfigState(profile));
            }}
          >
            Reset to suggestions
          </button>
          <Link className="btn" to="/upload">
            Change dataset
          </Link>
        </div>
      </div>

      <div className="split">
        <ColumnGrid profile={profile} columns={state.columns} setColumns={setColumns} />
        <div className="side-panels">
          <TreatmentPanel
            col={treatmentName ? byName.get(treatmentName) : undefined}
            value={state.treatment}
            onChange={(t) => setState((s) => ({ ...s, treatment: t }))}
          />
          <OutcomesPanel outcomes={outcomes} byName={byName} positives={state.positives} onChange={(p) => setState((s) => ({ ...s, positives: p }))} />
          <OptionsPanel
            o={state.options}
            set={(patch) => setState((s) => ({ ...s, options: { ...s.options, ...patch } }))}
            hasMatching={nMatch > 0}
          />
        </div>
      </div>

      <div className="submit-bar">
        <div className="summary">
          Treatment <b>{treatmentName ?? "—"}</b> · <b>{outcomes.length}</b> outcomes · <b>{nModel}</b> model · <b>{nMatch}</b> matching ·{" "}
          <b>{nSub}</b> subgroup columns · <b>{state.options.methods.length}</b> methods
        </div>
        <div className="spacer" />
        {validation.errors.length > 0 && !showErrors && (
          <span className="badge warn">{validation.errors.length} issue{validation.errors.length > 1 ? "s" : ""} to resolve</span>
        )}
        <button className="btn primary lg" onClick={onSubmit} disabled={submit.isPending || (showErrors && validation.errors.length > 0)}>
          {submit.isPending ? (
            <>
              <Spinner small /> Submitting…
            </>
          ) : (
            "Run analysis"
          )}
        </button>
        {(showErrors && validation.errors.length > 0) || validation.warnings.length > 0 || submit.isError ? (
          <div className="stack" style={{ width: "100%", gap: 8 }}>
            {showErrors && validation.errors.length > 0 && (
              <Callout kind="error" title="Fix these before running">
                <ul>
                  {validation.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </Callout>
            )}
            {validation.warnings.length > 0 && (
              <Callout kind="warn" title="Heads up">
                <ul>
                  {validation.warnings.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </Callout>
            )}
            {submit.isError && <ErrorBox title="The server rejected this configuration" error={submit.error} />}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function ConfigurePage() {
  const { datasetId } = useParams();
  const [params] = useSearchParams();
  const sheet = params.get("sheet");
  const q = useQuery({
    queryKey: ["dataset", datasetId, sheet ?? null],
    queryFn: () => getDataset(datasetId!, sheet),
    enabled: !!datasetId,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (datasetId) rememberDataset(datasetId, sheet);
  }, [datasetId, sheet]);

  if (!datasetId) return <DatasetPicker />;
  if (q.isLoading) return <Loading label="Loading dataset profile…" />;
  if (q.isError)
    return (
      <div className="stack">
        <ErrorBox title="Could not load dataset" error={q.error} onRetry={() => q.refetch()} />
        <div>
          <Link className="btn" to="/upload">
            Back to data
          </Link>
        </div>
      </div>
    );
  if (!q.data) return null;
  // key -> fresh state when dataset/sheet changes
  return <Configurator key={`${q.data.dataset_id}:${q.data.sheet ?? ""}`} profile={q.data} />;
}
