import { useMemo, useState } from "react";
import type { AnalysisResult, MethodResult } from "../../api/types";
import { ForestPlot } from "../../components/charts";
import { Card, Empty, SigBadge } from "../../components/ui";
import type { ForestRow } from "../../lib/chartData";
import { fmtCI, fmtInt, fmtLift, fmtOutcomeValue, fmtP, fmtRelLift } from "../../lib/format";
import { usePalette } from "../../lib/theme";
import { MethodPicker } from "./shared";

export default function SubgroupsTab({
  result,
  method,
  onMethod,
}: {
  result: AnalysisResult;
  method: MethodResult | undefined;
  onMethod: (m: string) => void;
}) {
  const pal = usePalette();
  const outcomes = useMemo(() => [...new Set((method?.subgroups ?? []).map((s) => s.outcome))], [method]);
  const columns = useMemo(() => [...new Set((method?.subgroups ?? []).map((s) => s.subgroup_column))], [method]);
  const [outcome, setOutcome] = useState<string>("");
  const [column, setColumn] = useState<string>("all");
  const o = outcomes.includes(outcome) ? outcome : outcomes[0] ?? "";

  if (!method) return <Empty title="No method results" />;
  if (!(result.config.subgroup_columns ?? []).length && !method.subgroups.length)
    return (
      <Card>
        <Empty title="No subgroups configured">Mark columns as subgroups on the Configure page to see lift split by segment.</Empty>
      </Card>
    );
  if (!method.subgroups.length)
    return (
      <Card actions={<MethodPicker methods={result.methods} value={method.method} onChange={onMethod} />} title="Subgroups">
        <Empty title="No subgroup estimates for this method" />
      </Card>
    );

  const sub = method.subgroups.filter((s) => s.outcome === o && (column === "all" || s.subgroup_column === column));
  const overall = method.contrasts.find((c) => c.outcome === o);
  const type = sub[0]?.outcome_type ?? overall?.outcome_type ?? "binary";
  const scale = type === "binary" ? 100 : 1;
  const alpha = result.config.alpha ?? 0.05;

  const rows: ForestRow[] = [];
  if (overall)
    rows.push(
      { key: "h:overall", label: "Overall", header: true },
      {
        key: "overall",
        label: "All respondents",
        est: overall.lift * scale,
        lo: overall.ci_low * scale,
        hi: overall.ci_high * scale,
        color: pal.methods[method.method],
        significant: overall.significant,
      },
    );
  for (const col of columns.filter((c) => column === "all" || c === column)) {
    const lv = sub.filter((s) => s.subgroup_column === col);
    if (!lv.length) continue;
    rows.push({ key: `h:${col}`, label: col, header: true });
    for (const s of lv)
      rows.push({
        key: `${col}:${s.subgroup_level}`,
        label: `${s.subgroup_level} (n=${fmtInt(s.n_exposed)}/${fmtInt(s.n_control)})`,
        est: s.lift * scale,
        lo: s.ci_low * scale,
        hi: s.ci_high * scale,
        color: pal.series[0],
        significant: s.significant,
      });
  }

  return (
    <div className="stack">
      <div className="row">
        <MethodPicker methods={result.methods} value={method.method} onChange={onMethod} />
        <div className="field" style={{ minWidth: 220 }}>
          <label htmlFor="sg-outcome">Outcome</label>
          <select id="sg-outcome" value={o} onChange={(e) => setOutcome(e.target.value)}>
            {outcomes.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </div>
        <div className="field" style={{ minWidth: 200 }}>
          <label htmlFor="sg-col">Subgroup column</label>
          <select id="sg-col" value={column} onChange={(e) => setColumn(e.target.value)}>
            <option value="all">All columns</option>
            {columns.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </div>
      </div>
      <Card title={`Lift by subgroup — ${o}`} desc="Filled points are significant. Small subgroups have wide intervals; treat as exploratory.">
        <ForestPlot rows={rows} palette={pal} unit={type === "binary" ? " pp" : ""} xLabel={type === "binary" ? "Absolute lift (pp)" : "Absolute lift"} labelWidth={260} />
      </Card>
      <Card title="Subgroup contrasts" flush>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Subgroup</th>
                <th>Level</th>
                <th className="num">n exp.</th>
                <th className="num">n ctl.</th>
                <th className="num">Exposed</th>
                <th className="num">Control adj.</th>
                <th className="num">Abs. lift</th>
                <th className="num">Rel. lift</th>
                <th className="num">CI</th>
                <th className="num">p</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sub.map((s) => (
                <tr key={`${s.subgroup_column}:${s.subgroup_level}`}>
                  <td className="muted">{s.subgroup_column}</td>
                  <td style={{ fontWeight: 600 }}>{s.subgroup_level}</td>
                  <td className="num">{fmtInt(s.n_exposed)}</td>
                  <td className="num">{fmtInt(s.n_control)}</td>
                  <td className="num">{fmtOutcomeValue(s.exposed_mean, s.outcome_type)}</td>
                  <td className="num">{fmtOutcomeValue(s.control_mean_adjusted, s.outcome_type)}</td>
                  <td className="num" style={{ fontWeight: 700 }}>
                    {fmtLift(s.lift, s.outcome_type)}
                  </td>
                  <td className="num">{fmtRelLift(s.relative_lift)}</td>
                  <td className="num small">{fmtCI(s.ci_low, s.ci_high, s.outcome_type)}</td>
                  <td className="num">{fmtP(s.p_value)}</td>
                  <td>
                    <SigBadge p={s.p_value} lift={s.lift} alpha={alpha} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
