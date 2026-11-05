/**
 * Pure logic that turns the Configure page's state (column-role grid + panels)
 * into an AnalysisConfig, plus client-side validation mirroring the backend.
 */
import type {
  AnalysisConfig,
  ColumnProfile,
  DatasetProfile,
  Estimand,
  Method,
  MissingStrategy,
  ModelType,
  Scalar,
  TrimRule,
} from "../api/types";

export type ColumnRole =
  | "treatment"
  | "outcome"
  | "model"
  | "matching"
  | "model_matching"
  | "subgroup"
  | "ignore";

export const ROLE_OPTIONS: { value: ColumnRole; label: string; short: string }[] = [
  { value: "treatment", label: "Treatment (exposed/control)", short: "Treatment" },
  { value: "outcome", label: "Outcome (KPI)", short: "Outcome" },
  { value: "model", label: "Model feature", short: "Model" },
  { value: "matching", label: "Matching feature", short: "Matching" },
  { value: "model_matching", label: "Model + matching", short: "Model+Match" },
  { value: "subgroup", label: "Subgroup only", short: "Subgroup" },
  { value: "ignore", label: "Ignore", short: "Ignore" },
];

export interface ColumnState {
  role: ColumnRole;
  /** Additionally report lift split by this column (allowed for feature roles too). */
  subgroup: boolean;
}

export interface TreatmentState {
  /** String keys (String(value)) of exposed values. */
  exposed: string[];
  /** "rest" = every other non-missing value is control (control_values = null). */
  controlMode: "rest" | "explicit";
  control: string[];
}

export interface OptionsState {
  name: string;
  model_type: ModelType;
  methods: Method[];
  estimand: Estimand;
  useCaliper: boolean;
  caliper: number;
  match_ratio: number;
  replacement: boolean;
  useWeightClip: boolean;
  weight_clip: number;
  n_strata: number;
  trim: TrimRule;
  missing_strategy: MissingStrategy;
  n_bootstrap: number;
  alpha: number;
  include_matching_in_model: boolean;
  random_state: number;
}

export interface ConfigState {
  columns: Record<string, ColumnState>;
  treatment: TreatmentState;
  /** outcome column -> String keys of positive (top-box) levels */
  positives: Record<string, string[]>;
  options: OptionsState;
}

export const DEFAULT_OPTIONS: OptionsState = {
  name: "",
  model_type: "logistic",
  methods: ["nn_matching", "ipw"],
  estimand: "ATT",
  useCaliper: true,
  caliper: 0.2,
  match_ratio: 1,
  replacement: true,
  useWeightClip: false,
  weight_clip: 0.99,
  n_strata: 5,
  trim: "none",
  missing_strategy: "impute",
  n_bootstrap: 200,
  alpha: 0.05,
  include_matching_in_model: true,
  random_state: 42,
};

const UNUSABLE_KINDS = new Set(["datetime", "text", "empty"]);

export const valueKey = (v: Scalar): string => String(v);

/** Map the profiler's suggested_role onto a grid role. Only the first suggested treatment is kept. */
export function initialRoles(profile: DatasetProfile): Record<string, ColumnState> {
  const out: Record<string, ColumnState> = {};
  let haveTreatment = false;
  for (const c of profile.columns) {
    let role: ColumnRole = "ignore";
    switch (c.suggested_role) {
      case "treatment":
        if (!haveTreatment) {
          role = "treatment";
          haveTreatment = true;
        }
        break;
      case "outcome":
        role = "outcome";
        break;
      case "model_feature":
        role = "model";
        break;
      case "matching_feature":
        role = "matching";
        break;
      default:
        role = "ignore";
    }
    if (role !== "treatment" && role !== "ignore" && UNUSABLE_KINDS.has(c.kind)) role = "ignore";
    out[c.name] = { role, subgroup: false };
  }
  return out;
}

const EXPOSED_HINTS = ["exposed", "test", "treatment", "treated", "yes", "1", "true"];

/** Pick sensible default exposed values for a treatment column. */
export function defaultExposed(col: ColumnProfile | undefined): string[] {
  if (!col || col.top_values.length === 0) return [];
  const keys = col.top_values.map((t) => valueKey(t.value));
  for (const hint of EXPOSED_HINTS) {
    const hit = keys.find((k) => k.trim().toLowerCase() === hint);
    if (hit !== undefined) return [hit];
  }
  // e.g. "Exposed group" / "Test cell"
  const fuzzy = keys.find((k) => /expos|test|treat/i.test(k) && !/control|unexpos|non/i.test(k));
  if (fuzzy !== undefined) return [fuzzy];
  return [keys[keys.length > 1 ? 1 : 0]];
}

export function defaultTreatmentState(col: ColumnProfile | undefined): TreatmentState {
  return { exposed: defaultExposed(col), controlMode: "rest", control: [] };
}

