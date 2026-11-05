import numpy as np

from propensity_lift.matching import match_one_direction, nn_match


def _toy():
    score = np.array([0.0, 1.0, 5.0, 0.1, 0.95, 1.2, 3.0])
    t = np.array([1, 1, 1, 0, 0, 0, 0], bool)
    return score, t


def test_caliper_excludes_far_units():
    s, t = _toy()
    mp = match_one_direction(s, t, ~t, caliper=0.5, ratio=1, replacement=True)
    pairs = dict(zip(mp.treated.tolist(), mp.control.tolist()))
    assert pairs == {0: 3, 1: 4}
    assert mp.n_focal_matched == 2
    assert np.all(np.abs(s[mp.treated] - s[mp.control]) <= 0.5)


def test_ratio_and_replacement_weights():
    s, t = _toy()
    r = nn_match(s, t, caliper_abs=None, ratio=2, replacement=True)
    # exposed all matched (no caliper)
    assert np.allclose(r.weights[:3], 1)
    # each exposed gives 1/2 to two controls: 0 -> {3 (0.1), 4 (0.95)}, 1 -> {4, 5}, 2 -> {6, 5}
    assert np.allclose(r.weights[3:], [0.5, 1.0, 1.0, 0.5])
    assert np.isclose(r.weights[3:].sum(), 3)
    assert r.n_unique_controls_used == 4


def test_without_replacement_uses_each_control_once():
    rng = np.random.default_rng(0)
    s = rng.normal(size=400)
    t = rng.random(400) < 0.3
    mp = match_one_direction(s, t, ~t, caliper=None, ratio=2, replacement=False)
    assert len(np.unique(mp.control)) == len(mp.control)
    assert set(mp.control) <= set(np.flatnonzero(~t))
    counts = np.bincount(mp.treated, minlength=400)[t]
    assert counts.max() <= 2
    r = nn_match(s, t, None, ratio=2, replacement=False)
    assert r.weights[~t].max() <= 0.5 + 1e-12  # each control serves one exposed at 1/k


def test_without_replacement_greedy_matches_nearest_available():
    s = np.array([0.0, 0.05, 0.0, 1.0])
    t = np.array([1, 1, 0, 0], bool)
    mp = match_one_direction(s, t, ~t, caliper=None, ratio=1, replacement=False)
    pairs = dict(zip(mp.treated.tolist(), mp.control.tolist()))
    # largest score first: unit 1 takes control 2, unit 0 gets the remaining control 3
    assert pairs == {1: 2, 0: 3}


def test_with_replacement_reuses_controls():
    s = np.array([0.0, 0.01, 0.02, 0.0, 5.0])
    t = np.array([1, 1, 1, 0, 0], bool)
    r = nn_match(s, t, None, ratio=1, replacement=True)
    assert np.isclose(r.weights[3], 3) and r.weights[4] == 0


def test_exact_strata_respected():
    rng = np.random.default_rng(1)
    n = 600
    s = rng.normal(size=n)
    strata = rng.integers(0, 4, n)
    t = rng.random(n) < 0.35
    for repl in (True, False):
        mp = match_one_direction(s, t, ~t, caliper=None, ratio=3, replacement=repl, strata=strata)
        assert len(mp.treated) > 0
        assert np.all(strata[mp.treated] == strata[mp.control])


def test_stratum_without_controls_unmatched():
    s = np.array([0.0, 0.0, 0.0])
    strata = np.array([0, 1, 0])
    t = np.array([True, True, False])
    r = nn_match(s, t, None, strata=strata)
    assert r.n_exposed_matched == 1 and r.n_exposed_unmatched == 1
    assert r.weights.tolist() == [1.0, 0.0, 1.0]


def test_ate_matching_both_directions():
    s = np.array([0.0, 1.0, 0.1, 1.1, 2.0])
    t = np.array([1, 1, 0, 0, 0], bool)
    r = nn_match(s, t, None, ratio=1, replacement=True, estimand="ATE")
    assert r.n_control_matched == 3
    # exposed: own 1 + used by controls (2->0, 3->1, 4->1)
    assert np.allclose(r.weights[:2], [2.0, 3.0])
    assert np.allclose(r.weights[2:], [2.0, 2.0, 1.0])


def test_tied_scores_use_all_tied_controls():
    # all-categorical PS models give heavily tied scores: every tied control must be used,
    # not just the first one in sort order
    s = np.zeros(8)
    t = np.array([1, 1, 1, 0, 0, 0, 0, 0], bool)
    mp = match_one_direction(s, t, ~t, caliper=0.2, ratio=1, replacement=True)
    assert len(np.unique(mp.control)) == 5
    for i in range(3):
        sel = mp.treated == i
        assert sorted(mp.control[sel].tolist()) == [3, 4, 5, 6, 7]
        assert np.allclose(mp.weight[sel], 0.2)
    r = nn_match(s, t, 0.2, ratio=1, replacement=True)
    assert np.allclose(r.weights[:3], 1) and np.allclose(r.weights[3:], 0.6)
    assert r.n_unique_controls_used == 5


def test_tie_block_with_float_noise_and_strata():
    s = np.array([0.5, 0.5, 0.5 + 1e-15, 0.5 - 1e-15, 0.5, 0.9])
    t = np.array([1, 1, 0, 0, 0, 0], bool)
    strata = np.array([0, 1, 0, 0, 1, 0])
    r = nn_match(s, t, None, ratio=1, replacement=True, strata=strata)
    # unit 0 (stratum 0) shares between controls 2 and 3; unit 1 (stratum 1) takes 4
    assert np.allclose(r.weights, [1, 1, 0.5, 0.5, 1, 0])


def test_direction_weights_match_pairs():
    rng = np.random.default_rng(3)
    n = 500
    s = np.round(rng.normal(size=n), 1)  # many ties
    t = rng.random(n) < 0.4
    strata = rng.integers(0, 3, n)
    mp = match_one_direction(s, t, ~t, caliper=0.15, ratio=3, replacement=True, strata=strata)
    r = nn_match(s, t, 0.15, ratio=3, replacement=True, strata=strata)
    w = np.bincount(mp.control, weights=mp.weight, minlength=n)
    w[np.unique(mp.treated)] += 1
    assert np.allclose(r.weights, w)
    assert r.n_unique_controls_used == len(np.unique(mp.control))
