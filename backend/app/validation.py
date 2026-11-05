"""Synchronous pre-flight checks for ``POST /api/analyses`` (cheap; reads only the treatment column)."""

from __future__ import annotations

import math
from typing import Any, Iterable, List, Optional

import pandas as pd
from propensity_lift.schemas import AnalysisConfig, DatasetProfile

MIN_GROUP_SIZE = 10


class ConfigInvalid(ValueError):
    pass


def normalise_value(value: Any) -> Optional[str]:
    """Canonical string for comparing treatment codes typed in JSON with cell values.

    ``1``, ``1.0``, ``"1"``, ``True`` all map to ``"1"``; strings are stripped.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)) or hasattr(value, "dtype"):
        try:
            f = float(value)
        except (TypeError, ValueError):
            return str(value).strip()
        if math.isnan(f):
            return None
        return str(int(f)) if f.is_integer() else repr(f)
    s = str(value).strip()
    low = s.lower()
    if low in ("true", "false"):
        return "1" if low == "true" else "0"
    try:
        f = float(s)
    except ValueError:
        return s
    if math.isnan(f):
        return s
    return str(int(f)) if f.is_integer() else repr(f)


def _fmt(cols: Iterable[str]) -> str:
    return ", ".join(f"'{c}'" for c in cols)


def check_columns(config: AnalysisConfig, profile: DatasetProfile) -> List[str]:
    errors: List[str] = []
    available = {c.name for c in profile.columns}
    sheet_label = f" in sheet '{profile.sheet}'" if profile.sheet else ""

    def missing(cols: Iterable[str]) -> List[str]:
        return [c for c in dict.fromkeys(cols) if c not in available]

    groups = [
        ("Treatment column", [config.treatment_column]),
        ("Outcome column(s)", config.outcome_columns),
        ("Model feature(s)", config.model_features),
        ("Matching feature(s)", config.matching_features),
        ("Subgroup column(s)", config.subgroup_columns),
        ("Outcome recode column(s)", list(config.outcome_positive_values)),
    ]
    for label, cols in groups:
        bad = missing(cols)
        if bad:
            errors.append(f"{label} not found{sheet_label}: {_fmt(bad)}.")

    features = set(config.model_features) | set(config.matching_features)
    if not features:
        errors.append("Select at least one model feature or matching feature.")
    overlap = [c for c in config.outcome_columns if c in features]
    if overlap:
        errors.append(f"Outcome column(s) cannot also be features: {_fmt(overlap)}.")
    if config.treatment_column in features:
        errors.append(f"Treatment column '{config.treatment_column}' cannot also be a feature.")
    if config.treatment_column in config.outcome_columns:
        errors.append(f"Treatment column '{config.treatment_column}' cannot also be an outcome.")
    if config.treatment_column in config.subgroup_columns:
        errors.append(f"Treatment column '{config.treatment_column}' cannot be a subgroup column.")
    stray = [c for c in config.outcome_positive_values if c not in config.outcome_columns]
    if stray:
        errors.append(f"Outcome recode given for column(s) that are not outcomes: {_fmt(stray)}.")
    if not config.exposed_values:
        errors.append("Select at least one treatment value meaning 'exposed'.")
    return errors


def _code_treatment(config: AnalysisConfig, treatment: pd.Series):
    """1 exposed / 0 control / -1 neither, using the analysis package's own matching rules
    (case-insensitive strings; 1 == 1.0 == "1" == True) so validation agrees with the run."""
    control_values = config.control_values or None
    try:
        from propensity_lift.preprocess import code_treatment
    except ImportError:  # pragma: no cover - package layout changed; use local equivalent
        code_treatment = None
    if code_treatment is not None:
        return code_treatment(treatment, config.exposed_values, control_values)
    exposed = {normalise_value(v) for v in config.exposed_values} - {None}
    control = {normalise_value(v) for v in control_values} - {None} if control_values else None
    out = []
    for v in treatment.tolist():
        k = normalise_value(v)
        out.append(-1 if k is None else 1 if k in exposed else 0 if control is None or k in control else -1)
    return pd.Series(out).to_numpy()


def check_groups(config: AnalysisConfig, treatment: pd.Series) -> List[str]:
    try:
        coded = _code_treatment(config, treatment)
    except ValueError as exc:
        return [str(exc) + "."]
    n_exposed = int((coded == 1).sum())
    n_control = int((coded == 0).sum())
    errors: List[str] = []
    for label, n in (("exposed", n_exposed), ("control", n_control)):
        if n < MIN_GROUP_SIZE:
            errors.append(
                f"The {label} group has {n} respondent(s) in '{config.treatment_column}'; "
                f"at least {MIN_GROUP_SIZE} are required. Check the {label} values selected."
            )
    return errors