/** Outcomes that need a top-box recode choice (non-binary categorical/text). */
export function needsPositiveLevels(col: ColumnProfile | undefined): boolean {
  if (!col) return false;
  return col.kind === "categorical" || col.kind === "text";
}

/** Outcomes where a recode is optional (e.g. 1-5 numeric scales). */
export function canRecode(col: ColumnProfile | undefined): boolean {
  if (!col) return false;
  if (needsPositiveLevels(col)) return true;
  // two-level text outcomes (e.g. "Yes"/"No") are auto-coded by the backend, but allow overriding which level is positive
  if (col.kind === "binary") return col.top_values.some((t) => typeof t.value === "string");
  return col.kind === "numeric" && col.n_unique <= 11 && col.top_values.length > 0;
}

export function columnsWithRole(state: ConfigState, ...roles: ColumnRole[]): string[] {
  const set = new Set(roles);
  return Object.entries(state.columns)
    .filter(([, s]) => set.has(s.role))
    .map(([n]) => n);
}

/** Resolve a value key back to the original scalar from top_values (keeps numbers numeric). */
function resolveValues(col: ColumnProfile | undefined, keys: string[]): Scalar[] {
  const lookup = new Map<string, Scalar>();
  for (const t of col?.top_values ?? []) lookup.set(valueKey(t.value), t.value);
  return keys.map((k) => (lookup.has(k) ? (lookup.get(k) as Scalar) : k));
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export function validateConfig(profile: DatasetProfile, state: ConfigState): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byName = new Map(profile.columns.map((c) => [c.name, c]));
  const o = state.options;

  const treatments = columnsWithRole(state, "treatment");
  if (treatments.length === 0) errors.push("Choose a treatment column (the exposed / control indicator).");
  if (treatments.length > 1) errors.push(`Exactly one treatment column is allowed (found ${treatments.length}: ${treatments.join(", ")}).`);

  if (treatments.length === 1) {
    const tcol = byName.get(treatments[0]);
    const exposed = new Set(state.treatment.exposed);
    if (exposed.size === 0) errors.push("Select at least one treatment value as Exposed.");
    if (state.treatment.controlMode === "explicit") {
      if (state.treatment.control.length === 0) errors.push("Select at least one treatment value as Control.");
      const overlap = state.treatment.control.filter((c) => exposed.has(c));
      if (overlap.length) errors.push(`Values cannot be both exposed and control: ${overlap.join(", ")}.`);
    } else if (tcol) {
      const others = tcol.top_values.filter((t) => !exposed.has(valueKey(t.value)));
      const unseen = tcol.n_unique > tcol.top_values.length;
      if (others.length === 0 && !unseen) errors.push("Every treatment value is marked exposed — the control group would be empty.");
    }
    if (tcol && tcol.n_unique > 20) warnings.push(`Treatment column "${tcol.name}" has ${tcol.n_unique} distinct values — is it really the exposure flag?`);
  }

  const outcomes = columnsWithRole(state, "outcome");
  if (outcomes.length === 0) errors.push("Choose at least one outcome column.");
  for (const name of outcomes) {
    const col = byName.get(name);
    if (needsPositiveLevels(col) && !(state.positives[name]?.length > 0)) {
      errors.push(`Outcome "${name}" is categorical — pick the positive (top-box) levels.`);
    }
    if (col && (col.kind === "datetime" || col.kind === "empty")) errors.push(`Outcome "${name}" has kind ${col.kind} and cannot be analysed.`);
  }

  const model = columnsWithRole(state, "model", "model_matching");
  const matching = columnsWithRole(state, "matching", "model_matching");
  const effectiveModel = new Set([...model, ...(o.include_matching_in_model ? matching : [])]);
  if (effectiveModel.size === 0) {
    errors.push(
      matching.length && !o.include_matching_in_model
        ? "The propensity model has no features: add model features or enable “include matching features in model”."
        : "Choose at least one model or matching feature for the propensity model.",
    );
  }
  for (const name of [...model, ...matching]) {
    const col = byName.get(name);
    if (col && UNUSABLE_KINDS.has(col.kind)) errors.push(`Feature "${name}" has kind ${col.kind} and cannot be used.`);
  }
  for (const name of matching) {
    const col = byName.get(name);
    if (col && col.kind === "categorical" && col.n_unique > 30)
      warnings.push(`Matching feature "${name}" has ${col.n_unique} levels — exact matching strata may become very sparse.`);
  }
  if (matching.length > 4 && o.methods.includes("nn_matching"))
    warnings.push(`${matching.length} matching features create many exact-match strata; some exposed respondents may go unmatched.`);

  if (o.methods.length === 0) errors.push("Select at least one adjustment method.");
  if (!Number.isInteger(o.match_ratio) || o.match_ratio < 1 || o.match_ratio > 10) errors.push("Match ratio must be an integer between 1 and 10.");
  if (!Number.isInteger(o.n_strata) || o.n_strata < 2 || o.n_strata > 20) errors.push("Number of strata must be an integer between 2 and 20.");
  if (!Number.isInteger(o.n_bootstrap) || o.n_bootstrap < 0 || o.n_bootstrap > 2000) errors.push("Bootstrap replicates must be an integer between 0 and 2000.");
  if (!(o.alpha > 0 && o.alpha < 0.5)) errors.push("Alpha must be between 0 and 0.5 (e.g. 0.05).");
  if (o.useCaliper && !(o.caliper > 0)) errors.push("Caliper must be greater than 0 (or disable the caliper).");
  if (o.useWeightClip && !(o.weight_clip > 0.5 && o.weight_clip <= 1)) errors.push("Weight clip quantile must be between 0.5 and 1.");
  if (!Number.isInteger(o.random_state)) errors.push("Random seed must be an integer.");
  if (o.n_bootstrap > 500) warnings.push(`${o.n_bootstrap} bootstrap replicates may take a while.`);
  if (o.estimand === "ATE" && o.methods.includes("overlap_weights"))
    warnings.push("Overlap weights always estimate the ATO (overlap population), regardless of the estimand setting.");

  return { errors, warnings };
}

