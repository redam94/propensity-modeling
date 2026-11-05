import numpy as np
import pandas as pd

from propensity_lift._utils import hist_ovl, make_edges
from propensity_lift.overlap import (
    common_support,
    feature_overlap,
    ps_overlap_summary,
    region_counts,
    trim_mask,
)


def test_regions_and_support():
    ps = np.array([0.05, 0.2, 0.3, 0.6, 0.1, 0.2, 0.4, 0.5, 0.7, 0.9])
    t = np.array([0, 0, 0, 0, 1, 1, 1, 1, 1, 1])
    lo, hi = common_support(ps, t)
    assert (lo, hi) == (0.1, 0.6)
    regs = {r.region: r for r in region_counts(ps, t)}
    assert regs["control_only"].n_control == 1 and regs["control_only"].n_exposed == 0
    assert regs["exposed_only"].n_exposed == 2 and regs["exposed_only"].n_control == 0
    assert regs["both"].n_exposed == 4 and regs["both"].n_control == 3
    assert np.isclose(regs["exposed_only"].pct_exposed, 100 * 2 / 6)
    assert np.isclose(sum(r.pct_control for r in regs.values()), 100)
    assert trim_mask(ps, t, "common_support").sum() == 7
    assert trim_mask(ps, t, "crump").sum() == 9
    assert trim_mask(ps, t, "none").all()


def test_ovl_identical_and_disjoint():
    rng = np.random.default_rng(0)
    x = rng.uniform(0.2, 0.8, 1000)
    t = np.r_[np.ones(1000), np.zeros(1000)].astype(bool)
    summ = ps_overlap_summary(np.r_[x, x], t)
    assert summ.overlap_coefficient > 0.999
    a = rng.uniform(0.05, 0.3, 500)
    b = rng.uniform(0.6, 0.95, 500)
    tt = np.r_[np.ones(500), np.zeros(500)].astype(bool)
    summ = ps_overlap_summary(np.r_[b, a], tt, trim="common_support")
    assert summ.overlap_coefficient == 0.0
    assert summ.common_support_lower > summ.common_support_upper
    regs = {r.region: r for r in summ.regions}
    assert regs["both"].n_exposed == 0 and regs["both"].n_control == 0
    assert regs["exposed_only"].pct_exposed == 100 and regs["control_only"].pct_control == 100
    assert len(summ.histogram.edges) == len(summ.histogram.exposed_counts) + 1 == 41
    assert len(summ.density.x) == len(summ.density.exposed)
    assert summ.n_trimmed_exposed == 500 and summ.n_trimmed_control == 500


def test_ovl_partial():
    rng = np.random.default_rng(0)
    a = rng.normal(0, 1, 50_000)
    b = rng.normal(1, 1, 50_000)
    edges = make_edges(np.r_[a, b], 40)
    # true OVL of N(0,1), N(1,1) = 2*Phi(-0.5) = 0.617
    assert abs(hist_ovl(a, b, edges) - 0.617) < 0.03


def test_feature_overlap_categorical_underlap():
    s = pd.Series(["a", "a", "b", "c", "a", "b", "b", "d"])
    t = np.array([1, 1, 1, 1, 0, 0, 0, 0], bool)
    fo = feature_overlap(s, t, "x", "model", "categorical")
    assert fo.exposed_only_levels == ["c"] and fo.control_only_levels == ["d"]
    assert np.isclose(fo.pct_exposed_unsupported, 25)
    # shares e: a .5 b .25 c .25 ; c: a .25 b .5 d .25 -> OVL .25+.25 = .5
    assert np.isclose(fo.overlap_coefficient, 0.5)
    assert {lv.level for lv in fo.levels} == {"a", "b", "c", "d"}


def test_feature_overlap_numeric_range():
    s = pd.Series([1.0, 2.0, 3.0, 10.0, 1.0, 2.0, 3.0, np.nan])
    t = np.array([1, 1, 1, 1, 0, 0, 0, 0], bool)
    fo = feature_overlap(s, t, "x", "matching", "numeric")
    assert fo.exposed_range == [1.0, 10.0] and fo.control_range == [1.0, 3.0]
    assert np.isclose(fo.pct_exposed_unsupported, 25) and fo.pct_control_unsupported == 0
    assert fo.histogram is not None and 0 < fo.overlap_coefficient < 1
