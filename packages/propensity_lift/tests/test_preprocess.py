import numpy as np
import pandas as pd
import pytest

from propensity_lift.preprocess import code_treatment, encode_features, matching_strata, recode_outcome


def test_treatment_strings_case_insensitive():
    s = pd.Series(["Exposed", "control", " EXPOSED ", None, "Other"])
    assert code_treatment(s, ["exposed"], ["Control"]).tolist() == [1, 0, 1, -1, -1]
    # control None -> everything else non-missing is control
    assert code_treatment(s, ["Exposed"]).tolist() == [1, 0, 1, -1, 0]


def test_treatment_numeric_float_string_bool():
    s = pd.Series([1.0, 0.0, np.nan, 1.0])  # excel loads 1 as 1.0
    assert code_treatment(s, [1], [0]).tolist() == [1, 0, -1, 1]
    assert code_treatment(s, ["1"], ["0"]).tolist() == [1, 0, -1, 1]
    assert code_treatment(s, [True], [False]).tolist() == [1, 0, -1, 1]
    s2 = pd.Series(["1", "0", "1"])
    assert code_treatment(s2, [1], [0]).tolist() == [1, 0, 1]
    s3 = pd.Series([True, False, True])
    assert code_treatment(s3, [1]).tolist() == [1, 0, 1]
    assert code_treatment(s3, ["true"], ["false"]).tolist() == [1, 0, 1]


def test_treatment_overlap_values_raise():
    with pytest.raises(ValueError):
        code_treatment(pd.Series([1, 0]), [1], [1, 0])
    with pytest.raises(ValueError):
        code_treatment(pd.Series([1, 0]), [None])


def test_outcome_recode_rules():
    o = recode_outcome(pd.Series(["Yes", "No", None, "yes"]), "a")
    assert o.outcome_type == "binary"
    assert o.y[0] == 1 and o.y[1] == 0 and np.isnan(o.y[2]) and o.y[3] == 1
    o = recode_outcome(pd.Series([1, 2, 2, 1]), "b")  # SPSS 1=Yes/2=No: not auto-recoded
    assert o.outcome_type == "continuous" and o.y.tolist() == [1, 2, 2, 1]
    assert o.note and "outcome_positive_values" in o.note
    o = recode_outcome(pd.Series([True, False]), "c")
    assert o.y.tolist() == [1, 0]
    o = recode_outcome(pd.Series([1, 2, 3, 4, 5, np.nan]), "d")
    assert o.outcome_type == "continuous" and np.nanmean(o.y) == 3
    o = recode_outcome(pd.Series(["Very likely", "Unlikely", "Likely", None]), "e",
                       ["very likely", "Likely"])
    assert o.outcome_type == "binary" and o.y[:3].tolist() == [1, 0, 1] and np.isnan(o.y[3])
    with pytest.raises(ValueError, match="outcome_positive_values"):
        recode_outcome(pd.Series(["a", "b", "c"]), "f")
    with pytest.raises(ValueError):
        recode_outcome(pd.Series(["Brand A", "Brand B"]), "g")
    o = recode_outcome(pd.Series(["Aware", "Not aware"]), "h")
    assert o.y.tolist() == [1, 0]


def test_encode_features_rare_pooling_and_missing():
    n = 1000
    rng = np.random.default_rng(0)
    cat = np.array(["A"] * 600 + ["B"] * 395 + ["rare1"] * 3 + ["rare2"] * 2, dtype=object)
    num = rng.normal(size=n)
    num[:50] = np.nan
    df = pd.DataFrame({"cat": cat, "num": num, "const": 1.0})
    enc = encode_features(df, ["cat", "num", "const"])
    assert "cat=__other__" in enc.names and "cat=rare1" not in enc.names
    assert "num__missing" in enc.names
    j = enc.names.index("num")
    assert np.isfinite(enc.X[:, j]).all()
    assert enc.X[:50, j].std() == 0  # imputed with median
    assert any("const" in w for w in enc.warnings)
    assert set(enc.sources) == {"cat", "num"}


def test_matching_strata_coarsens_numeric():
    df = pd.DataFrame({"age": np.arange(100), "g": ["a", "b"] * 50})
    codes, k = matching_strata(df, ["age", "g"])
    assert k == 10  # 5 quintiles x 2 levels
    assert codes.shape == (100,)


def test_outcome_numeric_pairs_only_auto_recode_zero_one():
    o = recode_outcome(pd.Series([0, 1, 1, 0, np.nan]), "a")
    assert o.outcome_type == "binary" and o.y[:4].tolist() == [0, 1, 1, 0] and o.note is None
    o = recode_outcome(pd.Series([1.0, 0.0]), "a2")
    assert o.y.tolist() == [1, 0]
    # SPSS-style 1=Yes / 2=No must not flip silently
    o = recode_outcome(pd.Series([1, 2, 2, 1, 2]), "b")
    assert o.outcome_type == "continuous" and "[1, 2]" in o.note
    o = recode_outcome(pd.Series([1, 2, 2, 1]), "b", positive_values=[1])
    assert o.outcome_type == "binary" and o.y.tolist() == [1, 0, 0, 1]
    # two observed scale points stay on the scale
    o = recode_outcome(pd.Series([4, 5, 5, 4]), "fav")
    assert o.outcome_type == "continuous" and np.mean(o.y) == 4.5


def test_outcome_label_pair_reports_positive_level():
    o = recode_outcome(pd.Series(["Yes", "No"]), "a")
    assert o.outcome_type == "binary" and o.y.tolist() == [1, 0]
    assert o.note and "'yes' treated as positive" in o.note
    o = recode_outcome(pd.Series(["Not aware", "Something"]), "b")
    assert o.y.tolist() == [0, 1] and "'something' treated as positive" in o.note