/** Build the AnalysisConfig payload from the UI state. Does not validate. */
export function buildAnalysisConfig(profile: DatasetProfile, state: ConfigState): AnalysisConfig {
  const byName = new Map(profile.columns.map((c) => [c.name, c]));
  // preserve original column order
  const ordered = (roles: ColumnRole[]) =>
    profile.columns.filter((c) => roles.includes(state.columns[c.name]?.role ?? "ignore")).map((c) => c.name);

  const treatment_column = ordered(["treatment"])[0] ?? "";
  const tcol = byName.get(treatment_column);
  const outcome_columns = ordered(["outcome"]);
  const model_features = ordered(["model", "model_matching"]);
  const matching_features = ordered(["matching", "model_matching"]);
  const subgroup_columns = profile.columns
    .filter((c) => {
      const s = state.columns[c.name];
      if (!s) return false;
      if (s.role === "subgroup") return true;
      return s.subgroup && s.role !== "treatment" && s.role !== "outcome";
    })
    .map((c) => c.name);

  const outcome_positive_values: Record<string, Scalar[]> = {};
  for (const name of outcome_columns) {
    const keys = state.positives[name];
    if (keys && keys.length) outcome_positive_values[name] = resolveValues(byName.get(name), keys);
  }

  const o = state.options;
  const name = o.name.trim();
  return {
    dataset_id: profile.dataset_id,
    sheet: profile.sheet,
    name: name === "" ? null : name,
    treatment_column,
    exposed_values: resolveValues(tcol, state.treatment.exposed),
    control_values:
      state.treatment.controlMode === "explicit" ? resolveValues(tcol, state.treatment.control) : null,
    outcome_columns,
    outcome_positive_values,
    model_features,
    matching_features,
    include_matching_in_model: o.include_matching_in_model,
    subgroup_columns,
    model_type: o.model_type,
    methods: [...o.methods],
    estimand: o.estimand,
    caliper: o.useCaliper ? o.caliper : null,
    match_ratio: o.match_ratio,
    replacement: o.replacement,
    weight_clip: o.useWeightClip ? o.weight_clip : null,
    n_strata: o.n_strata,
    trim: o.trim,
    missing_strategy: o.missing_strategy,
    n_bootstrap: o.n_bootstrap,
    alpha: o.alpha,
    random_state: o.random_state,
  };
}

/** Initial full state for a dataset profile. */
export function initialConfigState(profile: DatasetProfile): ConfigState {
  const columns = initialRoles(profile);
  const tname = Object.entries(columns).find(([, s]) => s.role === "treatment")?.[0];
  const tcol = profile.columns.find((c) => c.name === tname);
  const positives: Record<string, string[]> = {};
  return {
    columns,
    treatment: defaultTreatmentState(tcol),
    positives,
    options: { ...DEFAULT_OPTIONS, methods: [...DEFAULT_OPTIONS.methods] },
  };
}

/** Assign a role to many columns at once; enforces a single treatment column. */
export function assignRole(
  columns: Record<string, ColumnState>,
  names: string[],
  role: ColumnRole,
): Record<string, ColumnState> {
  const next = { ...columns };
  if (role === "treatment") {
    // only the first selected becomes treatment; any previous treatment is demoted
    for (const [n, s] of Object.entries(next)) if (s.role === "treatment") next[n] = { ...s, role: "ignore" };
    const first = names[0];
    if (first !== undefined) next[first] = { role: "treatment", subgroup: false };
    return next;
  }
  for (const n of names) {
    const prev = next[n] ?? { role: "ignore", subgroup: false };
    next[n] = { role, subgroup: role === "outcome" ? false : prev.subgroup };
  }
  return next;
}
