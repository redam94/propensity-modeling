import json

import numpy as np
import pandas as pd
import pytest

from propensity_lift import list_sheets, load_table, profile_dataframe
from propensity_lift.io import infer_kind, suggest_role


def test_profile_sample_kinds_and_roles(sample_df):
    prof = profile_dataframe(sample_df, "ds1", "sample.xlsx", ["Respondents"], "Respondents")
    by = {c.name: c for c in prof.columns}
    assert prof.n_rows == 3000 and prof.n_cols == sample_df.shape[1]
    assert by["group"].kind == "binary" and by["group"].suggested_role == "treatment"
    assert by["respondent_id"].suggested_role == "id"
    assert by["age"].kind == "numeric" and by["age"].suggested_role == "model_feature"
    assert by["region"].kind == "categorical"
    assert by["favorite_tv_show"].kind == "text" and by["favorite_tv_show"].suggested_role == "ignore"
    assert by["survey_date"].kind == "datetime" and by["survey_date"].suggested_role == "ignore"
    for o in ["aided_awareness", "unaided_awareness", "favorability", "consideration", "purchase_intent",
              "ad_recall"]:
        assert by[o].suggested_role == "outcome", o
    assert by["household_income_k"].n_missing > 0
    assert by["age"].min is not None and by["age"].max >= by["age"].min
    assert len(by["region"].top_values) == 4
    # JSON-safe
    json.loads(prof.model_dump_json())
    for c in prof.columns:
        for tv in c.top_values:
            assert type(tv.value) in (str, int, float, bool)


def test_infer_kind_variants():
    assert infer_kind(pd.Series([np.nan, None]))[0] == "empty"
    assert infer_kind(pd.Series([1, 0, 1, None]))[0] == "binary"
    assert infer_kind(pd.Series([True, False, True]))[0] == "binary"
    assert infer_kind(pd.Series([1.5, 2.5, 3.5, 4.0]))[0] == "numeric"
    assert infer_kind(pd.Series(["1", "2", "3", " 4 "]))[0] == "numeric"
    assert infer_kind(pd.Series(["a", "b", "c", "a"]))[0] == "categorical"
    assert infer_kind(pd.Series([f"free text {i}" for i in range(500)]))[0] == "text"
    assert infer_kind(pd.Series(pd.date_range("2024-01-01", periods=10)))[0] == "datetime"
    assert infer_kind(pd.Series(["", "  ", None]))[0] == "empty"


def test_suggest_role_names():
    assert suggest_role("Test_Control", "binary", 2, 100) == "treatment"
    assert suggest_role("exposure_flag", "binary", 2, 100) == "treatment"
    assert suggest_role("Cell", "categorical", 3, 100) == "treatment"
    assert suggest_role("age_group", "categorical", 5, 100) == "model_feature"
    assert suggest_role("Q5 Unaided Awareness", "binary", 2, 100) == "outcome"
    assert suggest_role("purchase intent", "categorical", 5, 100) == "outcome"
    assert suggest_role("resp_id", "numeric", 100, 100) == "id"
    assert suggest_role("UUID", "text", 100, 100) == "id"
    assert suggest_role("verbatim", "text", 90, 100) == "ignore"


def test_profile_numpy_scalars_json_safe():
    df = pd.DataFrame({"x": np.array([1, 2, 2, 3], dtype=np.int64), "f": [1.0, 1.0, 2.5, np.nan],
                       "b": [True, False, True, True]})
    prof = profile_dataframe(df, "d", "f.csv", [], None)
    vals = {c.name: [tv.value for tv in c.top_values] for c in prof.columns}
    assert vals["x"][0] == 2 and isinstance(vals["x"][0], int)
    assert isinstance(vals["f"][0], int)  # integral float rendered as int
    assert set(vals["b"]) == {True, False}
    json.loads(prof.model_dump_json())


def test_load_csv_strips_and_dedupes(tmp_path):
    p = tmp_path / "d.csv"
    p.write_text(" a ,b,a,b \n1,2,3,4\n5,6,7,8\n")
    df = load_table(p)
    assert list(df.columns) == ["a", "b", "a_2", "b_2"]
    assert list_sheets(p) == []


def test_load_excel_sheets(tmp_path):
    p = tmp_path / "d.xlsx"
    with pd.ExcelWriter(p) as xw:
        pd.DataFrame({" group ": ["E", "C"], "y": [1, 0]}).to_excel(xw, sheet_name="Data", index=False)
        pd.DataFrame({"note": ["hi"]}).to_excel(xw, sheet_name="Notes", index=False)
    assert list_sheets(p) == ["Data", "Notes"]
    df = load_table(p)
    assert list(df.columns) == ["group", "y"]
    assert list(load_table(p, "Notes").columns) == ["note"]
    with pytest.raises(ValueError):
        load_table(p, "Missing")


def test_unsupported_ext(tmp_path):
    p = tmp_path / "d.json"
    p.write_text("{}")
    with pytest.raises(ValueError):
        load_table(p)
