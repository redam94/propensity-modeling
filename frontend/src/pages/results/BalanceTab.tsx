import { useMemo, useState } from "react";
import type { AnalysisResult, FeatureRole, MethodResult } from "../../api/types";
import { HistogramChart, LovePlot } from "../../components/charts";
import { Card, Empty, GroupLegend, Kpi, Seg } from "../../components/ui";
import { type BalanceSort, histBins, loveRows } from "../../lib/chartData";
import { ROLE_LABELS, fmtInt, fmtNum } from "../../lib/format";
import { usePalette } from "../../lib/theme";
import { MethodPicker } from "./shared";

const smdStyle = (v: number) => (Math.abs(v) > 0.1 ? { color: "var(--danger)", fontWeight: 600 } : undefined);

export default function BalanceTab({
  result,
  method,
  onMethod,
}: {
  result: AnalysisResult;
  method: MethodResult | undefined;
  onMethod: (m: string) => void;
}) {
  const pal = usePalette();
  const [role, setRole] = useState<FeatureRole | "all">("all");
  const [sort, setSort] = useState<BalanceSort>("before");
  const rows = useMemo(() => (method ? loveRows(method.balance, role, sort) : []), [method, role, sort]);
  if (!method) return <Empty title="No method results" />;
  const s = method.balance_summary;
  const hasMatching = method.balance.some((r) => r.role !== "model");

  return (
    <div className="stack">
      <div className="row between">
        <MethodPicker methods={result.methods} value={method.method} onChange={onMethod} />
        <span className="muted small">{method.label}</span>
      </div>
      <div className="kpis">
        <Kpi label="Max |SMD| before" value={fmtNum(s.max_abs_smd_before, 3)} />
        <Kpi label="Max |SMD| after" value={<span style={smdStyle(s.max_abs_smd_after)}>{fmtNum(s.max_abs_smd_after, 3)}</span>} />
        <Kpi label="Mean |SMD|" value={`${fmtNum(s.mean_abs_smd_before, 3)} → ${fmtNum(s.mean_abs_smd_after, 3)}`} />
        <Kpi
          label="Imbalanced (|SMD| > 0.1)"
          value={`${fmtInt(s.n_imbalanced_before)} → ${fmtInt(s.n_imbalanced_after)}`}
          hint={`of ${fmtInt(method.balance.length)} variables`}
        />
      </div>

      <Card
        title="Love plot"
        desc="Absolute standardized mean differences before (hollow) and after (filled) adjustment. Dashed line = 0.1 threshold."
        actions={
          <>
            {hasMatching && (
              <Seg<FeatureRole | "all">
                value={role}
                onChange={setRole}
                options={[
                  { value: "all", label: "All" },
                  { value: "model", label: "Model" },
                  { value: "matching", label: "Matching" },
                ]}
              />
            )}
            <Seg<BalanceSort>
              value={sort}
              onChange={setSort}
              options={[
                { value: "before", label: "Sort: before" },
                { value: "after", label: "after" },
                { value: "name", label: "name" },
              ]}
            />
          </>
        }
      >
        <div className="legend" style={{ marginBottom: 8 }}>
          <span>
            <i style={{ background: "transparent", border: `2px solid ${pal.before}`, borderRadius: "50%" }} />
            Before
          </span>
          <span>
            <i style={{ background: pal.after, borderRadius: "50%" }} />
            After
          </span>
          <span>
            <i style={{ background: pal.threshold, height: 2 }} />
            0.1 threshold
          </span>
        </div>
        <div style={{ maxHeight: 620, overflowY: "auto" }}>
          <LovePlot rows={rows} palette={pal} />
        </div>
      </Card>

      <Card
        title="Propensity score: before vs after adjustment"
        desc="After matching / weighting the two distributions should coincide."
        actions={<GroupLegend />}
      >
        {method.adjusted_ps_histogram ? (
          <div className="grid-2">
            <div>
              <h4 className="muted" style={{ marginBottom: 4 }}>
                Before
              </h4>
              <HistogramChart bins={histBins(result.overlap.histogram)} palette={pal} mirror height={280} />
            </div>
            <div>
              <h4 className="muted" style={{ marginBottom: 4 }}>
                After ({method.label})
              </h4>
              <HistogramChart bins={histBins(method.adjusted_ps_histogram)} palette={pal} mirror height={280} />
            </div>
          </div>
        ) : (
          <Empty title="No adjusted PS histogram">This method did not report an adjusted distribution.</Empty>
        )}
      </Card>

      <Card title="Balance table" desc={`${rows.length} variables`} flush>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Variable</th>
                <th>Source</th>
                <th>Role</th>
                <th className="num group-sep">Exp. mean</th>
                <th className="num">Ctl. mean</th>
                <th className="num">SMD</th>
                <th className="num">Var ratio</th>
                <th className="num group-sep">Exp. mean (adj)</th>
                <th className="num">Ctl. mean (adj)</th>
                <th className="num">SMD (adj)</th>
                <th className="num">Var ratio (adj)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.variable}>
                  <td style={{ fontWeight: 550 }}>{r.variable}</td>
                  <td className="muted small">{r.source_feature}</td>
                  <td className="small">{ROLE_LABELS[r.role] ?? r.role}</td>
                  <td className="num group-sep">{fmtNum(r.mean_exposed_before, 3)}</td>
                  <td className="num">{fmtNum(r.mean_control_before, 3)}</td>
                  <td className="num" style={smdStyle(r.smd_before)}>
                    {fmtNum(r.smd_before, 3)}
                  </td>
                  <td className="num">{fmtNum(r.var_ratio_before, 2)}</td>
                  <td className="num group-sep">{fmtNum(r.mean_exposed_after, 3)}</td>
                  <td className="num">{fmtNum(r.mean_control_after, 3)}</td>
                  <td className="num" style={smdStyle(r.smd_after)}>
                    {fmtNum(r.smd_after, 3)}
                  </td>
                  <td className="num">{fmtNum(r.var_ratio_after, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
