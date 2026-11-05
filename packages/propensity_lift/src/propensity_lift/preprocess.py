"""Treatment coding, outcome recoding and feature encoding."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

from ._utils import Key, level_label, norm_key, series_keys
from .io import numeric_values

# --------------------------------------------------------------------------- #
# treatment
# --------------------------------------------------------------------------- #


def code_treatment(
    s: pd.Series,
    exposed_values: Sequence[Any],
    control_values: Optional[Sequence[Any]] = None,
) -> np.ndarray:
    """Code a treatment column as 1 (exposed), 0 (control) or -1 (missing / neither).

    Values are compared robustly: ``1``, ``1.0``, ``"1"`` and ``True`` are equal;
    strings are compared case-insensitively after stripping.
    """
    exp_keys = {norm_key(v) for v in exposed_values} - {None}
    if not exp_keys:
        raise ValueError("exposed_values must contain at least one non-missing value")
    ctl_keys = None
    if control_values is not None and len(control_values) > 0:
        ctl_keys = {norm_key(v) for v in control_values} - {None}
        both = exp_keys & ctl_keys
        if both:
            raise ValueError(f"Values {sorted(map(str, both))} are listed as both exposed and control")
    keys = series_keys(s)
    out = np.full(len(keys), -1, dtype=np.int8)
    for i, k in enumerate(keys):
        if k is None:
            continue
        if k in exp_keys:
            out[i] = 1
        elif ctl_keys is None or k in ctl_keys:
            out[i] = 0
    return out


# --------------------------------------------------------------------------- #
# outcomes
# --------------------------------------------------------------------------- #
POSITIVE_LABELS = {
    "yes", "y", "true", "positive", "aware", "selected", "checked", "agree", "recalled",
    "favorable", "favourable", "considered", "1",
}
NEGATIVE_LABELS = {
    "no", "n", "false", "negative", "not aware", "unaware", "not selected", "unchecked",
    "disagree", "none", "not recalled", "unfavorable", "unfavourable", "0",
}


@dataclass
class OutcomeData:
    name: str
    y: np.ndarray            # float, nan where missing
    outcome_type: str        # "binary" | "continuous"
    note: Optional[str] = None


def recode_outcome(
    s: pd.Series, name: str, positive_values: Optional[Sequence[Any]] = None
) -> OutcomeData:
    """Recode an outcome column to a float vector.

    * ``positive_values`` given -> 1 if value in list else 0 (missing stays missing)
    * values {0, 1} -> binary; two text labels -> binary when one is a known yes/no label (note says which)
    * any other numeric pair (e.g. SPSS 1=Yes/2=No) -> continuous with a note; set positive_values
    * numeric -> continuous
    * otherwise ValueError
    """
    keys = series_keys(s)
    n = len(keys)
    y = np.full(n, np.nan)
    if positive_values is not None and len(positive_values) > 0:
        pos = {norm_key(v) for v in positive_values} - {None}
        for i, k in enumerate(keys):
            if k is not None:
                y[i] = 1.0 if k in pos else 0.0
        if np.nansum(y) == 0:
            note = f"Outcome '{name}': none of the positive values {list(positive_values)} occur in the data"
        else:
            note = None
        return OutcomeData(name, y, "binary", note)

    distinct = {k for k in keys if k is not None}
    if not distinct:
        raise ValueError(f"Outcome column '{name}' has no non-missing values")
    if len(distinct) <= 2:
        pos_key, note = _positive_key(distinct, name)
        if pos_key is not None:
            for i, k in enumerate(keys):
                if k is not None:
                    y[i] = 1.0 if k == pos_key else 0.0
            return OutcomeData(name, y, "binary", note)
    if all(k[0] == "n" for k in distinct):
        for i, k in enumerate(keys):
            if k is not None:
                y[i] = float(k[1])
        note = None
        if len(distinct) == 2:
            levels = sorted(_fmt_num(k[1]) for k in distinct)
            note = (
                f"Outcome '{name}' has two numeric levels {levels}; treated as continuous. "
                f"Set outcome_positive_values (e.g. [1] for SPSS 1=Yes/2=No) to analyse it as binary."
            )
        return OutcomeData(name, y, "continuous", note)
    labels = sorted(str(k[1]) for k in distinct)[:8]
    raise ValueError(
        f"Outcome '{name}' is non-numeric with {len(distinct)} levels (e.g. {labels}); "
        f"specify outcome_positive_values for it (e.g. top-2-box) to recode it to binary"
    )


def _fmt_num(v: Any) -> Any:
    f = float(v)
    return int(f) if f.is_integer() else f


def _positive_key(distinct: set, name: str) -> Tuple[Optional[Key], Optional[str]]:
    """Pick the level coded 1 for a <= 2-level outcome -> (key or None, note).

    Numeric pairs are only auto-recoded when they are exactly {0, 1}: survey
    exports commonly code 1=Yes / 2=No, so "larger number = positive" would
    silently flip the sign of the lift. Other numeric pairs return None
    (-> analysed as continuous, with a note)."""
    ks = list(distinct)
    if len(ks) == 1:
        k = ks[0]
        if k[0] == "n":
            return None, None  # constant number -> continuous
        if k[1] in POSITIVE_LABELS:
            return k, f"Outcome '{name}' has a single level '{k[1]}', treated as positive (1)"
        if k[1] in NEGATIVE_LABELS:
            return ("__none__", None), f"Outcome '{name}' has a single level '{k[1]}', treated as negative (0)"
        raise ValueError(f"Outcome '{name}' has a single non-numeric level; specify outcome_positive_values")
    a, b = ks
    if a[0] == "n" and b[0] == "n":
        if {float(a[1]), float(b[1])} == {0.0, 1.0}:
            return (a if float(a[1]) == 1.0 else b), None
        return None, None
    pos = None
    for k in ks:
        if k[0] == "s" and k[1] in POSITIVE_LABELS:
            pos = k
            break
    if pos is None:
        for k, other in ((a, b), (b, a)):
            if k[0] == "s" and k[1] in NEGATIVE_LABELS:
                pos = other
                break
    if pos is not None:
        neg = b if pos == a else a
        return pos, (
            f"Outcome '{name}': '{_fmt_num(pos[1]) if pos[0] == 'n' else pos[1]}' treated as positive (1), "
            f"'{_fmt_num(neg[1]) if neg[0] == 'n' else neg[1]}' as 0"
        )
    raise ValueError(
        f"Outcome '{name}' has two levels {[str(a[1]), str(b[1])]} and it is unclear which is positive; "
        f"specify outcome_positive_values"
    )


# --------------------------------------------------------------------------- #
# features
# --------------------------------------------------------------------------- #
@dataclass
class EncodedFeatures:
    X: np.ndarray                      # n x p float
    names: List[str]                   # encoded variable names
    sources: List[str]                 # source column per encoded variable
    is_dummy: List[bool]
    warnings: List[str] = field(default_factory=list)

    def subset(self, sources: Sequence[str]) -> "EncodedFeatures":
        keep = [i for i, s in enumerate(self.sources) if s in set(sources)]
        return EncodedFeatures(
            self.X[:, keep], [self.names[i] for i in keep], [self.sources[i] for i in keep],
            [self.is_dummy[i] for i in keep], [],
        )


def feature_numeric(s: pd.Series) -> Optional[np.ndarray]:
    """Numeric representation of a feature column, or None if categorical."""
    if pd.api.types.is_datetime64_any_dtype(s):
        v = pd.to_datetime(s, errors="coerce")
        out = (v - pd.Timestamp("1970-01-01")).dt.total_seconds() / 86400.0
        return out.to_numpy(dtype=float)
    nv = numeric_values(s)
    if nv is None:
        return None
    return nv.to_numpy(dtype=float)


def feature_missing_mask(df: pd.DataFrame, cols: Sequence[str]) -> np.ndarray:
    m = np.zeros(len(df), dtype=bool)
    for c in cols:
        s = df[c]
        miss = s.isna().to_numpy()
        if s.dtype == object or pd.api.types.is_string_dtype(s):
            miss = miss | s.astype(object).map(lambda v: isinstance(v, str) and v.strip() == "").to_numpy()
        m |= miss
    return m


def categorical_labels(s: pd.Series) -> np.ndarray:
    vals = s.to_numpy(dtype=object)
    cache: Dict[Any, str] = {}
    out = np.empty(len(vals), dtype=object)
    for i, v in enumerate(vals):
        try:
            lab = cache[v]
        except (KeyError, TypeError):
            lab = level_label(v)
            if isinstance(v, str) and v.strip() == "":
                lab = "(missing)"
            else:
                lab = lab.strip()
            try:
                cache[v] = lab
            except TypeError:
                pass
        out[i] = lab
    return out


def encode_features(
    df: pd.DataFrame,
    features: Sequence[str],
    rare_threshold: float = 0.01,
    max_levels: int = 30,
) -> EncodedFeatures:
    """One-hot encode categoricals (rare levels pooled into ``__other__``), median-impute
    numerics and add ``<col>__missing`` indicators when any value is missing."""
    n = len(df)
    cols: List[np.ndarray] = []
    names: List[str] = []
    sources: List[str] = []
    dummy: List[bool] = []
    warnings: List[str] = []
    for f in features:
        s = df[f]
        x = feature_numeric(s)
        if x is not None:
            miss = ~np.isfinite(x)
            if miss.all():
                warnings.append(f"Feature '{f}' has no usable values and was ignored")
                continue
            med = float(np.median(x[~miss]))
            x = np.where(miss, med, x)
            varies = np.nanstd(x) > 0
            if varies:
                cols.append(x)
                names.append(f)
                sources.append(f)
                dummy.append(bool(set(np.unique(x)) <= {0.0, 1.0}))
            if miss.any() and not miss.all():
                cols.append(miss.astype(float))
                names.append(f"{f}__missing")
                sources.append(f)
                dummy.append(True)
            if not varies and not miss.any():
                warnings.append(f"Feature '{f}' is constant and was ignored")
            continue
        labels = categorical_labels(s)
        vc = pd.Series(labels).value_counts()
        keep = [lv for lv, c in vc.items() if c >= rare_threshold * n][:max_levels]
        keep_set = set(keep)
        pooled = np.array([lv if lv in keep_set else "__other__" for lv in labels], dtype=object)
        levels = list(keep) + (["__other__"] if (pooled == "__other__").any() else [])
        if len(levels) <= 1:
            warnings.append(f"Feature '{f}' has a single level and was ignored")
            continue
        for lv in levels:
            cols.append((pooled == lv).astype(float))
            names.append(f"{f}={lv}")
            sources.append(f)
            dummy.append(True)
    X = np.column_stack(cols) if cols else np.zeros((n, 0))
    return EncodedFeatures(X, names, sources, dummy, warnings)


def matching_strata(df: pd.DataFrame, features: Sequence[str]) -> Tuple[np.ndarray, int]:
    """Integer exact-match stratum per row. Numeric features with > 10 unique
    values are coarsened into quintiles. Returns (codes, n_strata)."""
    n = len(df)
    if not features:
        return np.zeros(n, dtype=np.int64), 0
    parts = []
    for f in features:
        s = df[f]
        x = feature_numeric(s)
        if x is not None and len(np.unique(x[np.isfinite(x)])) > 10:
            q = pd.qcut(pd.Series(x), 5, labels=False, duplicates="drop")
            lab = np.where(np.isfinite(x), q.fillna(-1).astype(int).astype(str), "(missing)")
        else:
            lab = categorical_labels(s)
        parts.append(np.asarray(lab, dtype=str))
    joined = parts[0].astype(object)
    for p in parts[1:]:
        joined = joined + "\x1f" + p.astype(object)
    codes, uniq = pd.factorize(pd.Series(joined))
    return codes.astype(np.int64), int(len(uniq))
