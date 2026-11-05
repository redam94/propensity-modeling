"""Regression tests for statistical review findings (ties in matching, outcome coding,
bootstrap PS refits, IPW clipping visibility, subgroup ordering, control pooling)."""

import numpy as np
import pandas as pd

from propensity_lift import models, pipeline
from propensity_lift.pipeline import _natural_key, run_analysis
from propensity_lift.schemas import AnalysisConfig


def _cat_df(n=2000, seed=7):
    rng = np.random.default_rng(seed)
    age = rng.choice(["18-34", "35-54", "55+"], n)
    sex = rng.choice(["M", "F"], n)
    lin = -0.2 + 0.6 * (age == "18-34") - 0.4 * (age == "55+") + 0.3 * (sex == "F")
    t = rng.random(n) < 1 / (1 + np.exp(-lin))
    y = (rng.random(n) < 0.3 + 0.1 * (age == "18-34") + 0.10 * t).astype(int)
    return pd.DataFrame(dict(exp=np.where(t, "Exposed", "Control"), age=age, sex=sex, y=y))


def _cfg(**kw):
    base = dict(dataset_id="x", treatment_column="exp", exposed_values=["Exposed"], outcome_columns=["y"],
                model_features=["age", "sex"], n_bootstrap=0)
    base.update(kw)
    return AnalysisConfig(**base)


def test_default_weight_clip_is_off():
    assert _cfg().weight_clip is None


def test_matching_with_categorical_ps_uses_all_tied_controls():
    df = _cat_df()
    res = run_analysis(df, _cfg(methods=["nn_matching", "ipw"], match_ratio=1))
    mm, ipw = res.methods
    n_c = int((df.exp == "Control").sum())
    # every control in a PS cell with exposed respondents is used -> essentially all controls
    assert mm.matching.n_unique_controls_used > 0.9 * n_c
    assert mm.weights.ess_control > 0.5 * n_c
    # matching within tied PS cells is close to IPW
    assert abs(mm.contrasts[0].lift - ipw.contrasts[0].lift) < 0.01  # both ~ cell reweighting


def test_matching_warns_when_few_controls_used():
    rng = np.random.default_rng(0)
    n = 400
    x = rng.normal(size=n)
    t = np.r_[np.ones(300, bool), np.zeros(100, bool)]
    x[~t] = np.r_[np.full(3, 0.0), np.full(97, 50.0)]  # only 3 controls anywhere near the exposed
    x[t] = rng.normal(0, 0.01, 300)
    df = pd.DataFrame(dict(exp=np.where(t, "Exposed", "Control"), x=x, y=rng.normal(size=n)))
    res = run_analysis(df, _cfg(model_features=["x"], methods=["nn_matching"], caliper=None))
    assert any("distinct controls used" in w for w in res.methods[0].warnings)


def test_bootstrap_refits_ps_for_weighting_only(monkeypatch):
    calls = {"n": 0}
    orig = models.fit_propensity

    def counting(*a, **k):
        calls["n"] += 1
        return orig(*a, **k)

    monkeypatch.setattr(pipeline, "fit_propensity", counting)
    df = _cat_df(600)
    run_analysis(df, _cfg(methods=["nn_matching"], n_bootstrap=7))
    assert calls["n"] == 1
    calls["n"] = 0
    run_analysis(df, _cfg(methods=["ipw", "overlap_weights"], n_bootstrap=7))
    assert calls["n"] == 1 + 2 * 7


def test_analytic_se_carries_caveat():
    res = run_analysis(_cat_df(600), _cfg(methods=["ipw"], n_bootstrap=0))
    assert any("Analytic SEs" in w for w in res.methods[0].warnings)


def test_ipw_clipping_shift_is_reported():
    rng = np.random.default_rng(1)
    n = 3000
    x = rng.normal(size=n)
    t = rng.random(n) < 1 / (1 + np.exp(-(-0.3 + 1.5 * x)))
    y = 2 * x + 1.0 * t + rng.normal(size=n)
    df = pd.DataFrame(dict(exp=np.where(t, "Exposed", "Control"), x=x, y=y))
    res = run_analysis(df, _cfg(model_features=["x"], methods=["ipw"], weight_clip=0.9))
    assert any("clipping at p90 shifted the y estimate" in w for w in res.methods[0].warnings)
    res = run_analysis(df, _cfg(model_features=["x"], methods=["ipw"]))
    assert not any("clipping" in w for w in res.methods[0].warnings)


def test_spss_coded_outcome_not_flipped():
    df = _cat_df(600)
    df["aware"] = np.where(df.y == 1, 1, 2)  # 1=Yes, 2=No
    res = run_analysis(df, _cfg(outcome_columns=["aware"], methods=["ipw"]))
    c = res.methods[0].contrasts[0]
    assert c.outcome_type == "continuous"
    assert any("two numeric levels" in w for w in res.warnings)
    res = run_analysis(df, _cfg(outcome_columns=["aware"], methods=["ipw"],
                                outcome_positive_values={"aware": [1]}))
    c2 = res.methods[0].contrasts[0]
    assert c2.outcome_type == "binary" and np.isclose(c2.lift, -c.lift)


def test_natural_key_orders_negative_bins():
    levels = ["(0.219, 0.846]", "(0.846, 3.066]", "(-0.315, 0.219]", "(-0.851, -0.315]", "(-3.9, -0.851]",
              "(missing)"]
    assert sorted(levels, key=_natural_key) == [
        "(-3.9, -0.851]", "(-0.851, -0.315]", "(-0.315, 0.219]", "(0.219, 0.846]", "(0.846, 3.066]", "(missing)"]
    assert sorted(["55+", "18-24", "25-34", "100+"], key=_natural_key) == ["18-24", "25-34", "55+", "100+"]


def test_pooled_control_levels_warn():
    df = _cat_df(600)
    df.loc[:9, "exp"] = "Unknown"
    res = run_analysis(df, _cfg(methods=["ipw"]))
    assert any("pooled into the control group" in w and "'Unknown'" in w for w in res.warnings)
    res = run_analysis(df, _cfg(methods=["ipw"], control_values=["Control"]))
    assert not any("pooled into the control group" in w for w in res.warnings)
