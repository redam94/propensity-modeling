import { Fragment, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AnalysisResult, FeatureOverlap, FeatureRole, Quantiles, SupportRegion } from "../../api/types";
import { HistogramChart } from "../../components/charts";
import { Card, Empty, GroupLegend, Kpi, Seg } from "../../components/ui";
import { histBins } from "../../lib/chartData";
import { ROLE_LABELS, fmtInt, fmtNum, fmtPct, fmtPct100 } from "../../lib/format";
import { type Palette, usePalette } from "../../lib/theme";

const REGION_LABEL: Record<SupportRegion, string> = {
  control_only: "Control only (below support)",
  both: "Common support (overlap)",
  exposed_only: "Exposed only (above support)",
};

function MiniBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="mini-bar">
      <div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
    </div>
  );
}

function QuantileTable({ e, c }: { e: Quantiles; c: Quantiles }) {
  const keys: (keyof Quantiles)[] = ["min", "p05", "p25", "median", "mean", "p75", "p95", "max"];
  return (
    <table className="data">
      <thead>
        <tr>
          <th>PS</th>
          {keys.map((k) => (
            <th key={k} className="num">
              {k}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <span className="badge exposed">Exposed</span>
          </td>
          {keys.map((k) => (
            <td key={k} className="num">
              {fmtNum(e[k], 3)}
            </td>
          ))}
        </tr>
        <tr>
          <td>
            <span className="badge control">Control</span>
          </td>
          {keys.map((k) => (
            <td key={k} className="num">
              {fmtNum(c[k], 3)}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

function FeatureDrill({ f, pal }: { f: FeatureOverlap; pal: Palette }) {
  const data = f.levels.map((l) => ({ ...l, exp: l.pct_exposed, ctl: l.pct_control }));
  return (
    <div className="drill">
      <div className="row between" style={{ marginBottom: 8 }}>
        <div>
          <b>{f.feature}</b> <span className="muted small">· {f.kind} · OVL {fmtPct(f.overlap_coefficient)}</span>
        </div>
        <GroupLegend />
      </div>
      {f.histogram ? (
        <>
          <HistogramChart bins={histBins(f.histogram)} palette={pal} mirror={false} mode="density" height={260} xLabel={f.feature} />
          <div className="row small muted" style={{ gap: 18 }}>
            {f.exposed_range && (
              <span>
                Exposed range {fmtNum(f.exposed_range[0], 2)} – {fmtNum(f.exposed_range[1], 2)}
              </span>
            )}
            {f.control_range && (
              <span>
                Control range {fmtNum(f.control_range[0], 2)} – {fmtNum(f.control_range[1], 2)}
              </span>
            )}
          </div>
        </>
      ) : data.length ? (
        <div style={{ width: "100%", height: Math.max(220, Math.min(420, 60 + data.length * 18)) }}>
          <ResponsiveContainer>
            <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: data.length > 8 ? 60 : 20 }}>
              <CartesianGrid stroke={pal.grid} vertical={false} />
              <XAxis
                dataKey="level"
                tick={{ fill: pal.axis, fontSize: 11 }}
                interval={0}
                angle={data.length > 8 ? -35 : 0}
                textAnchor={data.length > 8 ? "end" : "middle"}
                height={data.length > 8 ? 70 : 30}
                stroke={pal.grid}
              />
              <YAxis tick={{ fill: pal.axis, fontSize: 11 }} tickFormatter={(v: number) => `${v}%`} stroke={pal.grid} />
              <Tooltip
                contentStyle={{ background: pal.tooltipBg, border: `1px solid ${pal.tooltipBorder}`, borderRadius: 6, fontSize: 12 }}
                labelStyle={{ color: pal.text, fontWeight: 600 }}
                formatter={(v: number, name: string) => [`${v.toFixed(1)}%`, name]}
                cursor={{ fill: pal.grid, opacity: 0.4 }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="exp" name="Exposed" fill={pal.exposed} radius={[3, 3, 0, 0]} />
              <Bar dataKey="ctl" name="Control" fill={pal.control} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="muted small">No distribution detail for this feature.</div>
      )}
      {(f.exposed_only_levels.length > 0 || f.control_only_levels.length > 0) && (
        <div className="grid-2" style={{ marginTop: 10 }}>
          <div>
            <div className="group-label exposed">Levels only among exposed</div>
            <div className="taglist">{f.exposed_only_levels.length ? f.exposed_only_levels.map((l) => <span key={l}>{l}</span>) : <span className="muted">none</span>}</div>
          </div>
          <div>
            <div className="group-label control">Levels only among control</div>
            <div className="taglist">{f.control_only_levels.length ? f.control_only_levels.map((l) => <span key={l}>{l}</span>) : <span className="muted">none</span>}</div>
          </div>
        </div>
      )}
    </div>
  );
}

type FSort = "ovl" | "feature" | "exp_unsup" | "ctl_unsup";

function FeatureOverlapTable({ features }: { features: FeatureOverlap[] }) {
  const pal = usePalette();
  const [sort, setSort] = useState<FSort>("ovl");
  const [asc, setAsc] = useState(true);
  const [role, setRole] = useState<FeatureRole | "all">("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    const f = features.filter((x) => (role === "all" || x.role === role || x.role === "both") && (!t || x.feature.toLowerCase().includes(t)));
    const key = (x: FeatureOverlap): number | string =>
      sort === "ovl" ? x.overlap_coefficient : sort === "feature" ? x.feature.toLowerCase() : sort === "exp_unsup" ? x.pct_exposed_unsupported : x.pct_control_unsupported;
    return [...f].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      const c = ka < kb ? -1 : ka > kb ? 1 : 0;
      return asc ? c : -c;
    });
  }, [features, sort, asc, role, q]);

  const th = (k: FSort, label: string, num = true) => (
    <th
      className={`sortable${num ? " num" : ""}`}
      onClick={() => {
        if (sort === k) setAsc(!asc);
        else {
          setSort(k);
          setAsc(k === "ovl" || k === "feature");
        }
      }}
      aria-sort={sort === k ? (asc ? "ascending" : "descending") : "none"}
    >
      {label} {sort === k ? (asc ? "▲" : "▼") : ""}
    </th>
  );

  return (
    <Card
      title="Feature over/underlap"
      desc="Raw-data distributional overlap per model / matching feature. Low OVL or unsupported respondents indicate underlap. Click a row to drill down."
      actions={
        <>
          <input type="search" placeholder="Filter features…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 180 }} aria-label="Filter features" />
          <Seg<FeatureRole | "all">
            value={role}
            onChange={setRole}
            options={[
              { value: "all", label: "All" },
              { value: "model", label: "Model" },
              { value: "matching", label: "Matching" },
            ]}
          />
        </>
      }
      flush
    >
      {!features.length ? (
        <Empty title="No feature overlap computed" />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                {th("feature", "Feature", false)}
                <th>Role</th>
                <th>Kind</th>
                {th("ovl", "OVL")}
                {th("exp_unsup", "Exposed unsupported")}
                {th("ctl_unsup", "Control unsupported")}
                <th>Exposed-only levels</th>
                <th>Control-only levels</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <Fragment key={f.feature}>
                  <tr className={`clickable${open === f.feature ? " selected" : ""}`} onClick={() => setOpen(open === f.feature ? null : f.feature)}>
                    <td style={{ fontWeight: 600 }}>
                      <span className="muted" style={{ display: "inline-block", width: 14 }}>
                        {open === f.feature ? "▾" : "▸"}
                      </span>
                      {f.feature}
                    </td>
                    <td className="small">{ROLE_LABELS[f.role] ?? f.role}</td>
                    <td>
                      <span className={`kind ${f.kind}`}>{f.kind}</span>
                    </td>
                    <td className="num">
                      <div className="region-cell" style={{ justifyContent: "flex-end" }}>
                        <MiniBar pct={f.overlap_coefficient * 100} color={f.overlap_coefficient < 0.7 ? pal.negative : f.overlap_coefficient < 0.85 ? "#d97706" : pal.positive} />
                        {fmtPct(f.overlap_coefficient)}
                      </div>
                    </td>
                    <td className="num" style={{ color: f.pct_exposed_unsupported > 5 ? "var(--danger)" : undefined }}>
                      {fmtPct100(f.pct_exposed_unsupported)}
                    </td>
                    <td className="num" style={{ color: f.pct_control_unsupported > 5 ? "var(--warning)" : undefined }}>
                      {fmtPct100(f.pct_control_unsupported)}
                    </td>
                    <td className="small truncate" style={{ maxWidth: 180 }} title={f.exposed_only_levels.join(", ")}>
                      {f.exposed_only_levels.length ? f.exposed_only_levels.join(", ") : <span className="muted">—</span>}
                    </td>
                    <td className="small truncate" style={{ maxWidth: 180 }} title={f.control_only_levels.join(", ")}>
                      {f.control_only_levels.length ? f.control_only_levels.join(", ") : <span className="muted">—</span>}
                    </td>
                  </tr>
                  {open === f.feature && (
                    <tr className="sub-row">
                      <td colSpan={8} style={{ padding: 0 }}>
                        <FeatureDrill f={f} pal={pal} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={8}>
                    <Empty title="No features match the filter" />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export default function OverlapTab({ result }: { result: AnalysisResult }) {
  const pal = usePalette();
  const o = result.overlap;
  const [mode, setMode] = useState<"density" | "count">("density");
  const bins = histBins(o.histogram);
  const both = o.regions.find((r) => r.region === "both");
  const trim = result.config.trim ?? "none";
  return (
    <div className="stack">
      <div className="kpis">
        <Kpi label="PS overlap (OVL)" value={fmtPct(o.overlap_coefficient)} hint={o.overlap_coefficient >= 0.8 ? "Good overlap" : o.overlap_coefficient >= 0.6 ? "Moderate overlap" : "Poor overlap"} />
        <Kpi label="Common support" value={`${fmtNum(o.common_support_lower, 3)} – ${fmtNum(o.common_support_upper, 3)}`} hint="Propensity score range" />
        <Kpi tone="exposed" label="Exposed in support" value={both ? fmtPct100(both.pct_exposed) : "—"} hint={both ? `${fmtInt(both.n_exposed)} respondents` : undefined} />
        <Kpi tone="control" label="Control in support" value={both ? fmtPct100(both.pct_control) : "—"} hint={both ? `${fmtInt(both.n_control)} respondents` : undefined} />
        <Kpi
          label="Trimmed"
          value={`${fmtInt(o.n_trimmed_exposed)} / ${fmtInt(o.n_trimmed_control)}`}
          hint={trim === "none" ? "No trimming rule" : `exposed / control · rule: ${trim.replace("_", " ")}`}
        />
      </div>

      <Card
        title="Propensity score distribution"
        desc="Exposed above the axis, control below. Shaded band = common support; outside it one group has no comparable counterparts (underlap)."
        actions={
          <Seg
            value={mode}
            onChange={setMode}
            options={[
              { value: "density", label: "Density" },
              { value: "count", label: "Counts" },
            ]}
          />
        }
      >
        <HistogramChart
          bins={bins}
          palette={pal}
          mode={mode}
          mirror
          density={o.density}
          support={[o.common_support_lower, o.common_support_upper]}
          height={380}
        />
      </Card>

      <div className="grid-2">
        <Card title="Support regions" flush>
          <table className="data">
            <thead>
              <tr>
                <th>Region</th>
                <th className="num">PS range</th>
                <th className="num">Exposed</th>
                <th className="num">Control</th>
              </tr>
            </thead>
            <tbody>
              {o.regions.map((r) => (
                <tr key={r.region}>
                  <td>
                    <b>{REGION_LABEL[r.region]}</b>
                  </td>
                  <td className="num small muted">
                    {fmtNum(r.lower, 3)} – {fmtNum(r.upper, 3)}
                  </td>
                  <td className="num">
                    <div className="region-cell" style={{ justifyContent: "flex-end" }}>
                      <MiniBar pct={r.pct_exposed} color={pal.exposed} />
                      <span>
                        {fmtInt(r.n_exposed)} <span className="muted small">({fmtPct100(r.pct_exposed)})</span>
                      </span>
                    </div>
                  </td>
                  <td className="num">
                    <div className="region-cell" style={{ justifyContent: "flex-end" }}>
                      <MiniBar pct={r.pct_control} color={pal.control} />
                      <span>
                        {fmtInt(r.n_control)} <span className="muted small">({fmtPct100(r.pct_control)})</span>
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title="Propensity score quantiles" flush>
          <div className="table-wrap auto">
            <QuantileTable e={o.exposed_quantiles} c={o.control_quantiles} />
          </div>
        </Card>
      </div>

      <FeatureOverlapTable features={result.feature_overlap} />
    </div>
  );
}
