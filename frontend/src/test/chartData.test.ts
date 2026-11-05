import { describe, expect, it } from "vitest";
import type { AnalysisResult } from "../api/types";
import { compareMethodsRows, histBins, loveRows, niceTicks } from "../lib/chartData";
import { PALETTES } from "../lib/theme";
import fixtureJson from "./fixtures/analysis_result.json";

const fixture = fixtureJson as unknown as AnalysisResult;

describe("chart data from AnalysisResult fixture", () => {
  it("builds histogram bins with shared edges", () => {
    const bins = histBins(fixture.overlap.histogram);
    expect(bins).toHaveLength(fixture.overlap.histogram.edges.length - 1);
    expect(bins[0]).toMatchObject({ lo: 0, hi: 0.2, expCount: 5, ctlCount: 60 });
    expect(histBins(null)).toEqual([]);
  });

  it("builds compare-methods rows in pp for binary outcomes", () => {
    const rows = compareMethodsRows(fixture.methods, "binary", PALETTES.LIGHT.methods, "#999");
    expect(rows[0]).toMatchObject({ header: true, label: "aware" });
    const raw = rows.find((r) => r.key === "aware:raw")!;
    expect(raw.est).toBeCloseTo(14, 6);
    const nn = rows.find((r) => r.key === "aware:nn_matching")!;
    expect(nn.est).toBeCloseTo(12, 6);
    expect(nn.lo!).toBeLessThan(nn.est!);
    expect(rows.filter((r) => !r.header)).toHaveLength(3);
    const cont = compareMethodsRows(fixture.methods, "continuous", PALETTES.LIGHT.methods, "#999");
    expect(cont.find((r) => r.key === "purchase_intent:ipw")!.est).toBeCloseTo(0.15, 6);
  });

  it("filters and sorts love-plot rows", () => {
    const bal = fixture.methods[0].balance;
    expect(loveRows(bal, "all", "before").map((r) => r.variable)).toEqual(["age", "heavy_tv", "region=North"]);
    expect(loveRows(bal, "matching", "after").map((r) => r.variable)).toEqual(["heavy_tv", "region=North"]);
    expect(loveRows(bal, "model", "name").map((r) => r.variable)).toEqual(["age", "heavy_tv"]);
  });

  it("produces nice ticks", () => {
    expect(niceTicks(0, 1, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(-3, 7, 5)).toEqual([-2, 0, 2, 4, 6]);
  });
});
