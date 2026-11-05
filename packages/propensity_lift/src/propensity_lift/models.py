"""Propensity score models."""

from __future__ import annotations

import warnings
from typing import List, Optional, Sequence, Tuple

import numpy as np
from sklearn.base import clone
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.exceptions import ConvergenceWarning
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import StratifiedKFold
from sklearn.preprocessing import StandardScaler

from ._utils import EPS, finite
from .schemas import FeatureImportance, ModelSummary, ModelType


def logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(p, EPS, 1 - EPS)
    return np.log(p / (1 - p))


def calibration_table(ps: np.ndarray, t: np.ndarray, n_bins: int = 10) -> List[List[float]]:
    """[[mean_pred, observed_rate, n], ...] by PS deciles."""
    if ps.size == 0:
        return []
    qs = np.unique(np.quantile(ps, np.linspace(0, 1, n_bins + 1)))
    if qs.size < 2:
        return [[finite(ps.mean()), finite(t.mean()), float(ps.size)]]
    b = np.clip(np.searchsorted(qs, ps, side="right") - 1, 0, qs.size - 2)
    out = []
    for k in range(qs.size - 1):
        m = b == k
        if m.any():
            out.append([finite(ps[m].mean()), finite(t[m].mean()), float(m.sum())])
    return out


def _aggregate_importance(raw: np.ndarray, sources: Sequence[str]) -> List[FeatureImportance]:
    agg: dict = {}
    for v, s in zip(np.abs(raw), sources):
        agg[s] = agg.get(s, 0.0) + finite(v)
    tot = sum(agg.values())
    items = [
        FeatureImportance(feature=k, importance=(v / tot if tot > 0 else 0.0)) for k, v in agg.items()
    ]
    items.sort(key=lambda fi: fi.importance, reverse=True)
    return items


def _cross_fitted_ps(model, X: np.ndarray, t: np.ndarray, random_state: int, n_folds: int = 5) -> np.ndarray:
    """Out-of-fold P(exposed) from clones of ``model`` (falls back to in-sample when a group is tiny)."""
    k = int(min(n_folds, np.bincount(t, minlength=2).min()))
    if k < 2:
        return model.predict_proba(X)[:, 1]
    ps = np.empty(len(t), dtype=float)
    folds = StratifiedKFold(n_splits=k, shuffle=True, random_state=random_state)
    for train, test in folds.split(X, t):
        m = clone(model).fit(X[train], t[train])
        ps[test] = m.predict_proba(X[test])[:, 1]
    return ps


def fit_propensity(
    X: np.ndarray,
    t: np.ndarray,
    model_type: ModelType = "logistic",
    random_state: int = 42,
    source_features: Optional[Sequence[str]] = None,
) -> Tuple[np.ndarray, ModelSummary]:
    """Fit P(exposed | X). Returns (ps, ModelSummary). ``t`` is 0/1."""
    t = np.asarray(t).astype(int)
    n, p = X.shape
    sources = list(source_features) if source_features is not None else [f"x{i}" for i in range(p)]
    if p == 0:
        ps = np.full(n, t.mean())
        raw_imp = np.zeros(0)
    elif model_type == "logistic":
        Xs = StandardScaler().fit_transform(X)
        model = LogisticRegression(C=1.0, max_iter=2000)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", ConvergenceWarning)
            model.fit(Xs, t)
        ps = model.predict_proba(Xs)[:, 1]
        raw_imp = np.abs(model.coef_[0])
    elif model_type == "gradient_boosting":
        model = GradientBoostingClassifier(
            n_estimators=150, max_depth=3, learning_rate=0.05, subsample=0.8,
            min_samples_leaf=20, random_state=random_state,
        )
        model.fit(X, t)
        raw_imp = model.feature_importances_
        # Cross-fitted (out-of-fold) predictions: in-sample boosted scores are over-confident,
        # which separates the groups artificially and hurts matching/stratification balance.
        ps = _cross_fitted_ps(model, X, t, random_state)
    elif model_type == "random_forest":
        model = RandomForestClassifier(
            n_estimators=300, min_samples_leaf=10, max_features="sqrt", oob_score=True,
            random_state=random_state, n_jobs=1,
        )
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            model.fit(X, t)
        # out-of-bag predictions avoid the extreme in-sample PS of a forest
        oob = getattr(model, "oob_decision_function_", None)
        ps = model.predict_proba(X)[:, 1]
        if oob is not None:
            o = oob[:, 1]
            ps = np.where(np.isfinite(o), o, ps)
        raw_imp = model.feature_importances_
    else:  # pragma: no cover - guarded by pydantic Literal
        raise ValueError(f"Unknown model_type {model_type}")

    ps = np.clip(np.asarray(ps, dtype=float), EPS, 1 - EPS)
    try:
        auc = float(roc_auc_score(t, ps)) if 0 < t.sum() < n else 0.5
    except ValueError:
        auc = 0.5
    summary = ModelSummary(
        model_type=model_type,
        auc=finite(auc, 0.5),
        n_encoded_features=int(p),
        feature_importance=_aggregate_importance(raw_imp, sources) if p else [],
        calibration=calibration_table(ps, t),
    )
    return ps, summary
