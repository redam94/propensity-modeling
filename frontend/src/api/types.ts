/**
 * 1:1 mirror of packages/propensity_lift/src/propensity_lift/schemas.py.
 * snake_case is preserved; Literal -> string union; Optional -> `| null`.
 * Fields with pydantic defaults are always serialised by the backend, so they
 * are declared non-optional here (except in AnalysisConfig, which the client
 * constructs and where defaults may be omitted).
 */

export type Scalar = string | number | boolean;

export type ColumnKind = "numeric" | "binary" | "categorical" | "datetime" | "text" | "empty";
export type ModelType = "logistic" | "gradient_boosting" | "random_forest";
export type Method = "nn_matching" | "ipw" | "overlap_weights" | "stratification";
export type Estimand = "ATT" | "ATE";
export type TrimRule = "none" | "common_support" | "crump";
export type OutcomeType = "binary" | "continuous";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type SupportRegion = "control_only" | "both" | "exposed_only";
export type SuggestedRole =
  | "treatment"
  | "outcome"
  | "model_feature"
  | "matching_feature"
  | "id"
  | "ignore";
export type FeatureRole = "model" | "matching" | "both";
export type MissingStrategy = "impute" | "drop";
export type CiMethod = "bootstrap" | "analytic";

// --------------------------------------------------------------------------- //
// Dataset profiling
// --------------------------------------------------------------------------- //
export interface ValueCount {
  value: Scalar;
  count: number;
}

export interface ColumnProfile {
  name: string;
  kind: ColumnKind;
  n_missing: number;
  n_unique: number;
  top_values: ValueCount[];
  min: number | null;
  max: number | null;
  mean: number | null;
  suggested_role: SuggestedRole | null;
}

export interface DatasetProfile {
  dataset_id: string;
  filename: string;
  sheet_names: string[];
  sheet: string | null;
  n_rows: number;
  n_cols: number;
  columns: ColumnProfile[];
}

// --------------------------------------------------------------------------- //
// Analysis configuration
// --------------------------------------------------------------------------- //
export interface AnalysisConfig {
  dataset_id: string;
  sheet?: string | null;
  name?: string | null;

  treatment_column: string;
  exposed_values: Scalar[];
  control_values?: Scalar[] | null;

  outcome_columns: string[];
  outcome_positive_values?: Record<string, Scalar[]>;

  model_features?: string[];
  matching_features?: string[];
  include_matching_in_model?: boolean;
  subgroup_columns?: string[];

  model_type?: ModelType;
  methods?: Method[];
  estimand?: Estimand;

  caliper?: number | null;
  match_ratio?: number;
  replacement?: boolean;
  weight_clip?: number | null;
  n_strata?: number;

  trim?: TrimRule;
  missing_strategy?: MissingStrategy;
  n_bootstrap?: number;
  alpha?: number;
  random_state?: number;
}

// --------------------------------------------------------------------------- //
// Results
// --------------------------------------------------------------------------- //
export interface Quantiles {
  min: number;
  p05: number;
  p25: number;
  median: number;
  p75: number;
  p95: number;
  max: number;
  mean: number;
}

export interface Histogram {
  edges: number[];
  exposed_counts: number[];
  control_counts: number[];
  exposed_density: number[];
  control_density: number[];
}

export interface DensityCurve {
  x: number[];
  exposed: number[];
  control: number[];
}

export interface RegionCount {
  region: SupportRegion;
  lower: number;
  upper: number;
  n_exposed: number;
  n_control: number;
  pct_exposed: number;
  pct_control: number;
}

export interface OverlapSummary {
  histogram: Histogram;
  density: DensityCurve;
  exposed_quantiles: Quantiles;
  control_quantiles: Quantiles;
  common_support_lower: number;
  common_support_upper: number;
  regions: RegionCount[];
  overlap_coefficient: number;
  n_trimmed_exposed: number;
  n_trimmed_control: number;
}

