import { useEffect, useState } from "react";
import type { Method } from "../api/types";

/**
 * Colour-blind-safe palette (Okabe–Ito derived). Exposed = vermillion/orange,
 * Control = blue everywhere in the app. Dark variants are lightened for contrast.
 */
export interface Palette {
  exposed: string;
  control: string;
  exposedSoft: string;
  controlSoft: string;
  raw: string;
  support: string;
  grid: string;
  axis: string;
  text: string;
  muted: string;
  threshold: string;
  positive: string;
  negative: string;
  before: string;
  after: string;
  tooltipBg: string;
  tooltipBorder: string;
  methods: Record<Method, string>;
  series: string[];
}

const LIGHT: Palette = {
  exposed: "#D55E00",
  control: "#0072B2",
  exposedSoft: "rgba(213,94,0,0.18)",
  controlSoft: "rgba(0,114,178,0.18)",
  raw: "#6B7280",
  support: "rgba(0,158,115,0.10)",
  grid: "#E5E7EB",
  axis: "#6B7280",
  text: "#111827",
  muted: "#6B7280",
  threshold: "#B91C1C",
  positive: "#047857",
  negative: "#B91C1C",
  before: "#868E9C", // >=3:1 non-text contrast on white
  after: "#0072B2",
  tooltipBg: "#FFFFFF",
  tooltipBorder: "#E5E7EB",
  methods: {
    nn_matching: "#7C3AED",
    ipw: "#009E73",
    overlap_weights: "#CC79A7",
    stratification: "#A16207",
  },
  series: ["#0072B2", "#D55E00", "#009E73", "#CC79A7", "#7C3AED", "#A16207", "#56B4E9", "#E69F00"],
};

const DARK: Palette = {
  exposed: "#FF9A52",
  control: "#56B4E9",
  exposedSoft: "rgba(255,154,82,0.22)",
  controlSoft: "rgba(86,180,233,0.22)",
  raw: "#9CA3AF",
  support: "rgba(52,211,153,0.12)",
  grid: "#2B3240",
  axis: "#9CA3AF",
  text: "#E5E7EB",
  muted: "#9CA3AF",
  threshold: "#F87171",
  positive: "#34D399",
  negative: "#F87171",
  before: "#6B7280",
  after: "#56B4E9",
  tooltipBg: "#1A1F2B",
  tooltipBorder: "#2B3240",
  methods: {
    nn_matching: "#A78BFA",
    ipw: "#34D399",
    overlap_weights: "#F0A3CB",
    stratification: "#FACC15",
  },
  series: ["#56B4E9", "#FF9A52", "#34D399", "#F0A3CB", "#A78BFA", "#FACC15", "#93C5FD", "#FDBA74"],
};

const QUERY = "(prefers-color-scheme: dark)";

export function useIsDark(): boolean {
  const get = () => typeof window !== "undefined" && !!window.matchMedia?.(QUERY).matches;
  const [dark, setDark] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia?.(QUERY);
    if (!mq) return;
    const fn = () => setDark(mq.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  return dark;
}

export function usePalette(): Palette {
  return useIsDark() ? DARK : LIGHT;
}

export const PALETTES = { LIGHT, DARK };
