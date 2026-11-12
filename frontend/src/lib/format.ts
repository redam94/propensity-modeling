import type { Method, OutcomeType, Scalar } from "../api/types";

const isNum = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

export const DASH = "—";

/** Integer with thousands separators. */
export function fmtInt(v: number | null | undefined): string {
  if (!isNum(v)) return DASH;
  return Math.round(v).toLocaleString("en-US");
}

/** Generic number with fixed decimals. */
export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (!isNum(v)) return DASH;
  return v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Proportion 0-1 -> "42.3%". */
export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (!isNum(v)) return DASH;
  return `${(v * 100).toFixed(digits)}%`;
}

/** Value already on 0-100 scale -> "42.3%". */
export function fmtPct100(v: number | null | undefined, digits = 1): string {
  if (!isNum(v)) return DASH;
  return `${v.toFixed(digits)}%`;
}

/** Signed number with explicit +. */
export function fmtSigned(v: number | null | undefined, digits = 2, suffix = ""): string {
  if (!isNum(v)) return DASH;
  const s = v.toFixed(digits);
  // avoid "-0.0"
  const clean = Number(s) === 0 ? (0).toFixed(digits) : s;
  return `${Number(clean) > 0 ? "+" : ""}${clean}${suffix}`;
}

/** Absolute difference of proportions -> percentage points, e.g. +4.2 pp. */
export function fmtPP(v: number | null | undefined, digits = 1): string {
  if (!isNum(v)) return DASH;
  return fmtSigned(v * 100, digits, " pp");
}

/** Relative lift already in % (lift / control * 100). */
export function fmtRelLift(v: number | null | undefined, digits = 1): string {
  if (!isNum(v)) return DASH;
  return fmtSigned(v, digits, "%");
}

/** Mean of an outcome: proportion for binary, number otherwise. */
export function fmtOutcomeValue(v: number | null | undefined, type: OutcomeType): string {
  return type === "binary" ? fmtPct(v) : fmtNum(v, 2);
}

/** Absolute lift: pp for binary, signed number for continuous. */
export function fmtLift(v: number | null | undefined, type: OutcomeType): string {
  return type === "binary" ? fmtPP(v) : fmtSigned(v, 2);
}

/** CI on absolute lift. */
export function fmtCI(lo: number | null | undefined, hi: number | null | undefined, type: OutcomeType): string {
  if (!isNum(lo) || !isNum(hi)) return DASH;
  if (type === "binary") return `[${fmtSigned(lo * 100, 1)}, ${fmtSigned(hi * 100, 1)}] pp`;
  return `[${fmtSigned(lo, 2)}, ${fmtSigned(hi, 2)}]`;
}

/**
 * p-value with "<0.001" floor. Precision is widened as needed so the shown
 * value never rounds across `alpha` (the significance cut-off) or `2*alpha`
 * (the "directional" cut-off) — e.g. p=0.0496 shows "0.0496", not "0.050".
 */
export function fmtP(p: number | null | undefined, alpha = 0.05): string {
  if (!isNum(p)) return DASH;
  if (p < 0.001) return "<0.001";
  let digits = p < 0.1 ? 3 : 2;
  let s = p.toFixed(digits);
  for (const cut of [alpha, alpha * 2]) {
    while (digits < 6 && p < cut !== Number(s) < cut) {
      digits++;
      s = p.toFixed(digits);
    }
  }
  return s;
}

export type SigLevel = "sig-pos" | "sig-neg" | "marginal" | "ns";

/** Classify significance for colour coding. */
export function sigLevel(p: number, lift: number, alpha = 0.05): SigLevel {
  if (!Number.isFinite(p)) return "ns";
  if (p < alpha) return lift >= 0 ? "sig-pos" : "sig-neg";
  if (p < Math.min(1, alpha * 2)) return "marginal";
  return "ns";
}

export function sigLabel(level: SigLevel): string {
  switch (level) {
    case "sig-pos":
      return "Significant ↑";
    case "sig-neg":
      return "Significant ↓";
    case "marginal":
      return "Directional";
    default:
      return "Not sig.";
  }
}

export function fmtScalar(v: Scalar | null | undefined): string {
  if (v === null || v === undefined) return DASH;
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4)));
  return v === "" ? "(blank)" : v;
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (!isNum(seconds)) return DASH;
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function elapsedSeconds(fromIso: string | null | undefined, toIso?: string | null): number | null {
  if (!fromIso) return null;
  const a = new Date(fromIso).getTime();
  const b = toIso ? new Date(toIso).getTime() : Date.now();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, (b - a) / 1000);
}

export const METHOD_LABELS: Record<Method, string> = {
  nn_matching: "NN matching",
  ipw: "IPW",
  overlap_weights: "Overlap weights",
  stratification: "Stratification",
  aipw: "AIPW (doubly robust)",
};

export const ROLE_LABELS: Record<string, string> = {
  model: "Model",
  matching: "Matching",
  both: "Model + matching",
};

export function titleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
