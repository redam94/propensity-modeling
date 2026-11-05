import { describe, expect, it } from "vitest";
import { fmtCI, fmtInt, fmtLift, fmtOutcomeValue, fmtP, fmtPct, fmtPP, fmtRelLift, fmtScalar, fmtSigned, sigLevel } from "../lib/format";

describe("formatters", () => {
  it("formats proportions as percentages", () => {
    expect(fmtPct(0.4234)).toBe("42.3%");
    expect(fmtPct(1)).toBe("100.0%");
    expect(fmtPct(null)).toBe("—");
    expect(fmtPct(Number.NaN)).toBe("—");
  });

  it("formats binary lifts in percentage points with sign", () => {
    expect(fmtPP(0.042)).toBe("+4.2 pp");
    expect(fmtPP(-0.015)).toBe("-1.5 pp");
    expect(fmtPP(0)).toBe("0.0 pp");
    expect(fmtLift(0.12, "binary")).toBe("+12.0 pp");
    expect(fmtLift(0.12, "continuous")).toBe("+0.12");
  });

  it("never shows negative zero", () => {
    expect(fmtSigned(-0.0001, 2)).toBe("0.00");
  });

  it("formats outcome values by type", () => {
    expect(fmtOutcomeValue(0.62, "binary")).toBe("62.0%");
    expect(fmtOutcomeValue(3.456, "continuous")).toBe("3.46");
  });

  it("formats relative lift and CIs", () => {
    expect(fmtRelLift(12.345)).toBe("+12.3%");
    expect(fmtRelLift(null)).toBe("—");
    expect(fmtCI(0.01, 0.05, "binary")).toBe("[+1.0, +5.0] pp");
    expect(fmtCI(-0.2, 0.4, "continuous")).toBe("[-0.20, +0.40]");
  });

  it("formats p-values with a <0.001 floor", () => {
    expect(fmtP(0.0004)).toBe("<0.001");
    expect(fmtP(0.0042)).toBe("0.004");
    expect(fmtP(0.0499)).toBe("0.05");
    expect(fmtP(0.5)).toBe("0.50");
  });

  it("classifies significance", () => {
    expect(sigLevel(0.01, 0.05)).toBe("sig-pos");
    expect(sigLevel(0.01, -0.05)).toBe("sig-neg");
    expect(sigLevel(0.07, 0.05)).toBe("marginal");
    expect(sigLevel(0.5, 0.05)).toBe("ns");
  });

  it("formats integers and scalars", () => {
    expect(fmtInt(12345.4)).toBe("12,345");
    expect(fmtScalar(true)).toBe("True");
    expect(fmtScalar(1.23456789)).toBe("1.2346");
    expect(fmtScalar("")).toBe("(blank)");
  });
});
