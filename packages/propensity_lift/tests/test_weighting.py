import numpy as np

from propensity_lift.weighting import (
    clip_weights,
    ipw_weights,
    kish_ess,
    normalize_within_group,
    overlap_weights,
    stratification_weights,
)

ps = np.array([0.2, 0.5, 0.8, 0.2, 0.5, 0.8])
t = np.array([1, 1, 1, 0, 0, 0])


def test_ipw_att():
    w = ipw_weights(ps, t, "ATT")
    assert np.allclose(w[:3], 1)
    assert np.allclose(w[3:], ps[3:] / (1 - ps[3:]))


def test_ipw_ate():
    w = ipw_weights(ps, t, "ATE")
    assert np.allclose(w[:3], 1 / ps[:3])
    assert np.allclose(w[3:], 1 / (1 - ps[3:]))


def test_overlap_weights():
    w = overlap_weights(ps, t)
    assert np.allclose(w[:3], 1 - ps[:3]) and np.allclose(w[3:], ps[3:])


def test_ipw_att_reweights_controls_to_exposed_distribution():
    rng = np.random.default_rng(0)
    x = rng.normal(size=200_000)
    p = 1 / (1 + np.exp(-(x - 0.5)))
    tt = rng.random(x.size) < p
    w = ipw_weights(p, tt, "ATT")
    assert abs(np.average(x[~tt], weights=w[~tt]) - x[tt].mean()) < 0.02


def test_normalize_and_kish():
    w = normalize_within_group(np.array([1, 1, 2, 1, 3, 0], float), np.array([1, 1, 1, 0, 0, 0]))
    assert np.isclose(w[:3].sum(), 3) and np.isclose(w[3:].sum(), 3)
    assert np.isclose(kish_ess(np.ones(10)), 10)
    assert np.isclose(kish_ess(np.array([1.0, 0, 0])), 1)
    assert np.isclose(kish_ess(np.array([1.0, 3.0])), 16 / 10)


def test_clip_weights():
    w = np.r_[np.ones(5), np.arange(1, 101, dtype=float)]
    tt = np.r_[np.ones(5), np.zeros(100)].astype(int)
    wc, n = clip_weights(w, tt, 0.9)
    cap = np.quantile(np.arange(1, 101), 0.9)
    assert n == int((np.arange(1, 101) > cap).sum())
    assert wc.max() <= cap + 1e-12 and np.allclose(wc[:5], 1)
    assert clip_weights(w, tt, None)[1] == 0


def test_stratification_att():
    p = np.array([0.1, 0.15, 0.6, 0.65, 0.1, 0.12, 0.13, 0.6, 0.9])
    tt = np.array([1, 1, 1, 1, 0, 0, 0, 0, 0])
    w, empty = stratification_weights(p, tt, n_strata=2, estimand="ATT")
    # exposed median edge ~0.375 -> stratum0: 2 exposed / 3 control, stratum1: 2 exposed / 2 control
    assert empty == 0
    assert np.allclose(w[:4], 1)
    assert np.allclose(w[4:7], 2 / 3)
    assert np.allclose(w[7:], 1.0)


def test_stratification_empty_stratum():
    p = np.array([0.1, 0.9, 0.1])
    tt = np.array([1, 1, 0])
    w, empty = stratification_weights(p, tt, n_strata=2, estimand="ATT")
    assert empty == 1 and w[1] == 0 and w[0] == 1 and w[2] == 1
