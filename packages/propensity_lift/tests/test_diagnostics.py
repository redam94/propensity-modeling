import numpy as np

from propensity_lift.diagnostics import balance_table, smd


def test_smd_hand_computation():
    xe = np.array([1.0, 2.0, 3.0, 4.0])
    xc = np.array([0.0, 1.0, 1.0, 2.0])
    # population variances: var_e = 1.25, var_c = 0.5
    expected = (2.5 - 1.0) / np.sqrt((1.25 + 0.5) / 2)
    assert np.isclose(smd(xe, xc), expected)


def test_balance_after_uses_unadjusted_denominator():
    x = np.array([1.0, 2.0, 3.0, 4.0, 0.0, 1.0, 1.0, 2.0])
    t = np.array([1, 1, 1, 1, 0, 0, 0, 0])
    w = np.array([1, 1, 1, 1, 0, 0, 1, 3], float)
    rows, summ = balance_table(x[:, None], t, w, ["x"], ["x"], [False], {"x": "model"})
    r = rows[0]
    sd = np.sqrt((1.25 + 0.5) / 2)
    assert np.isclose(r.smd_before, 1.5 / sd)
    mc_after = (1 * 1 + 3 * 2) / 4
    assert np.isclose(r.mean_control_after, mc_after)
    assert np.isclose(r.smd_after, (2.5 - mc_after) / sd)
    assert np.isclose(r.var_ratio_before, 1.25 / 0.5)
    assert summ.n_imbalanced_before == 1
    assert np.isclose(summ.max_abs_smd_after, abs(r.smd_after))


def test_balance_dummy_has_no_var_ratio():
    x = np.array([[1, 0], [0, 1], [1, 0], [0, 1]], float)
    t = np.array([1, 1, 0, 0])
    rows, _ = balance_table(x, t, np.ones(4), ["a=1", "a=2"], ["a", "a"], [True, True], {"a": "both"})
    assert rows[0].var_ratio_before is None and rows[0].role == "both"
    assert rows[0].smd_before == 0.0
