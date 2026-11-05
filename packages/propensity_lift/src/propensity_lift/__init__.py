"""propensity_lift — propensity score modeling & brand lift analysis."""

from .io import list_sheets, load_table, profile_dataframe
from .pipeline import run_analysis
from .sample_data import make_brand_lift_sample
from .schemas import (
    AnalysisConfig,
    AnalysisResult,
    AnalysisSubmitted,
    BalanceRow,
    BalanceSummary,
    ColumnKind,
    ColumnProfile,
    DatasetProfile,
    DensityCurve,
    Estimand,
    FeatureImportance,
    FeatureOverlap,
    Histogram,
    JobDetail,
    JobInfo,
    JobStatus,
    LevelShare,
    MatchingInfo,
    Method,
    MethodResult,
    ModelSummary,
    ModelType,
    OutcomeContrast,
    OutcomeType,
    OverlapSummary,
    Quantiles,
    RegionCount,
    SampleSummary,
    Scalar,
    SubgroupContrast,
    SupportRegion,
    TrimRule,
    ValueCount,
    WeightSummary,
)

__version__ = "0.1.0"

__all__ = [
    "run_analysis", "profile_dataframe", "load_table", "list_sheets", "make_brand_lift_sample",
    "AnalysisConfig", "AnalysisResult", "AnalysisSubmitted", "BalanceRow", "BalanceSummary", "ColumnKind",
    "ColumnProfile", "DatasetProfile", "DensityCurve", "Estimand", "FeatureImportance", "FeatureOverlap",
    "Histogram", "JobDetail", "JobInfo", "JobStatus", "LevelShare", "MatchingInfo", "Method", "MethodResult",
    "ModelSummary", "ModelType", "OutcomeContrast", "OutcomeType", "OverlapSummary", "Quantiles",
    "RegionCount", "SampleSummary", "Scalar", "SubgroupContrast", "SupportRegion", "TrimRule", "ValueCount",
    "WeightSummary", "__version__",
]
