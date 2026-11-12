import json
import math

import numpy as np
import pandas as pd
import pytest

from propensity_lift import AnalysisConfig, AnalysisResult, run_analysis
from propensity_lift.doubly_robust import aipw_estimate, fit_outcome_models
from propensity_lift.lift import lift_only, outcome_matrix
from propensity_lift.sample_data import sample_analysis_config
from propensity_lift.weighting import ipw_weights

EFFECT = 0.5


def _arrays(seed=0, n=6000):
    """Confounded data with a homogeneous effect (ATT == ATE == EFFECT) and a linear outcome."""
    rng = np.random.default_rng(seed)
    X = rng.normal(size=(n, 2))
    ps = 1 / (1 + np.exp(-(-0.3 + 0.9 * X[:, 0] - 0.5 * X[:, 1])))
    t = (rng.random(n) < ps).astype(np.int64)
    y = 1.0 + 0.8 * X[:, 0] + 0.6 * X[:, 1] + EFFECT * t + rng.normal(size=n)
    Y, M = outcome_matrix([y])
    return X, ps, t, Y, M, np.ones((n, 1))


def _lift(est):
    return float((est.exposed_mean - est.control_mean)[0, 0])


def test_null_outcome_model_reduces_to_ipw():
    X, ps, t, Y, M, D = _arrays()
    w = ipw_weights(ps, t, "ATE")
    zero = np.zeros_like(Y)
    est = aipw_estimate(w, np.ones(len(t)), t, D, Y, M, zero, zero)
    assert np.isclose(_lift(est), lift_only(w, t, D, Y, M)[0, 0])


def test_consistent_when_only_the_outcome_model_is_right():
    X, _, t, Y, M, D = _arrays()
    w = ipw_weights(np.full(len(t), 0.5), t, "ATE")       # wrong propensity model: no adjustment at all
    assert abs(lift_only(w, t, D, Y, M)[0, 0] - EFFECT) > 0.2
    m0, m1 = fit_outcome_models(X, Y, M, t, [False], np.ones(len(t)))
    est = aipw_estimate(w, np.ones(len(t)), t, D, Y, M, m0, m1)
    assert abs(_lift(est) - EFFECT) < 0.1


def test_consistent_when_only_the_propensity_model_is_right():
    X, ps, t, Y, M, D = _arrays()
    w = ipw_weights(ps, t, "ATE")
    wrong = (0.7 * X[:, 1] ** 2)[:, None]                 # wrong outcome model for both arms
    est = aipw_estimate(w, np.ones(len(t)), t, D, Y, M, wrong, wrong + 2.0)
    assert abs(_lift(est) - EFFECT) < 0.15


def test_att_keeps_the_observed_exposed_mean():
    X, ps, t, Y, M, D = _arrays()
    te = (t == 1).astype(float)
    m0, m1 = fit_outcome_models(X, Y, M, t, [False], np.ones(len(t)), arms=(0,))
    assert not m1.any()                                   # the exposed-arm model is not needed for the ATT
    est = aipw_estimate(ipw_weights(ps, t, "ATT"), te, t, D, Y, M, m0, m1, with_se=True)
    assert np.isclose(est.exposed_mean[0, 0], Y[t == 1, 0].mean())
    assert abs(_lift(est) - EFFECT) < 0.1
    assert 0 < est.se[0, 0] < 0.1


def test_outcome_models_binary_and_missing():
    rng = np.random.default_rng(1)
    n = 3000
    X = rng.normal(size=(n, 2))
    t = (rng.random(n) < 0.5).astype(np.int64)
    p1 = 1 / (1 + np.exp(-(1.0 + 1.2 * X[:, 0])))             # P(y = 1 | x) if exposed; control intercept 0.2
    yb = (rng.random(n) < np.where(t == 1, p1, 1 / (1 + np.exp(-(0.2 + 1.2 * X[:, 0]))))).astype(float)
    yb[:200] = np.nan                                     # missing outcomes are ignored when fitting
    const = np.full(n, 3.0)                               # constant outcome -> constant prediction
    Y, M = outcome_matrix([yb, const])
    m0, m1 = fit_outcome_models(X, Y, M, t, [True, False], np.ones(n))
    assert m0.shape == (n, 2) and np.isfinite(m0).all() and np.isfinite(m1).all()
    assert (m0[:, 0] > 0).all() and (m1[:, 0] < 1).all()
    assert np.corrcoef(m1[:, 0], p1)[0, 1] > 0.99 and abs(m1[:, 0].mean() - p1.mean()) < 0.03
    assert m1[:, 0].mean() > m0[:, 0].mean()
    assert np.allclose(m0[:, 1], 3.0) and np.allclose(m1[:, 1], 3.0)


