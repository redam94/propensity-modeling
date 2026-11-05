/** Pure data shaping for charts (unit-tested). */
import type { BalanceRow, FeatureRole, Histogram, Method, MethodResult, OutcomeContrast, OutcomeType } from "../api/types";

export interface Bin {
  lo: number;
  hi: number;
  mid: number;
  expCount: number;
  ctlCount: number;
  expDens: number;
  ctlDens: number;
}

export function histBins(h: Histogram | null | undefined): Bin[] {
  if (!h || h.edges.length < 2) return [];
  const n = h.edges.length - 1;
  const out: Bin[] = [];
  for (let i = 0; i < n; i++) {
    const lo = h.edges[i];
    const hi = h.edges[i + 1];
    out.push({
      lo,
      hi,
      mid: (lo + hi) / 2,
      expCount: h.exposed_counts[i] ?? 0,
      ctlCount: h.control_counts[i] ?? 0,
      expDens: h.exposed_density[i] ?? 0,
      ctlDens: h.control_density[i] ?? 0,
    });
  }
  return out;
}

/** "Nice" tick values covering [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const span = max - min;
  const raw = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 7.07 ? 10 : norm >= 3.16 ? 5 : norm >= 1.41 ? 2 : 1) * mag;
  const start = Math.ceil(min / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

/** Expand [min,max] outward to nice step boundaries. */
export function niceDomain(min: number, max: number, count = 5): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    return [min - pad, max + pad];
  }
  const t = niceTicks(min, max, count);
  if (t.length < 2) return [min, max];
  const step = t[1] - t[0];
  return [Math.min(t[0], Math.floor(min / step) * step), Math.max(t[t.length - 1], Math.ceil(max / step) * step)];
}

export function linear(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return (v: number) => r0 + (v - d0) * k;
}

/* ---------------------------------------------------------------- lift */

export interface ForestRow {
  key: string;
  label: string;
  /** header rows have no estimate */
  header?: boolean;
  est?: number;
  lo?: number;
  hi?: number;
  color?: string;
  hollow?: boolean;
  significant?: boolean;
  tooltip?: string;
}

export function outcomeTypes(methods: MethodResult[]): Map<string, OutcomeType> {
  const m = new Map<string, OutcomeType>();
  for (const mr of methods) for (const c of mr.contrasts) if (!m.has(c.outcome)) m.set(c.outcome, c.outcome_type);
  return m;
}

/**
 * Rows for the "compare methods" forest plot of one outcome type.
 * Per outcome: header, raw difference (no CI), then one row per method.
 * Binary outcomes are scaled to percentage points.
 */
export function compareMethodsRows(
  methods: MethodResult[],
  type: OutcomeType,
  colors: Record<Method, string>,
  rawColor: string,
): ForestRow[] {
  const scale = type === "binary" ? 100 : 1;
  const types = outcomeTypes(methods);
  const outcomes = [...types.entries()].filter(([, t]) => t === type).map(([o]) => o);
  const rows: ForestRow[] = [];
  for (const o of outcomes) {
    rows.push({ key: `h:${o}`, label: o, header: true });
    const first = methods.flatMap((m) => m.contrasts).find((c) => c.outcome === o);
    if (first) rows.push({ key: `${o}:raw`, label: "Raw difference", est: first.raw_diff * scale, color: rawColor, hollow: true });
    for (const m of methods) {
      const c = m.contrasts.find((x) => x.outcome === o);
      if (!c) continue;
      rows.push({
        key: `${o}:${m.method}`,
        label: m.label || m.method,
        est: c.lift * scale,
        lo: c.ci_low * scale,
        hi: c.ci_high * scale,
        color: colors[m.method],
        significant: c.significant,
      });
    }
  }
  return rows;
}

export function contrastScale(c: Pick<OutcomeContrast, "outcome_type">): number {
  return c.outcome_type === "binary" ? 100 : 1;
}

/* ---------------------------------------------------------------- balance */

export type BalanceSort = "before" | "after" | "name";

export function loveRows(rows: BalanceRow[], role: FeatureRole | "all", sort: BalanceSort): BalanceRow[] {
  const f = rows.filter((r) => role === "all" || r.role === role || (role !== "both" && r.role === "both"));
  const out = [...f];
  if (sort === "name") out.sort((a, b) => a.variable.localeCompare(b.variable));
  else if (sort === "before") out.sort((a, b) => Math.abs(b.smd_before) - Math.abs(a.smd_before));
  else out.sort((a, b) => Math.abs(b.smd_after) - Math.abs(a.smd_after));
  return out;
}
