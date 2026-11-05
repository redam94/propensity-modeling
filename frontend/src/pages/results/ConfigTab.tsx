import type { ReactNode } from "react";
import type { AnalysisConfig } from "../../api/types";
import { Card } from "../../components/ui";
import { METHOD_LABELS, fmtScalar, titleCase } from "../../lib/format";

function Tags({ items }: { items: (string | number | boolean)[] | null | undefined }) {
  if (!items || !items.length) return <span className="muted">—</span>;
  return (
    <div className="taglist">
      {items.map((x) => (
        <span key={String(x)}>{fmtScalar(x)}</span>
      ))}
    </div>
  );
}

function KV({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function ConfigTab({ config }: { config: AnalysisConfig }) {
  const pos = Object.entries(config.outcome_positive_values ?? {});
  return (
    <div className="grid-2">
      <Card title="Data & groups">
        <KV
          rows={[
            ["Run name", config.name || <span className="muted">—</span>],
            ["Dataset", <span className="mono">{config.dataset_id}</span>],
            ["Sheet", config.sheet ?? "—"],
            ["Treatment column", <b>{config.treatment_column}</b>],
            ["Exposed values", <Tags items={config.exposed_values} />],
            ["Control values", config.control_values ? <Tags items={config.control_values} /> : <span className="muted">All other values</span>],
          ]}
        />
      </Card>
      <Card title="Estimation">
        <KV
          rows={[
            ["Methods", (config.methods ?? []).map((m) => METHOD_LABELS[m]).join(", ")],
            ["PS model", titleCase(config.model_type ?? "logistic")],
            ["Estimand", config.estimand ?? "ATT"],
            ["Caliper", config.caliper == null ? "none" : `${config.caliper} SD (logit PS)`],
            ["Match ratio", `1:${config.match_ratio ?? 1}${config.replacement ? " with replacement" : " without replacement"}`],
            ["Weight clip", config.weight_clip == null ? "none" : `q${config.weight_clip}`],
            ["Strata", String(config.n_strata ?? 5)],
            ["Trim", titleCase(config.trim ?? "none")],
            ["Missing features", titleCase(config.missing_strategy ?? "impute")],
            ["Bootstrap", config.n_bootstrap ? `${config.n_bootstrap} replicates` : "analytic SEs"],
            ["Alpha", String(config.alpha ?? 0.05)],
            ["Random seed", String(config.random_state ?? 42)],
            ["Matching in model", config.include_matching_in_model === false ? "no" : "yes"],
          ]}
        />
      </Card>
      <Card title={`Outcomes (${config.outcome_columns.length})`}>
        <Tags items={config.outcome_columns} />
        {pos.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div className="field-label" style={{ marginBottom: 6 }}>
              Top-box recodes
            </div>
            <KV rows={pos.map(([k, v]) => [k, <Tags items={v} />])} />
          </div>
        )}
      </Card>
      <Card title="Features">
        <KV
          rows={[
            [`Model (${config.model_features?.length ?? 0})`, <Tags items={config.model_features} />],
            [`Matching (${config.matching_features?.length ?? 0})`, <Tags items={config.matching_features} />],
            [`Subgroups (${config.subgroup_columns?.length ?? 0})`, <Tags items={config.subgroup_columns} />],
          ]}
        />
      </Card>
    </div>
  );
}
