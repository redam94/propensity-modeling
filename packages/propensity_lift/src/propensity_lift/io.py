"""Loading tables (Excel / CSV) and profiling columns."""

from __future__ import annotations

import os
import re
from datetime import date, datetime
from pathlib import Path
from typing import List, Optional, Sequence, Tuple, Union

import numpy as np
import pandas as pd

from ._utils import finite_or_none, json_scalar, unique_names
from .schemas import ColumnKind, ColumnProfile, DatasetProfile, ValueCount

PathLike = Union[str, "os.PathLike[str]"]

EXCEL_EXTS = {".xlsx", ".xlsm", ".xls"}
CSV_EXTS = {".csv", ".txt"}
SUPPORTED_EXTS = EXCEL_EXTS | CSV_EXTS


def _ext(path: PathLike) -> str:
    return Path(str(path)).suffix.lower()


def _engine(ext: str) -> Optional[str]:
    return "xlrd" if ext == ".xls" else "openpyxl"


def list_sheets(path: PathLike) -> List[str]:
    """Sheet names of an Excel workbook ([] for CSV)."""
    ext = _ext(path)
    if ext in CSV_EXTS:
        return []
    if ext not in EXCEL_EXTS:
        raise ValueError(f"Unsupported file type '{ext}'. Use .xlsx, .xlsm, .xls or .csv")
    with pd.ExcelFile(path, engine=_engine(ext)) as xf:
        return [str(s) for s in xf.sheet_names]


