import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import type { AnalysisResult } from "../../api/types";
import { Card, Empty, Kpi } from "../../components/ui";
import { fmtInt, fmtNum, fmtPct, titleCase } from "../../lib/format";
import { usePalette } from "../../lib/theme";

export default function ModelTab({ result }: { result: AnalysisResult }) {
  const pal = usePalette();
  const m = result.model;
  const imp = [...m.feature_importance].sort((a, b) => b.importance - a.importance).slice(0, 30);
  const cal = m.calibration
    .filter((r) => r.length >= 2)
    .map((r) => ({ pred: r[0], obs: r[1], n: r[2] ?? 0 }));
  const diag = [
    { pred: 0, diag: 0 },
    { pred: 1, diag: 1 },
  ];
  const auc = m.auc;
  const aucHint =
    auc >= 0.8
      ? "High separability — check overlap carefully"
      : auc >= 0.6
        ? "Moderate — groups differ on covariates"
        : "Low — groups look similar on covariates";
  const tooltipStyle = { background: pal.tooltipBg, border: `1px solid ${pal.tooltipBorder}`, borderRadius: 6, fontSize: 12 };

  return (
    <div className="stack">
      <div className="kpis">
        <Kpi label="AUC" value={fmtNum(auc, 3)} hint={aucHint} />
        <Kpi label="Model" value={<span style={{ fontSize: 17 }}>{titleCase(m.model_type)}</span>} />
        <Kpi label="Encoded features" value={fmtInt(m.n_encoded_features)} hint={`from ${fmtInt(m.feature_importance.length)} source columns`} />
      </div>
      <div className="grid-2">
        <Card title="Feature importance" desc={`Top ${imp.length} source columns (normalised to sum 100%)`}>
          {imp.length ? (
            <div style={{ width: "100%", height: Math.max(240, imp.length * 22 + 40) }}>
              <ResponsiveContainer>
                <BarChart data={imp} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 4 }}>
                  <CartesianGrid stroke={pal.grid} horizontal={false} />
                  <XAxis type="number" tickFormatter={(v: number) => `${Math.round(v * 100)}%`} tick={{ fill: pal.axis, fontSize: 11 }} stroke={pal.grid} />
                  <YAxis
                    type="category"
                    dataKey="feature"
                    width={160}
                    tick={{ fill: pal.text, fontSize: 11.5 }}
                    stroke={pal.grid}
                    tickFormatter={(s: string) => (s.length > 24 ? s.slice(0, 23) + "…" : s)}
                    interval={0}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    labelStyle={{ color: pal.text, fontWeight: 600 }}
                    formatter={(v: number) => [fmtPct(v), "Importance"]}
                    cursor={{ fill: pal.grid, opacity: 0.4 }}
                  />
                  <Bar dataKey="importance" fill={pal.series[0]} radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <Empty title="No importance data" />
          )}
        </Card>
        <Card title="Calibration" desc="Observed exposure rate vs mean predicted PS by decile (point size = n).">
          {cal.length ? (
            <div className="chart-box">
              <ResponsiveContainer>
                <ComposedChart margin={{ top: 8, right: 20, left: 0, bottom: 20 }}>
                  <CartesianGrid stroke={pal.grid} />
                  <XAxis
                    type="number"
                    dataKey="pred"
                    domain={[0, 1]}
                    tickFormatter={(v: number) => v.toFixed(1)}
                    tick={{ fill: pal.axis, fontSize: 11 }}
                    stroke={pal.grid}
                    label={{ value: "Mean predicted PS", position: "insideBottom", offset: -10, fill: pal.muted, fontSize: 12 }}
                  />
                  <YAxis
                    type="number"
                    dataKey="obs"
                    domain={[0, 1]}
                    tickFormatter={(v: number) => v.toFixed(1)}
                    tick={{ fill: pal.axis, fontSize: 11 }}
                    stroke={pal.grid}
                    label={{ value: "Observed rate", angle: -90, position: "insideLeft", offset: 14, fill: pal.muted, fontSize: 12 }}
                  />
                  <ZAxis type="number" dataKey="n" range={[40, 220]} />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(v: number, name: string) => [name === "n" ? fmtInt(v) : fmtNum(v, 3), name === "pred" ? "Predicted" : name === "obs" ? "Observed" : name]}
                  />
                  <Line data={diag} dataKey="diag" stroke={pal.muted} strokeDasharray="5 4" dot={false} isAnimationActive={false} legendType="none" />
                  <Scatter data={cal} fill={pal.series[1]} line={{ stroke: pal.series[1], strokeWidth: 1.5 }} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <Empty title="No calibration data" />
          )}
        </Card>
      </div>
    </div>
  );
}
