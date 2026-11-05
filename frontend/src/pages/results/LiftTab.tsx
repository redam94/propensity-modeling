import type { AnalysisResult, MethodResult, OutcomeType } from "../../api/types";
import { ForestPlot } from "../../components/charts";
import { Callout, Card, Empty, SigBadge } from "../../components/ui";
import { compareMethodsRows, outcomeTypes } from "../../lib/chartData";
import {
  fmtCI,
  fmtInt,
  fmtLift,
  fmtNum,
  fmtOutcomeValue,
  fmtP,
  fmtRelLift,
} from "../../lib/format";
import { usePalette } from "../../lib/theme";
import { MethodInfo, MethodPicker } from "./shared";

export function ContrastTable({ method, alpha }: { method: MethodResult; alpha: number }) {
  if (!method.contrasts.length) return <Empty title="No contrasts">This method produced no outcome contrasts.</Empty>;
  return (
    <div className="table-wrap auto">
      <table className="data">
        <thead>
          <tr>
            <th>Outcome</th>
            <th className="num">n exp.</th>
            <th className="num">n ctl. (eff.)</th>
            <th className="num group-sep" style={{ color: "var(--exposed)" }}>
              Exposed
            </th>
            <th className="num" style={{ color: "var(--control)" }}>
              Control raw
            </th>
            <th className="num" style={{ color: "var(--control)" }}>
              Control adj.
            </th>
            <th className="num group-sep">Raw diff</th>
            <th className="num">Abs. lift</th>
            <th className="num">Rel. lift</th>
            <th className="num">{Math.round((1 - alpha) * 100)}% CI</th>
            <th className="num">p</th>
            <th>Significance</th>
          </tr>
        </thead>
        <tbody>
          {method.contrasts.map((c) => (
            <tr key={c.outcome}>
              <td>
                <div style={{ fontWeight: 600 }} className="truncate" title={c.outcome}>
                  {c.outcome}
                </div>
                <div className="small muted">
                  {c.outcome_type === "binary" ? "proportion" : "mean"} · {c.ci_method} CI
                </div>
              </td>
              <td className="num">{fmtInt(c.n_exposed)}</td>
              <td className="num">
                {fmtInt(c.n_control)} <span className="muted small">({fmtNum(c.effective_n_control, 0)})</span>
              </td>
              <td className="num group-sep" style={{ fontWeight: 600 }}>
                {fmtOutcomeValue(c.exposed_mean, c.outcome_type)}
              </td>
              <td className="num muted">{fmtOutcomeValue(c.control_mean_raw, c.outcome_type)}</td>
              <td className="num" style={{ fontWeight: 600 }}>
                {fmtOutcomeValue(c.control_mean_adjusted, c.outcome_type)}
              </td>
              <td className="num group-sep muted">{fmtLift(c.raw_diff, c.outcome_type)}</td>
              <td
                className="num"
                style={{ fontWeight: 700, color: c.significant ? (c.lift >= 0 ? "var(--success)" : "var(--danger)") : undefined }}
              >
                {fmtLift(c.lift, c.outcome_type)}
              </td>
              <td className="num">{fmtRelLift(c.relative_lift)}</td>
              <td className="num small">{fmtCI(c.ci_low, c.ci_high, c.outcome_type)}</td>
              <td className="num">{fmtP(c.p_value)}</td>
              <td>
                <SigBadge p={c.p_value} lift={c.lift} alpha={alpha} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CompareMethods({ result }: { result: AnalysisResult }) {
  const pal = usePalette();
  const types = new Set(outcomeTypes(result.methods).values());
  const order: OutcomeType[] = ["binary", "continuous"];
  return (
    <Card
      title="Compare methods"
      desc="Adjusted lift per outcome with confidence intervals; ◇ = unadjusted raw difference. Filled dots are significant."
      actions={
        <div className="legend">
          {result.methods.map((m) => (
            <span key={m.method}>
              <i style={{ background: pal.methods[m.method], borderRadius: "50%" }} />
              {m.label || m.method}
            </span>
          ))}
          <span>
            <i style={{ background: "transparent", border: `2px solid ${pal.raw}`, transform: "rotate(45deg)", borderRadius: 1 }} />
            Raw difference
          </span>
        </div>
      }
    >
      <div className="stack" style={{ gap: 24 }}>
        {order
          .filter((t) => types.has(t))
          .map((t) => (
            <div key={t}>
              {types.size > 1 && <h4 style={{ marginBottom: 6 }}>{t === "binary" ? "Proportion outcomes" : "Continuous outcomes"}</h4>}
              <ForestPlot
                rows={compareMethodsRows(result.methods, t, pal.methods, pal.raw)}
                palette={pal}
                unit={t === "binary" ? " pp" : ""}
                xLabel={t === "binary" ? "Absolute lift (percentage points)" : "Absolute lift (difference in means)"}
              />
            </div>
          ))}
      </div>
    </Card>
  );
}

export default function LiftTab({
  result,
  method,
  onMethod,
}: {
  result: AnalysisResult;
  method: MethodResult | undefined;
  onMethod: (m: string) => void;
}) {
  if (!method) return <Empty title="No method results">The analysis produced no method results.</Empty>;
  const alpha = result.config.alpha ?? 0.05;
  const nSig = method.contrasts.filter((c) => c.significant).length;
  return (
    <div className="stack">
      <Card
        title="Outcome contrasts"
        desc={
          <>
            {method.label} · estimand {method.method === "overlap_weights" ? "ATO" : method.estimand} · {nSig} of {method.contrasts.length}{" "}
            outcomes significant at α = {alpha}
          </>
        }
        actions={<MethodPicker methods={result.methods} value={method.method} onChange={onMethod} />}
        flush
        footer={<MethodInfo method={method} />}
      >
        <ContrastTable method={method} alpha={alpha} />
      </Card>
      {method.warnings.length > 0 && (
        <Callout kind="warn" title={`${method.label} warnings`}>
          <ul>
            {method.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Callout>
      )}
      <CompareMethods result={result} />
    </div>
  );
}