def clean_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Strip column-name whitespace, make names unique, drop fully-empty rows/cols."""
    df = df.copy()
    df.columns = unique_names(list(df.columns))
    df = df.dropna(how="all")
    empty_unnamed = [c for c in df.columns if c.startswith("Unnamed:") and df[c].isna().all()]
    if empty_unnamed:
        df = df.drop(columns=empty_unnamed)
    return df.reset_index(drop=True)


def load_table(path: PathLike, sheet: Optional[str] = None) -> pd.DataFrame:
    """Load an .xlsx/.xlsm/.xls/.csv file into a DataFrame.

    ``sheet`` selects an Excel sheet (default: first). Column names are
    stripped and de-duplicated.
    """
    ext = _ext(path)
    if ext in CSV_EXTS:
        df = pd.read_csv(path, low_memory=False)
        if df.shape[1] == 1 and ";" in str(df.columns[0]):
            df = pd.read_csv(path, sep=";", low_memory=False)
    elif ext in EXCEL_EXTS:
        sheet_name: Union[str, int] = 0 if sheet in (None, "") else sheet
        try:
            df = pd.read_excel(path, sheet_name=sheet_name, engine=_engine(ext))
        except ValueError as e:
            if isinstance(sheet_name, str) and "not found" in str(e).lower():
                raise ValueError(f"Sheet '{sheet}' not found in workbook") from e
            raise
    else:
        raise ValueError(f"Unsupported file type '{ext}'. Use .xlsx, .xlsm, .xls or .csv")
    return clean_columns(df)


# --------------------------------------------------------------------------- #
# column kinds
# --------------------------------------------------------------------------- #
TEXT_MIN_UNIQUE = 50
TEXT_UNIQUE_RATIO = 0.1


def _all_datetime_objects(s: pd.Series) -> bool:
    vals = s.dropna()
    if vals.empty:
        return False
    sample = vals.iloc[: min(len(vals), 200)]
    return all(isinstance(v, (datetime, date, pd.Timestamp)) for v in sample)


def numeric_values(s: pd.Series) -> Optional[pd.Series]:
    """Return s as float Series if every non-missing value is numeric, else None."""
    if pd.api.types.is_bool_dtype(s):
        return s.astype(float)
    if pd.api.types.is_numeric_dtype(s):
        return pd.to_numeric(s, errors="coerce").astype(float)
    if pd.api.types.is_datetime64_any_dtype(s):
        return None
    obj = s.astype(object).map(lambda v: v.strip() if isinstance(v, str) else v)
    obj = obj.map(lambda v: np.nan if (isinstance(v, str) and v == "") else v)
    nonnull = obj.dropna()
    if nonnull.empty:
        return None
    if any(isinstance(v, (datetime, date, pd.Timestamp)) for v in nonnull.iloc[:50]):
        return None
    # codes such as zip codes / ids with leading zeros ("01234") are identifiers, not numbers
    strs = nonnull[nonnull.map(lambda v: isinstance(v, str))]
    if len(strs) and strs.str.match(r"^0\d").any():
        return None
    try:
        conv = pd.to_numeric(nonnull.map(lambda v: float(v) if isinstance(v, (bool, np.bool_)) else v),
                             errors="coerce")
    except (TypeError, ValueError):
        return None
    if conv.notna().all():
        out = pd.Series(np.nan, index=s.index, dtype=float)
        out.loc[conv.index] = conv.astype(float).to_numpy()
        return out
    return None


def infer_kind(s: pd.Series) -> Tuple[ColumnKind, int]:
    """Infer a ColumnKind and number of unique non-null values."""
    s = s.replace(r"^\s*$", np.nan, regex=True) if (s.dtype == object or pd.api.types.is_string_dtype(s)) else s
    nonnull = s.dropna()
    if nonnull.empty:
        return "empty", 0
    try:
        n_unique = int(nonnull.nunique())
    except TypeError:
        n_unique = int(nonnull.astype(str).nunique())
    if pd.api.types.is_datetime64_any_dtype(s) or _all_datetime_objects(s):
        return ("binary" if n_unique == 2 else "datetime"), n_unique
    if n_unique == 2:
        return "binary", n_unique
    if numeric_values(s) is not None:
        return "numeric", n_unique
    ratio = n_unique / max(len(nonnull), 1)
    if n_unique > TEXT_MIN_UNIQUE and ratio > TEXT_UNIQUE_RATIO:
        return "text", n_unique
    return "categorical", n_unique


def _norm_name(name: str) -> str:
    s = re.sub(r"[^0-9a-z]+", "_", name.lower()).strip("_")
    return s


_TREATMENT_EXACT = {
    "group", "cell", "test_control", "testcontrol", "test_group", "exposed", "exposure",
    "treatment", "condition", "test_cell", "exposed_control", "control_exposed", "test_vs_control",
}
_OUTCOME_TOKENS = (
    "awareness", "favorab", "favourab", "consideration", "intent", "recall", "recommend",
    "kpi", "aided", "unaided", "nps",
)


def suggest_role(name: str, kind: ColumnKind, n_unique: int, n_rows: int) -> str:
    n = _norm_name(name)
    tokens = set(n.split("_"))
    is_id = (
        n in {"id", "resp_id", "respid", "uuid", "respondent", "respondent_id", "respondentid", "record_id"}
        or n.endswith("_id")
        or n.startswith("id_")
        or "respondent" in n
        or "uuid" in n
        or "resp_id" in n
    )
    if is_id and (kind in ("text", "numeric", "categorical") and n_unique >= 0.5 * max(n_rows, 1)):
        return "id"
    if kind in ("text", "datetime", "empty"):
        return "ignore"
    is_treat = (
        n in _TREATMENT_EXACT
        or "expos" in n
        or "test_control" in n
        or "testcontrol" in n
        or ("cell" in tokens and len(tokens) <= 2)
    )
    if is_treat and kind in ("binary", "categorical") and n_unique <= 10:
        return "treatment"
    if any(tok in n for tok in _OUTCOME_TOKENS):
        return "outcome"
    if is_id:
        return "id"
    return "model_feature"


def profile_column(s: pd.Series, name: str, n_rows: int) -> ColumnProfile:
    kind, n_unique = infer_kind(s)
    n_missing = int(s.isna().sum())
    if s.dtype == object or pd.api.types.is_string_dtype(s):
        n_missing += int(s.dropna().astype(str).str.strip().eq("").sum())
    top: List[ValueCount] = []
    if kind != "empty":
        try:
            vc = s.dropna().value_counts()
        except TypeError:
            vc = s.dropna().astype(str).value_counts()
        for val, cnt in vc.iloc[:20].items():
            jv = json_scalar(val)
            if jv is None or (isinstance(jv, str) and jv.strip() == ""):
                continue
            top.append(ValueCount(value=jv, count=int(cnt)))
    mn = mx = mean = None
    if kind in ("numeric", "binary"):
        nv = numeric_values(s)
        if nv is not None and nv.notna().any():
            mn, mx, mean = (finite_or_none(nv.min()), finite_or_none(nv.max()), finite_or_none(nv.mean()))
    return ColumnProfile(
        name=name,
        kind=kind,
        n_missing=n_missing,
        n_unique=n_unique,
        top_values=top,
        min=mn,
        max=mx,
        mean=mean,
        suggested_role=suggest_role(name, kind, n_unique, n_rows),  # type: ignore[arg-type]
    )


def profile_dataframe(
    df: pd.DataFrame,
    dataset_id: str,
    filename: str,
    sheet_names: Optional[Sequence[str]] = None,
    sheet: Optional[str] = None,
) -> DatasetProfile:
    """Profile every column of ``df``."""
    n_rows = int(len(df))
    cols = [profile_column(df[c], str(c), n_rows) for c in df.columns]
    return DatasetProfile(
        dataset_id=dataset_id,
        filename=filename,
        sheet_names=list(sheet_names or []),
        sheet=sheet,
        n_rows=n_rows,
        n_cols=int(df.shape[1]),
        columns=cols,
    )
