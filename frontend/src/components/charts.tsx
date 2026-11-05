/**
 * Lightweight custom SVG charts for statistical displays that recharts
 * does not express well (mirrored histograms, forest plots, love plots).
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { BalanceRow, DensityCurve } from "../api/types";
import { type Bin, type ForestRow, linear, niceDomain, niceTicks } from "../lib/chartData";
import type { Palette } from "../lib/theme";

export function useWidth<T extends HTMLElement>(fixed?: number): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fixed ?? 0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || fixed != null) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(Math.floor(e.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fixed]);
  return [ref, w];
}

function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const left = x > width - 200 ? x - 190 : x + 14;
  return (
    <div className="chart-tooltip" style={{ position: "absolute", left, top: Math.max(0, y - 10), pointerEvents: "none", zIndex: 10 }}>
      {children}
    </div>
  );
}

const fmtTick = (v: number) => {
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (a >= 10) return v.toFixed(0);
  if (a >= 1) return v.toFixed(1).replace(/\.0$/, "");
  return v.toFixed(2).replace(/0$/, "");
};

/* ======================================================================== */
/* Histogram: mirrored (exposed up / control down) or overlaid             */
/* ======================================================================== */

export function HistogramChart({
  bins,
  palette,
  mode = "density",
  mirror = true,
  density,
  support,
  height = 340,
  xLabel = "Propensity score",
  xFormat = fmtTick,
  domain,
  fixedWidth,
}: {
  bins: Bin[];
  palette: Palette;
  mode?: "density" | "count";
  mirror?: boolean;
  density?: DensityCurve | null;
  support?: [number, number] | null;
  height?: number;
  xLabel?: string;
  xFormat?: (v: number) => string;
  domain?: [number, number];
  fixedWidth?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(fixedWidth);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  if (!bins.length) return <div className="empty small">No distribution data.</div>;

  const m = { l: 52, r: 16, t: 14, b: 40 };
  const iw = Math.max(10, width - m.l - m.r);
  const ih = height - m.t - m.b;
  const xd: [number, number] = domain ?? [bins[0].lo, bins[bins.length - 1].hi];
  const x = linear(xd, [m.l, m.l + iw]);
  const val = (b: Bin, g: "e" | "c") => (mode === "density" ? (g === "e" ? b.expDens : b.ctlDens) : g === "e" ? b.expCount : b.ctlCount);
  let ymax = Math.max(...bins.map((b) => Math.max(val(b, "e"), val(b, "c"))));
  if (mode === "density" && density) ymax = Math.max(ymax, ...density.exposed, ...density.control);
  if (!(ymax > 0)) ymax = 1;
  const yTicks = niceTicks(0, ymax, mirror ? 3 : 5);
  const yTop = Math.max(ymax, yTicks[yTicks.length - 1] ?? ymax);
  const baseY = mirror ? m.t + ih / 2 : m.t + ih;
  const half = mirror ? ih / 2 : ih;
  const yUp = (v: number) => baseY - (v / yTop) * half;
  const yDown = (v: number) => baseY + (v / yTop) * half;
  const xTicks = niceTicks(xd[0], xd[1], Math.max(3, Math.floor(iw / 80)));

  const line = (xs: number[], ys: number[], dir: "up" | "down") =>
    xs
      .map((xv, i) => {
        if (xv < xd[0] || xv > xd[1]) return null;
        return `${x(xv).toFixed(1)},${(dir === "up" ? yUp(ys[i]) : yDown(ys[i])).toFixed(1)}`;
      })
      .filter(Boolean)
      .join(" ");

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    const v = xd[0] + ((px - m.l) / iw) * (xd[1] - xd[0]);
    const i = bins.findIndex((b) => v >= b.lo && v <= b.hi);
    if (i >= 0) setHover({ i, x: px, y: e.clientY - rect.top });
    else setHover(null);
  };

  const hb = hover ? bins[hover.i] : null;
  return (
    <div ref={ref} style={{ position: "relative", width: "100%" }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`${mirror ? "Mirrored" : "Overlaid"} histogram of ${xLabel}`}>
          {support && (
            <g>
              <rect
                x={x(Math.max(support[0], xd[0]))}
                y={m.t}
                width={Math.max(0, x(Math.min(support[1], xd[1])) - x(Math.max(support[0], xd[0])))}
                height={ih}
                fill={palette.support}
              />
              {[support[0], support[1]].map((s, i) => (
                <line key={i} x1={x(s)} x2={x(s)} y1={m.t} y2={m.t + ih} stroke={palette.positive} strokeDasharray="4 3" strokeWidth={1} opacity={0.7} />
              ))}
            </g>
          )}
          {/* y grid */}
          {yTicks.map((t) => (
            <g key={`u${t}`}>
              <line x1={m.l} x2={m.l + iw} y1={yUp(t)} y2={yUp(t)} stroke={palette.grid} />
              <text x={m.l - 6} y={yUp(t)} dy="0.32em" textAnchor="end" fontSize={11} fill={palette.axis}>
                {fmtTick(t)}
              </text>
              {mirror && t > 0 && (
                <>
                  <line x1={m.l} x2={m.l + iw} y1={yDown(t)} y2={yDown(t)} stroke={palette.grid} />
                  <text x={m.l - 6} y={yDown(t)} dy="0.32em" textAnchor="end" fontSize={11} fill={palette.axis}>
                    {fmtTick(t)}
                  </text>
                </>
              )}
            </g>
          ))}
          {/* bars */}
          {bins.map((b, i) => {
            const x0 = x(b.lo) + 0.5;
            const w = Math.max(0.5, x(b.hi) - x(b.lo) - 1);
            const ve = val(b, "e");
            const vc = val(b, "c");
            const on = hover?.i === i;
            return (
              <g key={i} opacity={hover && !on ? 0.75 : 1}>
                <rect x={x0} y={yUp(ve)} width={w} height={Math.max(0, baseY - yUp(ve))} fill={palette.exposed} fillOpacity={mirror ? 0.75 : 0.5} />
                {mirror ? (
                  <rect x={x0} y={baseY} width={w} height={Math.max(0, yDown(vc) - baseY)} fill={palette.control} fillOpacity={0.75} />
                ) : (
                  <rect x={x0} y={yUp(vc)} width={w} height={Math.max(0, baseY - yUp(vc))} fill={palette.control} fillOpacity={0.5} />
                )}
              </g>
            );
          })}
          {/* density */}
          {mode === "density" && density && density.x.length > 1 && (
            <g fill="none" strokeWidth={2}>
              <polyline points={line(density.x, density.exposed, "up")} stroke={palette.exposed} />
              <polyline points={line(density.x, density.control, mirror ? "down" : "up")} stroke={palette.control} strokeDasharray={mirror ? undefined : "5 3"} />
            </g>
          )}
          {/* baseline + x axis */}
          <line x1={m.l} x2={m.l + iw} y1={baseY} y2={baseY} stroke={palette.axis} />
          {xTicks.map((t) => (
            <g key={`x${t}`}>
              <line x1={x(t)} x2={x(t)} y1={m.t + ih} y2={m.t + ih + 4} stroke={palette.axis} />
              <text x={x(t)} y={m.t + ih + 16} textAnchor="middle" fontSize={11} fill={palette.axis}>
                {xFormat(t)}
              </text>
            </g>
          ))}
          <text x={m.l + iw / 2} y={height - 4} textAnchor="middle" fontSize={12} fill={palette.muted}>
            {xLabel}
          </text>
          <text transform={`translate(12 ${m.t + ih / 2}) rotate(-90)`} textAnchor="middle" fontSize={12} fill={palette.muted}>
            {mode === "density" ? "Density" : "Respondents"}
          </text>
          {mirror && (
            <>
              <text x={m.l + 8} y={m.t + 12} fontSize={11.5} fontWeight={600} fill={palette.exposed}>
                ▲ Exposed
              </text>
              <text x={m.l + 8} y={m.t + ih - 4} fontSize={11.5} fontWeight={600} fill={palette.control}>
                ▼ Control
              </text>
            </>
          )}
          {hb && hover && (
            <rect x={x(hb.lo)} y={m.t} width={Math.max(1, x(hb.hi) - x(hb.lo))} height={ih} fill={palette.text} opacity={0.06} pointerEvents="none" />
          )}
          <rect x={m.l} y={m.t} width={iw} height={ih} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        </svg>
      )}
      {hb && hover && (
        <Tooltip x={hover.x} y={hover.y} width={width}>
          <div className="t">
            {xFormat(hb.lo)} – {xFormat(hb.hi)}
          </div>
          <div className="r">
            <span>
              <i style={{ background: palette.exposed }} />
              Exposed
            </span>
            <b>
              {hb.expCount.toLocaleString()} <span className="muted">({hb.expDens.toFixed(2)})</span>
            </b>
          </div>
          <div className="r">
            <span>
              <i style={{ background: palette.control }} />
              Control
            </span>
            <b>
              {hb.ctlCount.toLocaleString()} <span className="muted">({hb.ctlDens.toFixed(2)})</span>
            </b>
          </div>
        </Tooltip>
      )}
    </div>
  );
}

