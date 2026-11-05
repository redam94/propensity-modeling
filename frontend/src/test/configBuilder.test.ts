import { describe, expect, it } from "vitest";
import {
  assignRole,
  buildAnalysisConfig,
  defaultExposed,
  initialConfigState,
  initialRoles,
  validateConfig,
  type ConfigState,
} from "../lib/configBuilder";
import { profileFixture as P } from "./fixtures/profile";

const col = (name: string) => P.columns.find((c) => c.name === name)!;

function readyState(): ConfigState {
  const s = initialConfigState(P);
  return { ...s, positives: { purchase_intent: ["Very likely", "Somewhat likely"] } };
}

describe("initial roles from suggested_role", () => {
  it("maps suggestions and ignores ids / unusable kinds", () => {
    const r = initialRoles(P);
    expect(r.group.role).toBe("treatment");
    expect(r.age.role).toBe("model");
    expect(r.region.role).toBe("matching");
    expect(r.aware.role).toBe("outcome");
    expect(r.resp_id.role).toBe("ignore");
    expect(r.gender.role).toBe("ignore");
    // datetime suggested as model feature is not usable -> ignore
    expect(r.interview_date.role).toBe("ignore");
  });

  it("picks the exposed value by name", () => {
    expect(defaultExposed(col("group"))).toEqual(["Exposed"]);
  });
});

describe("validateConfig", () => {
  it("requires top-box levels for categorical outcomes", () => {
    const s = initialConfigState(P);
    const v = validateConfig(P, s);
    expect(v.errors.some((e) => e.includes("purchase_intent"))).toBe(true);
    expect(validateConfig(P, readyState()).errors).toEqual([]);
  });

  it("requires a treatment, outcomes, methods and features", () => {
    let s = readyState();
    s = { ...s, columns: assignRole(s.columns, ["group", "age", "region", "aware", "purchase_intent"], "ignore") };
    s = { ...s, options: { ...s.options, methods: [] } };
    const errs = validateConfig(P, s).errors.join("\n");
    expect(errs).toMatch(/treatment column/i);
    expect(errs).toMatch(/outcome/i);
    expect(errs).toMatch(/method/i);
    expect(errs).toMatch(/feature/i);
  });

  it("rejects an empty control group and overlapping explicit groups", () => {
    const s = readyState();
    const allExposed = { ...s, treatment: { exposed: ["Control", "Exposed"], controlMode: "rest" as const, control: [] } };
    expect(validateConfig(P, allExposed).errors.join()).toMatch(/control group would be empty/);
    const overlap = { ...s, treatment: { exposed: ["Exposed"], controlMode: "explicit" as const, control: ["Exposed"] } };
    expect(validateConfig(P, overlap).errors.join()).toMatch(/both exposed and control/);
  });

  it("needs model features when matching features are excluded from the model", () => {
    let s = readyState();
    s = { ...s, columns: assignRole(s.columns, ["age"], "ignore"), options: { ...s.options, include_matching_in_model: false } };
    expect(validateConfig(P, s).errors.join()).toMatch(/include matching features in model/);
  });

  it("checks numeric option ranges", () => {
    const s = readyState();
    const bad = { ...s, options: { ...s.options, match_ratio: 11, n_strata: 1, n_bootstrap: -1, alpha: 0.7, caliper: 0 } };
    const errs = validateConfig(P, bad).errors;
    expect(errs.length).toBeGreaterThanOrEqual(5);
  });
});

describe("assignRole", () => {
  it("keeps exactly one treatment column", () => {
    const s = initialConfigState(P);
    const next = assignRole(s.columns, ["gender", "region"], "treatment");
    expect(Object.entries(next).filter(([, v]) => v.role === "treatment").map(([k]) => k)).toEqual(["gender"]);
    expect(next.group.role).toBe("ignore");
  });
});

describe("buildAnalysisConfig", () => {
  it("turns the role grid into an AnalysisConfig", () => {
    let s = readyState();
    s = { ...s, columns: assignRole(s.columns, ["gender"], "subgroup") };
    s = { ...s, columns: assignRole(s.columns, ["region"], "model_matching") };
    s = { ...s, columns: { ...s.columns, age: { role: "model", subgroup: true } } };
    s = { ...s, options: { ...s.options, name: "  Wave 2 ", useCaliper: false, methods: ["ipw", "overlap_weights"] } };
    const cfg = buildAnalysisConfig(P, s);
    expect(cfg).toMatchObject({
      dataset_id: "ds123",
      sheet: "Sheet1",
      name: "Wave 2",
      treatment_column: "group",
      exposed_values: ["Exposed"],
      control_values: null,
      outcome_columns: ["aware", "purchase_intent"],
      outcome_positive_values: { purchase_intent: ["Very likely", "Somewhat likely"] },
      model_features: ["age", "region"],
      matching_features: ["region"],
      subgroup_columns: ["age", "gender"],
      methods: ["ipw", "overlap_weights"],
      caliper: null,
      weight_clip: null,
      estimand: "ATT",
      match_ratio: 1,
      n_bootstrap: 200,
    });
  });

  it("keeps numeric treatment values numeric and supports explicit control", () => {
    let s = readyState();
    s = { ...s, columns: assignRole(s.columns, ["aware"], "treatment") };
    s = { ...s, columns: assignRole(s.columns, ["gender"], "outcome") };
    s = { ...s, treatment: { exposed: ["1"], controlMode: "explicit", control: ["0"] } };
    const cfg = buildAnalysisConfig(P, s);
    expect(cfg.treatment_column).toBe("aware");
    expect(cfg.exposed_values).toEqual([1]);
    expect(cfg.control_values).toEqual([0]);
    expect(cfg.outcome_columns).toEqual(["purchase_intent", "gender"]);
  });

  it("drops empty names and does not emit subgroup flags for outcomes", () => {
    const s = readyState();
    const cfg = buildAnalysisConfig(P, { ...s, columns: { ...s.columns, aware: { role: "outcome", subgroup: true } } });
    expect(cfg.name).toBeNull();
    expect(cfg.subgroup_columns).toEqual([]);
  });
});