# --------------------------------------------------------------------------- #
# through the public pipeline
# --------------------------------------------------------------------------- #
def _frame(seed=0, n=2500):
    rng = np.random.default_rng(seed)
    x1 = rng.normal(size=n)
    x2 = rng.choice(["a", "b", "c"], n)
    x2e = (x2 == "b") * 0.5 + (x2 == "c") * -0.5
    t = rng.random(n) < 1 / (1 + np.exp(-(-0.3 + 0.8 * x1 + x2e)))
    y = 0.6 * x1 + x2e + EFFECT * t + rng.normal(size=n)
    return pd.DataFrame({"t": np.where(t, "E", "C"), "x1": x1, "x2": x2, "y": y})


def _cfg(**kw):
    base = dict(dataset_id="sim", treatment_column="t", exposed_values=["E"], outcome_columns=["y"],
                model_features=["x1", "x2"], methods=["aipw"], n_bootstrap=100)
    base.update(kw)
    return AnalysisConfig(**base)


@pytest.mark.parametrize("estimand", ["ATT", "ATE"])
def test_pipeline_aipw_recovers_known_effect(estimand):
    df = _frame()
    res = run_analysis(df, _cfg(estimand=estimand, methods=["aipw", "ipw"]))
    aipw, ipw = res.methods
    c = aipw.contrasts[0]
    assert aipw.method == "aipw" and aipw.estimand == estimand
    assert "AIPW" in aipw.label and estimand in aipw.label
    assert c.ci_method == "bootstrap" and c.significant
    assert c.ci_low <= EFFECT <= c.ci_high, (c.lift, c.ci_low, c.ci_high)
    assert np.isclose(c.lift, c.exposed_mean - c.control_mean_adjusted)
    assert np.isclose(c.raw_diff, df.y[df.t == "E"].mean() - df.y[df.t == "C"].mean())
    assert c.se < ipw.contrasts[0].se                     # the outcome model buys precision
    # weights and balance are those of the underlying IPW weights
    assert aipw.weights == ipw.weights
    assert aipw.balance_summary == ipw.balance_summary


def test_pipeline_aipw_analytic_se_agrees_with_bootstrap():
    df = _frame(seed=3)
    boot = run_analysis(df, _cfg(n_bootstrap=200)).methods[0]
    analytic = run_analysis(df, _cfg(n_bootstrap=0)).methods[0]
    cb, ca = boot.contrasts[0], analytic.contrasts[0]
    assert ca.ci_method == "analytic" and np.isclose(ca.lift, cb.lift)
    assert 0.8 < ca.se / cb.se < 1.25
    assert any("influence-function" in w for w in analytic.warnings)


def test_pipeline_aipw_sample_data_subgroups_and_clipping(sample_df):
    cfg = sample_analysis_config(methods=["aipw"], subgroup_columns=["gender"], n_bootstrap=20,
                                 estimand="ATE", weight_clip=0.95, model_type="gradient_boosting")
    res = run_analysis(sample_df, cfg)
    text = res.model_dump_json()
    assert "NaN" not in text and "Infinity" not in text
    AnalysisResult.model_validate_json(text)
    m = res.methods[0]
    assert len(m.contrasts) == len(cfg.outcome_columns)
    assert len(m.subgroups) == len({s.subgroup_level for s in m.subgroups}) * len(cfg.outcome_columns)
    assert m.weights.n_clipped > 0 and "clipped at p95" in m.label
    for c in m.contrasts + m.subgroups:
        assert math.isfinite(c.lift) and c.se > 0
    by = {c.outcome: c for c in m.contrasts}
    assert by["aided_awareness"].lift > 0 and by["aided_awareness"].significant
    assert by["aided_awareness"].raw_diff > by["aided_awareness"].lift
    assert json.loads(text)["config"]["methods"] == ["aipw"]