/* ======================================================================== */
/* Forest plot (point + CI rows grouped under headers)                      */
/* ======================================================================== */

export function ForestPlot({
  rows,
  palette,
  unit = "",
  labelWidth = 230,
  xLabel,
  fixedWidth,
}: {
  rows: ForestRow[];
  palette: Palette;
  unit?: string;
  labelWidth?: number;
  xLabel?: string;
  fixedWidth?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(fixedWidth);
  const [hover, setHover] = useState<{ r: ForestRow; x: number; y: number } | null>(null);
  if (!rows.some((r) => !r.header)) return <div className="empty small">No estimates.</div>;
  const rowH = 24;
  const headH = 28;
  const m = { l: labelWidth, r: 24, t: 8, b: 40 };
  const ys: number[] = [];
  let cy = m.t;
  for (const r of rows) {
    const h = r.header ? headH : rowH;
    ys.push(cy + h / 2);
    cy += h;
  }
  const height = cy + m.b;
  const vals = rows.flatMap((r) => [r.est, r.lo, r.hi]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const [d0, d1] = niceDomain(Math.min(0, ...vals), Math.max(0, ...vals), 6);
  const iw = Math.max(40, width - m.l - m.r);
  const x = linear([d0, d1], [m.l, m.l + iw]);
  const ticks = niceTicks(d0, d1, Math.max(3, Math.floor(iw / 70)));
  return (
    <div ref={ref} style={{ position: "relative", width: "100%" }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Forest plot of lift estimates">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={m.t} y2={cy} stroke={palette.grid} />
              <text x={x(t)} y={cy + 16} fontSize={11} textAnchor="middle" fill={palette.axis}>
                {t > 0 ? "+" : ""}
                {fmtTick(t)}
                {unit}
              </text>
            </g>
          ))}
          <line x1={x(0)} x2={x(0)} y1={m.t} y2={cy} stroke={palette.axis} strokeWidth={1.2} />
          {xLabel && (
            <text x={m.l + iw / 2} y={height - 4} textAnchor="middle" fontSize={12} fill={palette.muted}>
              {xLabel}
            </text>
          )}
          {rows.map((r, i) => {
            const y = ys[i];
            if (r.header)
              return (
                <g key={r.key}>
                  {i > 0 && <line x1={0} x2={width} y1={y - headH / 2} y2={y - headH / 2} stroke={palette.grid} />}
                  <text x={4} y={y + 2} dy="0.32em" fontSize={12.5} fontWeight={650} fill={palette.text}>
                    {truncate(r.label, 40)}
                  </text>
                </g>
              );
            const c = r.color ?? palette.text;
            return (
              <g
                key={r.key}
                onMouseEnter={(e) => {
                  const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                  setHover({ r, x: e.clientX - rect.left, y: e.clientY - rect.top });
                }}
                onMouseLeave={() => setHover(null)}
              >
                <rect x={0} y={y - rowH / 2} width={width} height={rowH} fill="transparent" />
                <text x={16} y={y} dy="0.32em" fontSize={12} fill={palette.muted}>
                  {truncate(r.label, 34)}
                </text>
                {r.lo != null && r.hi != null && (
                  <g stroke={c} strokeWidth={2}>
                    <line x1={x(r.lo)} x2={x(r.hi)} y1={y} y2={y} />
                    <line x1={x(r.lo)} x2={x(r.lo)} y1={y - 5} y2={y + 5} />
                    <line x1={x(r.hi)} x2={x(r.hi)} y1={y - 5} y2={y + 5} />
                  </g>
                )}
                {r.est != null &&
                  (r.hollow ? (
                    <rect x={x(r.est) - 5} y={y - 5} width={10} height={10} fill={palette.tooltipBg} stroke={c} strokeWidth={2} transform={`rotate(45 ${x(r.est)} ${y})`} />
                  ) : (
                    <circle cx={x(r.est)} cy={y} r={5.5} fill={r.significant ? c : palette.tooltipBg} stroke={c} strokeWidth={2} />
                  ))}
              </g>
            );
          })}
        </svg>
      )}
      {hover && hover.r.est != null && (
        <Tooltip x={hover.x} y={hover.y} width={width}>
          <div className="t">{hover.r.label}</div>
          <div className="r">
            <span>Estimate</span>
            <b>
              {hover.r.est >= 0 ? "+" : ""}
              {hover.r.est.toFixed(2)}
              {unit}
            </b>
          </div>
          {hover.r.lo != null && hover.r.hi != null && (
            <div className="r">
              <span>CI</span>
              <b>
                [{hover.r.lo.toFixed(2)}, {hover.r.hi.toFixed(2)}]
              </b>
            </div>
          )}
          {hover.r.significant != null && !hover.r.hollow && (
            <div className="r">
              <span>Significant</span>
              <b>{hover.r.significant ? "yes" : "no"}</b>
            </div>
          )}
        </Tooltip>
      )}
    </div>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/* ======================================================================== */
