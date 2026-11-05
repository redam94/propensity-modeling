"""Picklable fake job functions for the process pool (imported by spawned workers).

Behaviour is driven by ``config.name``:

* ``"sleep:<seconds>"``   sleep in small steps (reporting progress, so cancellation works)
* ``"fail:value"``        raise ValueError (message must be shown verbatim)
* ``"fail:runtime"``      raise ZeroDivisionError (shown as "ZeroDivisionError: ...")
* ``"fail:crash"``        hard-exit the worker process (BrokenProcessPool)
* ``"crash-after:<s>"``   report progress, sleep ``s`` seconds, then hard-exit the worker
* anything else           return immediately
"""

from __future__ import annotations

import os
import time
from datetime import datetime, timezone

from app.worker import execute
from propensity_lift.schemas import (
    AnalysisResult,
    BalanceRow,
    BalanceSummary,
    DensityCurve,
    FeatureImportance,
    FeatureOverlap,
    Histogram,
    LevelShare,
    MethodResult,
    ModelSummary,
    OutcomeContrast,
    OverlapSummary,
    Quantiles,
    RegionCount,
    SampleSummary,
    SubgroupContrast,
)


def _hist() -> Histogram:
    return Histogram(
        edges=[0.0, 0.5, 1.0],
        exposed_counts=[3, 7],
        control_counts=[8, 2],
        exposed_density=[0.6, 1.4],
        control_density=[1.6, 0.4],
    )


def _q() -> Quantiles:
    return Quantiles(min=0.0, p05=0.1, p25=0.3, median=0.5, p75=0.7, p95=0.9, max=1.0, mean=0.5)


def _contrast(outcome: str) -> dict:
    return dict(
        outcome=outcome, outcome_type="binary", n_exposed=10, n_control=10, effective_n_control=9.5,
        exposed_mean=0.6, control_mean_raw=0.4, control_mean_adjusted=0.45, raw_diff=0.2, lift=0.15,
        relative_lift=33.3, se=0.05, ci_low=0.05, ci_high=0.25, p_value=0.003, significant=True,
        ci_method="analytic",
    )


def fake_result(df, config, analysis_id):
    feature = (config.model_features or config.matching_features or ["x"])[0]
    method = MethodResult(
        method="ipw",
        label="IPW (ATT)",
        estimand=config.estimand,
        n_exposed_used=10,
        n_control_used=10,
        balance=[
            BalanceRow(
                variable=feature, source_feature=feature, role="model", mean_exposed_before=1.0,
                mean_control_before=0.5, smd_before=0.4, var_ratio_before=1.1, mean_exposed_after=1.0,
                mean_control_after=0.95, smd_after=0.02, var_ratio_after=1.0,
            )
        ],
        balance_summary=BalanceSummary(
            max_abs_smd_before=0.4, max_abs_smd_after=0.02, mean_abs_smd_before=0.4,
            mean_abs_smd_after=0.02, n_imbalanced_before=1, n_imbalanced_after=0,
        ),
        contrasts=[OutcomeContrast(**_contrast(o)) for o in config.outcome_columns],
        subgroups=[
            SubgroupContrast(subgroup_column="region", subgroup_level="North", **_contrast(config.outcome_columns[0]))
        ],
        adjusted_ps_histogram=_hist(),
    )
    return AnalysisResult(
        analysis_id=analysis_id,
        config=config,
        created_at=datetime.now(timezone.utc),
        duration_seconds=0.1,
        sample=SampleSummary(
            n_rows_input=len(df), n_exposed=10, n_control=10, n_dropped_treatment_missing=0,
            n_dropped_feature_missing=0, n_analysed_exposed=10, n_analysed_control=10,
        ),
        model=ModelSummary(
            model_type=config.model_type, auc=0.7, n_encoded_features=1,
            feature_importance=[FeatureImportance(feature=feature, importance=1.0)],
            calibration=[[0.2, 0.25, 10.0], [0.8, 0.75, 10.0]],
        ),
        overlap=OverlapSummary(
            histogram=_hist(),
            density=DensityCurve(x=[0.0, 0.5, 1.0], exposed=[0.1, 1.0, 0.2], control=[0.3, 1.0, 0.1]),
            exposed_quantiles=_q(),
            control_quantiles=_q(),
            common_support_lower=0.05,
            common_support_upper=0.95,
            regions=[
                RegionCount(region="control_only", lower=0.0, upper=0.05, n_exposed=0, n_control=2, pct_exposed=0, pct_control=20),
                RegionCount(region="both", lower=0.05, upper=0.95, n_exposed=9, n_control=8, pct_exposed=90, pct_control=80),
                RegionCount(region="exposed_only", lower=0.95, upper=1.0, n_exposed=1, n_control=0, pct_exposed=10, pct_control=0),
            ],
            overlap_coefficient=0.8,
            n_trimmed_exposed=0,
            n_trimmed_control=0,
        ),
        feature_overlap=[
            FeatureOverlap(
                feature=feature, role="model", kind="categorical", overlap_coefficient=0.9,
                pct_exposed_unsupported=0.0, pct_control_unsupported=5.0, control_only_levels=["West"],
                levels=[LevelShare(level="North", n_exposed=5, n_control=4, pct_exposed=50, pct_control=40)],
            )
        ],
        methods=[method],
        warnings=["fake result"],
    )


def fake_analysis(df, config, analysis_id=None, progress=None):
    name = config.name or ""
    if name.startswith("sleep:"):
        seconds = float(name.split(":", 1)[1])
        steps = max(1, int(seconds / 0.05))
        for i in range(steps):
            time.sleep(seconds / steps)
            if progress:
                progress(0.05 + 0.9 * i / steps, "sleeping")
    elif name == "fail:value":
        raise ValueError("Treatment column has only one level after filtering.")
    elif name == "fail:runtime":
        return 1 / 0
    elif name == "fail:crash":
        os._exit(13)
    elif name.startswith("crash-after:"):
        if progress:
            progress(0.1, "about to crash")
        time.sleep(float(name.split(":", 1)[1]))
        os._exit(13)
    return fake_result(df, config, analysis_id)


def fake_job(analysis_id, config_json, data_path, progress_dict):
    return execute(analysis_id, config_json, data_path, progress_dict, analysis_fn=fake_analysis)
