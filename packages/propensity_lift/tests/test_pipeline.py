import json
import math
import time

import numpy as np
import pytest

from propensity_lift import AnalysisResult, run_analysis
from propensity_lift.cli import main as cli_main
from propensity_lift.sample_data import TRUE_EFFECTS

from propensity_lift.sample_data import sample_analysis_config


def make_config(**overrides):
    overrides.setdefault("n_bootstrap", 30)
    return sample_analysis_config(**overrides)


def _no_nan(obj):
    if isinstance(obj, float):
        assert math.isfinite(obj)
    elif isinstance(obj, dict):
        for v in obj.values():
            _no_nan(v)
    elif isinstance(obj, list):
        for v in obj:
            _no_nan(v)


def _check_result(res: AnalysisResult, cfg):
    text = res.model_dump_json()
    assert "NaN" not in text and "Infinity" not in text
    data = json.loads(text)
    _no_nan(data)
    AnalysisResult.model_validate_json(text)  # round-trips
    assert [m.method for m in res.methods] == list(cfg.methods)
    for m in res.methods:
        assert len(m.contrasts) == len(cfg.outcome_columns)
        assert m.balance and m.adjusted_ps_histogram is not None
    assert len(res.overlap.regions) == 3
    assert {f.feature for f in res.feature_overlap} >= set(cfg.matching_features)


@pytest.mark.parametrize("model_type", ["logistic", "gradient_boosting", "random_forest"])
def test_pipeline_all_methods_every_model(sample_df, model_type):
    cfg = make_config(model_type=model_type, n_bootstrap=20)
    stages = []
    res = run_analysis(sample_df, cfg, analysis_id="abc", progress=lambda f, s: stages.append((f, s)))
    _check_result(res, cfg)
    assert res.analysis_id == "abc" and res.model.model_type == model_type
    assert 0.5 < res.model.auc < 1
    fr = [f for f, _ in stages]
    assert fr[0] == 0.0 and fr[-1] == 1.0 and all(0 <= f <= 1 for f in fr)
    assert fr == sorted(fr)
    assert any("bootstrapping" in s for _, s in stages)


@pytest.mark.parametrize(
    "overrides",
    [
        dict(estimand="ATE"),
        dict(replacement=False, match_ratio=3, caliper=None),
        dict(trim="common_support", weight_clip=None),
        dict(trim="crump", estimand="ATE", replacement=False),
        dict(missing_strategy="drop", include_matching_in_model=False, n_bootstrap=0),
        dict(control_values=None, matching_features=[], subgroup_columns=["age_band", "region", "age"]),
    ],
)
def test_pipeline_option_variants(sample_df, overrides):
    cfg = make_config(**overrides)
    res = run_analysis(sample_df, cfg)
    _check_result(res, cfg)
    if overrides.get("missing_strategy") == "drop":
        assert res.sample.n_dropped_feature_missing > 0
        roles = {f.feature: f.role for f in res.feature_overlap}
        assert roles["gender"] == "matching"
    if overrides.get("trim") == "common_support":
        assert res.sample.n_analysed_exposed <= res.sample.n_exposed


def test_sample_effects_and_confounding(sample_df):
    cfg = make_config(n_bootstrap=100, methods=["ipw", "nn_matching"])
    res = run_analysis(sample_df, cfg)
    for m in res.methods:
        by = {c.outcome: c for c in m.contrasts}
        for o in ["aided_awareness", "favorability", "ad_recall"]:
            assert by[o].lift > 0 and by[o].significant, (m.method, o)
        assert not by["unaided_awareness"].significant or abs(by["unaided_awareness"].lift) < 0.06
        # confounding: raw diff overstates the effect
        assert by["aided_awareness"].raw_diff > by["aided_awareness"].lift
        assert by["unaided_awareness"].raw_diff > by["unaided_awareness"].lift
        assert by["favorability"].outcome_type == "continuous"
        assert by["purchase_intent"].outcome_type == "binary"
        assert m.balance_summary.max_abs_smd_after < m.balance_summary.max_abs_smd_before
    assert TRUE_EFFECTS["unaided_awareness"] == 0


def test_subgroups(sample_df):
    df = sample_df.copy()
    df.loc[df.index[:30], "gender"] = "Tiny"  # too small a level
    df.loc[df.index[:30], "group"] = "Exposed"
    cfg = make_config(methods=["ipw"], subgroup_columns=["gender"], n_bootstrap=10)
    res = run_analysis(df, cfg)
    sg = res.methods[0].subgroups
    levels = {s.subgroup_level for s in sg}
    assert levels == {"Female", "Male", "Non-binary"}
    assert all(s.subgroup_column == "gender" for s in sg)
    assert len(sg) == 3 * len(cfg.outcome_columns)
    assert any("gender=Tiny" in w for w in res.warnings)


def test_determinism(small_df):
    cfg = make_config(n_bootstrap=25)
    a = run_analysis(small_df, cfg, analysis_id="x").model_dump()
    b = run_analysis(small_df, cfg, analysis_id="x").model_dump()
    for d in (a, b):
        d.pop("created_at"), d.pop("duration_seconds")
    assert a == b


def test_numeric_treatment_from_excel_floats(small_df):
    df = small_df.copy()
    df["exposed_flag"] = np.where(df.group == "Exposed", 1.0, 0.0)
    cfg = make_config(treatment_column="exposed_flag", exposed_values=[1], control_values=["0"],
                      methods=["ipw"], n_bootstrap=0)
    res = run_analysis(df, cfg)
    assert res.sample.n_exposed == int((df.group == "Exposed").sum())


def test_missing_treatment_rows_dropped(small_df):
    df = small_df.copy()
    df.loc[df.index[:7], "group"] = None
    df.loc[df.index[7:10], "group"] = "Unknown"
    res = run_analysis(df, make_config(methods=["ipw"], n_bootstrap=0))
    assert res.sample.n_dropped_treatment_missing == 10
    assert res.sample.n_exposed + res.sample.n_control == len(df) - 10


def test_errors(small_df):
    with pytest.raises(ValueError, match="not found"):
        run_analysis(small_df, make_config(model_features=["nope"]))
    with pytest.raises(ValueError, match="exposed"):
        run_analysis(small_df, make_config(exposed_values=["Nobody"]))
    with pytest.raises(ValueError, match="outcome_positive_values"):
        run_analysis(small_df, make_config(outcome_positive_values={}))


def test_speed_large(sample_df):
    from propensity_lift import make_brand_lift_sample

    df = make_brand_lift_sample(n=5000, seed=3)
    cfg = make_config(methods=["nn_matching", "ipw"], n_bootstrap=200)
    t0 = time.perf_counter()
    run_analysis(df, cfg)
    assert time.perf_counter() - t0 < 60


def test_cli(tmp_path, small_df, capsys):
    p = tmp_path / "d.csv"
    small_df.to_csv(p, index=False)
    assert cli_main(["profile", str(p)]) == 0
    prof = json.loads(capsys.readouterr().out)
    assert prof["n_rows"] == len(small_df)
    cfg = make_config(methods=["ipw"], n_bootstrap=5).model_dump()
    cfgp = tmp_path / "cfg.json"
    cfgp.write_text(json.dumps(cfg))
    out = tmp_path / "res.json"
    assert cli_main(["run", str(p), "--config", str(cfgp), "--out", str(out), "--quiet"]) == 0
    AnalysisResult.model_validate_json(out.read_text())
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({**cfg, "treatment_column": "missing_col"}))
    assert cli_main(["run", str(p), "--config", str(bad), "--quiet"]) == 2