/* Love plot                                                                */
/* ======================================================================== */

export function LovePlot({
  rows,
  palette,
  threshold = 0.1,
  fixedWidth,
}: {
  rows: BalanceRow[];
  palette: Palette;
  threshold?: number;
  fixedWidth?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(fixedWidth);
  const [hover, setHover] = useState<{ r: BalanceRow; x: number; y: number } | null>(null);
  if (!rows.length) return <div className="empty small">No balance rows for this filter.</div>;
  const rowH = 20;
  const m = { l: 220, r: 20, t: 26, b: 34 };
  const height = m.t + rows.length * rowH + m.b;
  const maxV = Math.max(threshold * 2, ...rows.map((r) => Math.max(Math.abs(r.smd_before), Math.abs(r.smd_after))));
  const [d0, d1] = niceDomain(0, maxV, 5);
  const iw = Math.max(40, width - m.l - m.r);
  const x = linear([d0, d1], [m.l, m.l + iw]);
  const ticks = niceTicks(d0, d1, Math.max(3, Math.floor(iw / 70)));
  const axisY = m.t + rows.length * rowH;
  return (
    <div ref={ref} style={{ position: "relative", width: "100%" }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Love plot of absolute standardized mean differences">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={m.t} y2={axisY} stroke={palette.grid} />
              <text x={x(t)} y={axisY + 14} fontSize={11} textAnchor="middle" fill={palette.axis}>
                {fmtTick(t)}
              </text>
              <text x={x(t)} y={m.t - 10} fontSize={11} textAnchor="middle" fill={palette.axis}>
                {fmtTick(t)}
              </text>
            </g>
          ))}
          <line x1={x(threshold)} x2={x(threshold)} y1={m.t - 4} y2={axisY} stroke={palette.threshold} strokeDasharray="5 3" strokeWidth={1.5} />
          <text x={m.l + iw / 2} y={height - 4} textAnchor="middle" fontSize={12} fill={palette.muted}>
            |Standardized mean difference|
          </text>
          {rows.map((r, i) => {
            const y = m.t + i * rowH + rowH / 2;
            const b = Math.abs(r.smd_before);
            const a = Math.abs(r.smd_after);
            return (
              <g
                key={r.variable}
                onMouseEnter={(e) => {
                  const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                  setHover({ r, x: e.clientX - rect.left, y: e.clientY - rect.top });
                }}
                onMouseLeave={() => setHover(null)}
              >
                <rect x={0} y={y - rowH / 2} width={width} height={rowH} fill={i % 2 ? "transparent" : palette.grid} opacity={0.35} />
                <text x={m.l - 8} y={y} dy="0.32em" textAnchor="end" fontSize={11.5} fill={a > threshold ? palette.threshold : palette.text}>
                  {truncate(r.variable, 32)}
                </text>
                <line x1={x(b)} x2={x(a)} y1={y} y2={y} stroke={palette.muted} strokeWidth={1} opacity={0.6} />
                <circle cx={x(b)} cy={y} r={4.5} fill={palette.tooltipBg} stroke={palette.before} strokeWidth={2} />
                <circle cx={x(a)} cy={y} r={4.5} fill={palette.after} />
              </g>
            );
          })}
        </svg>
      )}
      {hover && (
        <Tooltip x={hover.x} y={hover.y} width={width}>
          <div className="t">{hover.r.variable}</div>
          <div className="r">
            <span>SMD before</span>
            <b>{hover.r.smd_before.toFixed(3)}</b>
          </div>
          <div className="r">
            <span>SMD after</span>
            <b>{hover.r.smd_after.toFixed(3)}</b>
          </div>
          <div className="r">
            <span>Role</span>
            <b>{hover.r.role}</b>
          </div>
        </Tooltip>
      )}
    </div>
  );
}
