"""Shared data contracts for propensity_lift.

This module is the SINGLE SOURCE OF TRUTH for the shapes exchanged between
the analysis package, the FastAPI backend and the React frontend
(frontend/src/api/types.ts mirrors these models 1:1, snake_case preserved).

Terminology
-----------
* exposed / control  : the two respondent groups, read from ``treatment_column``.
* model_features     : covariates fed to the propensity-score model.
* matching_features  : columns the respondents were (or should be) matched on.
                       Used as EXACT-MATCH strata for nearest-neighbour matching,
                       and always reported in balance / overlap diagnostics.
                       Numeric matching features with > 10 unique values are
                       coarsened into quintiles before exact matching.
* outcome_columns    : brand-lift KPIs (awareness, favourability, consideration,
                       purchase intent ...). Binary outcomes are reported as
                       proportions; others as means.
* overlap / underlap : on the propensity-score scale (and per feature), the
                       region where BOTH groups have support is the overlap;
                       regions where only one group has support are underlap
                       ("exposed_only" = exposed respondents with no comparable
                       controls, "control_only" = controls unlike any exposed).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, Field

Scalar = Union[str, int, float, bool]

ColumnKind = Literal["numeric", "binary", "categorical", "datetime", "text", "empty"]
ModelType = Literal["logistic", "gradient_boosting", "random_forest"]
Method = Literal["nn_matching", "ipw", "overlap_weights", "stratification"]
Estimand = Literal["ATT", "ATE"]
TrimRule = Literal["none", "common_support", "crump"]
OutcomeType = Literal["binary", "continuous"]
JobStatus = Literal["queued", "running", "completed", "failed", "cancelled"]
SupportRegion = Literal["control_only", "both", "exposed_only"]


# --------------------------------------------------------------------------- #
# Dataset profiling
# --------------------------------------------------------------------------- #
class ValueCount(BaseModel):
    value: Scalar
    count: int


class ColumnProfile(BaseModel):
    name: str
    kind: ColumnKind
    n_missing: int
    n_unique: int
    top_values: List[ValueCount] = Field(default_factory=list)  # up to 20, most frequent first
    min: Optional[float] = None  # numeric only
    max: Optional[float] = None
    mean: Optional[float] = None
    suggested_role: Optional[
        Literal["treatment", "outcome", "model_feature", "matching_feature", "id", "ignore"]
    ] = None


class DatasetProfile(BaseModel):
    dataset_id: str
    filename: str
    sheet_names: List[str]          # [] for CSV
    sheet: Optional[str]            # sheet that was profiled
    n_rows: int
    n_cols: int
    columns: List[ColumnProfile]


# --------------------------------------------------------------------------- #
# Analysis configuration
# --------------------------------------------------------------------------- #
class AnalysisConfig(BaseModel):
    dataset_id: str
    sheet: Optional[str] = None
    name: Optional[str] = None                      # user label for the run

    treatment_column: str
    exposed_values: List[Scalar]                    # values meaning "exposed"
    control_values: Optional[List[Scalar]] = None   # None => every other non-missing value is control

    outcome_columns: List[str] = Field(min_length=1)
    # Optional recode of outcomes to binary, e.g. top-2-box:
    # {"purchase_intent": ["Very likely", "Somewhat likely"]} -> 1 if in list else 0
    outcome_positive_values: Dict[str, List[Scalar]] = Field(default_factory=dict)

    model_features: List[str] = Field(default_factory=list)
    matching_features: List[str] = Field(default_factory=list)
    include_matching_in_model: bool = True
    subgroup_columns: List[str] = Field(default_factory=list)

    model_type: ModelType = "logistic"
    methods: List[Method] = Field(default_factory=lambda: ["nn_matching", "ipw"], min_length=1)
    estimand: Estimand = "ATT"

    # matching
    caliper: Optional[float] = 0.2       # in SDs of logit(PS); None = no caliper
    match_ratio: int = Field(1, ge=1, le=10)  # controls per exposed
    replacement: bool = True
    # weighting
    weight_clip: Optional[float] = None  # opt-in cap on IPW weights at this per-group quantile (0.99 = p99); None = no clipping (unbiased)
    n_strata: int = Field(5, ge=2, le=20)  # for stratification

    trim: TrimRule = "none"
    missing_strategy: Literal["impute", "drop"] = "impute"  # for features; rows with missing outcome are dropped per-outcome
    n_bootstrap: int = Field(200, ge=0, le=2000)            # 0 => analytic SEs only
    alpha: float = 0.05
    random_state: int = 42


# --------------------------------------------------------------------------- #
# Results
# --------------------------------------------------------------------------- #
class Quantiles(BaseModel):
    min: float
    p05: float
    p25: float
    median: float
    p75: float
    p95: float
    max: float
    mean: float


class Histogram(BaseModel):
    """Shared bin edges; counts and densities per group (len(edges) == len(counts)+1)."""
    edges: List[float]
    exposed_counts: List[int]
    control_counts: List[int]
    exposed_density: List[float]   # counts / (n * bin_width)
    control_density: List[float]


class DensityCurve(BaseModel):
    x: List[float]
    exposed: List[float]
    control: List[float]


class RegionCount(BaseModel):
    region: SupportRegion
    lower: float
    upper: float
    n_exposed: int
    n_control: int
    pct_exposed: float   # 0-100, share of the exposed group in this region
    pct_control: float


class OverlapSummary(BaseModel):
    """Propensity-score over/underlap (computed on the pre-trim sample)."""
    histogram: Histogram
    density: DensityCurve
    exposed_quantiles: Quantiles
    control_quantiles: Quantiles
    common_support_lower: float      # max(min_exposed, min_control)
    common_support_upper: float      # min(max_exposed, max_control)
    regions: List[RegionCount]       # always 3 rows: control_only, both, exposed_only
    overlap_coefficient: float       # OVL in [0,1], integral of min(densities)
    n_trimmed_exposed: int           # removed by the trim rule (0 if trim == "none")
    n_trimmed_control: int


class LevelShare(BaseModel):
    level: str
    n_exposed: int
    n_control: int
    pct_exposed: float   # 0-100 within group
    pct_control: float


class FeatureOverlap(BaseModel):
    """Raw-data over/underlap for one model or matching feature."""
    feature: str
    role: Literal["model", "matching", "both"]
    kind: ColumnKind
    overlap_coefficient: float               # OVL of the two empirical distributions
    pct_exposed_unsupported: float           # % exposed whose value never occurs / is outside control range
    pct_control_unsupported: float
    exposed_only_levels: List[str] = Field(default_factory=list)   # categorical underlap
    control_only_levels: List[str] = Field(default_factory=list)
    levels: List[LevelShare] = Field(default_factory=list)          # categorical (top 30 levels)
    histogram: Optional[Histogram] = None                           # numeric
    exposed_range: Optional[List[float]] = None                     # numeric [min, max]
    control_range: Optional[List[float]] = None


class FeatureImportance(BaseModel):
    feature: str        # source column name (encoded dummies are aggregated back)
    importance: float   # abs standardized coef (logistic) or impurity importance, normalised to sum 1


class ModelSummary(BaseModel):
    model_type: ModelType
    auc: float
    n_encoded_features: int
    feature_importance: List[FeatureImportance]
    calibration: List[List[float]] = Field(default_factory=list)  # [[mean_pred, observed_rate, n], ...] deciles


class BalanceRow(BaseModel):
    variable: str        # encoded variable, e.g. "age" or "region=North"
    source_feature: str  # original column
    role: Literal["model", "matching", "both"]
    mean_exposed_before: float
    mean_control_before: float
    smd_before: float
    var_ratio_before: Optional[float] = None   # numeric (non-dummy) variables only
    mean_exposed_after: float
    mean_control_after: float
    smd_after: float
    var_ratio_after: Optional[float] = None


class BalanceSummary(BaseModel):
    max_abs_smd_before: float
    max_abs_smd_after: float
    mean_abs_smd_before: float
    mean_abs_smd_after: float
    n_imbalanced_before: int   # |SMD| > 0.1
    n_imbalanced_after: int


class OutcomeContrast(BaseModel):
    outcome: str
    outcome_type: OutcomeType
    n_exposed: int
    n_control: int
    effective_n_control: float          # Kish ESS for weighted methods, matched n otherwise
    exposed_mean: float                 # proportion (0-1) for binary
    control_mean_raw: float
    control_mean_adjusted: float        # counterfactual control mean after adjustment
    raw_diff: float                     # exposed_mean - control_mean_raw
    lift: float                         # absolute lift: exposed_mean(adj) - control_mean_adjusted
    relative_lift: Optional[float]      # lift / control_mean_adjusted * 100 (None if control mean == 0)
    se: float
    ci_low: float                       # CI on absolute lift
    ci_high: float
    p_value: float
    significant: bool
    ci_method: Literal["bootstrap", "analytic"]


class SubgroupContrast(OutcomeContrast):
    subgroup_column: str
    subgroup_level: str


class MatchingInfo(BaseModel):
    n_exposed_matched: int
    n_exposed_unmatched: int
    n_unique_controls_used: int
    caliper_abs: Optional[float]        # caliper on logit scale actually used
    n_exact_strata: int


class WeightSummary(BaseModel):
    min: float
    max: float
    mean: float
    n_clipped: int
    ess_exposed: float
    ess_control: float


class MethodResult(BaseModel):
    method: Method
    label: str                          # human readable, e.g. "1:1 NN matching (caliper 0.2)"
    estimand: Estimand
    n_exposed_used: int
    n_control_used: int
    balance: List[BalanceRow]
    balance_summary: BalanceSummary
    contrasts: List[OutcomeContrast]
    subgroups: List[SubgroupContrast] = Field(default_factory=list)
    matching: Optional[MatchingInfo] = None
    weights: Optional[WeightSummary] = None
    adjusted_ps_histogram: Optional[Histogram] = None   # PS distribution after matching/weighting
    warnings: List[str] = Field(default_factory=list)


class SampleSummary(BaseModel):
    n_rows_input: int
    n_exposed: int
    n_control: int
    n_dropped_treatment_missing: int    # treatment value missing / in neither group
    n_dropped_feature_missing: int      # only when missing_strategy == "drop"
    n_analysed_exposed: int             # after trimming
    n_analysed_control: int


class AnalysisResult(BaseModel):
    analysis_id: str
    config: AnalysisConfig
    created_at: datetime
    duration_seconds: float
    sample: SampleSummary
    model: ModelSummary
    overlap: OverlapSummary
    feature_overlap: List[FeatureOverlap]
    methods: List[MethodResult]
    warnings: List[str] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Job API envelopes (backend)
# --------------------------------------------------------------------------- #
class JobInfo(BaseModel):
    analysis_id: str
    name: Optional[str] = None
    dataset_id: str
    status: JobStatus
    progress: float = 0.0               # 0-1, coarse stage progress
    stage: Optional[str] = None         # e.g. "fitting model", "matching", "bootstrapping"
    submitted_at: datetime
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    error: Optional[str] = None


class JobDetail(JobInfo):
    result: Optional[AnalysisResult] = None


class AnalysisSubmitted(BaseModel):
    analysis_id: str
    status: JobStatus