export interface LevelShare {
  level: string;
  n_exposed: number;
  n_control: number;
  pct_exposed: number;
  pct_control: number;
}

export interface FeatureOverlap {
  feature: string;
  role: FeatureRole;
  kind: ColumnKind;
  overlap_coefficient: number;
  pct_exposed_unsupported: number;
  pct_control_unsupported: number;
  exposed_only_levels: string[];
  control_only_levels: string[];
  levels: LevelShare[];
  histogram: Histogram | null;
  exposed_range: number[] | null;
  control_range: number[] | null;
}

export interface FeatureImportance {
  feature: string;
  importance: number;
}

export interface ModelSummary {
  model_type: ModelType;
  auc: number;
  n_encoded_features: number;
  feature_importance: FeatureImportance[];
  /** [[mean_pred, observed_rate, n], ...] */
  calibration: number[][];
}

export interface BalanceRow {
  variable: string;
  source_feature: string;
  role: FeatureRole;
  mean_exposed_before: number;
  mean_control_before: number;
  smd_before: number;
  var_ratio_before: number | null;
  mean_exposed_after: number;
  mean_control_after: number;
  smd_after: number;
  var_ratio_after: number | null;
}

export interface BalanceSummary {
  max_abs_smd_before: number;
  max_abs_smd_after: number;
  mean_abs_smd_before: number;
  mean_abs_smd_after: number;
  n_imbalanced_before: number;
  n_imbalanced_after: number;
}

export interface OutcomeContrast {
  outcome: string;
  outcome_type: OutcomeType;
  n_exposed: number;
  n_control: number;
  effective_n_control: number;
  exposed_mean: number;
  control_mean_raw: number;
  control_mean_adjusted: number;
  raw_diff: number;
  lift: number;
  relative_lift: number | null;
  se: number;
  ci_low: number;
  ci_high: number;
  p_value: number;
  significant: boolean;
  ci_method: CiMethod;
}

export interface SubgroupContrast extends OutcomeContrast {
  subgroup_column: string;
  subgroup_level: string;
}

export interface MatchingInfo {
  n_exposed_matched: number;
  n_exposed_unmatched: number;
  n_unique_controls_used: number;
  caliper_abs: number | null;
  n_exact_strata: number;
}

export interface WeightSummary {
  min: number;
  max: number;
  mean: number;
  n_clipped: number;
  ess_exposed: number;
  ess_control: number;
}

export interface MethodResult {
  method: Method;
  label: string;
  estimand: Estimand;
  n_exposed_used: number;
  n_control_used: number;
  balance: BalanceRow[];
  balance_summary: BalanceSummary;
  contrasts: OutcomeContrast[];
  subgroups: SubgroupContrast[];
  matching: MatchingInfo | null;
  weights: WeightSummary | null;
  adjusted_ps_histogram: Histogram | null;
  warnings: string[];
}

export interface SampleSummary {
  n_rows_input: number;
  n_exposed: number;
  n_control: number;
  n_dropped_treatment_missing: number;
  n_dropped_feature_missing: number;
  n_analysed_exposed: number;
  n_analysed_control: number;
}

export interface AnalysisResult {
  analysis_id: string;
  config: AnalysisConfig;
  /** ISO-8601 datetime */
  created_at: string;
  duration_seconds: number;
  sample: SampleSummary;
  model: ModelSummary;
  overlap: OverlapSummary;
  feature_overlap: FeatureOverlap[];
  methods: MethodResult[];
  warnings: string[];
}

// --------------------------------------------------------------------------- //
// Job API envelopes
// --------------------------------------------------------------------------- //
export interface JobInfo {
  analysis_id: string;
  name: string | null;
  dataset_id: string;
  status: JobStatus;
  progress: number;
  stage: string | null;
  submitted_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

export interface JobDetail extends JobInfo {
  result: AnalysisResult | null;
}

export interface AnalysisSubmitted {
  analysis_id: string;
  status: JobStatus;
}

export interface HealthResponse {
  status: string;
  workers: number;
}
