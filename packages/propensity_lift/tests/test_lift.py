import numpy as np
import pandas as pd

from propensity_lift import AnalysisConfig, run_analysis
from propensity_lift.lift import weighted_lift


def test_weighted_lift_analytic_matches_formula():
    rng = np.random.default_rng(0)
    y = rng.normal(size=400)
    t = np.r_[np.ones(200), np.zeros(200)].astype(bool)
    r = weighted_lift(y, t)
    se = np.sqrt(y[t].var() / 200 + y[~t].var() / 200)
    assert np.isclose(r["lift"], y[t].mean() - y[~t].mean())
    assert np.isclose(r["se"], se)
    assert r["ci_low"] < r["lift"] < r["ci_high"]


def _simulate(seed, effect, n=2000):
    rng = np.random.default_rng(seed)
    x1 = rng.normal(size=n)
    x2 = rng.choice(["a", "b", "c"], n)
    x2e = (x2 == "b") * 0.5 + (x2 == "c") * -0.5
    p = 1 / (1 + np.exp(-(-0.3 + 0.8 * x1 + x2e)))
    t = rng.random(n) < p
    y = 0.6 * x1 + x2e + effect * t + rng.normal(size=n)
    return pd.DataFrame({"t": np.where(t, "E", "C"), "x1": x1, "x2": x2, "y": y})


def _cfg(**kw):
    base = dict(dataset_id="sim", treatment_column="t", exposed_values=["E"], outcome_columns=["y"],
                model_features=["x1", "x2"], methods=["nn_matching", "ipw", "overlap_weights", "stratification"],
                n_bootstrap=100, n_strata=10)
    base.update(kw)
    return AnalysisConfig(**base)


def test_lift_recovers_known_effect():
    df = _simulate(0, 0.5)
    res = run_analysis(df, _cfg())
    raw = df.y[df.t == "E"].mean() - df.y[df.t == "C"].mean()
    for m in res.methods:
        c = m.contrasts[0]
        assert c.ci_method == "bootstrap"
        assert c.ci_low <= 0.5 <= c.ci_high, (m.method, c.lift, c.ci_low, c.ci_high)
        assert c.significant
        assert np.isclose(c.raw_diff, raw)
        assert abs(c.lift - 0.5) < abs(raw - 0.5)  # adjustment removes confounding bias


def test_null_effect_rarely_significant():
    n_sig = 0
    reps = 12
    for seed in range(reps):
        res = run_analysis(_simulate(100 + seed, 0.0, n=1200),
                           _cfg(methods=["ipw"], n_bootstrap=0))
        n_sig += res.methods[0].contrasts[0].significant
    assert n_sig <= 3


def test_analytic_ci_when_no_bootstrap():
    res = run_analysis(_simulate(3, 0.3), _cfg(n_bootstrap=0, methods=["ipw"]))
    c = res.methods[0].contrasts[0]
    assert c.ci_method == "analytic" and c.se > 0
    assert np.isclose(c.ci_high - c.lift, c.lift - c.ci_low)
