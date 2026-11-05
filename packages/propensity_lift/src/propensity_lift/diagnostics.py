"""Covariate balance diagnostics (standardised mean differences, variance ratios)."""

from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from ._utils import finite, finite_or_none
from .schemas import BalanceRow, BalanceSummary

SMD_THRESHOLD = 0.1


def weighted_mean_var(X: np.ndarray, w: Optional[np.ndarray] = None) -> Tuple[np.ndarray, np.ndarray]:
    """Column-wise weighted mean and (population) variance sum w (x-mu)^2 / sum w."""
    X = np.asarray(X, float)
    if X.ndim == 1:
        X = X[:, None]
    if w is None:
        w = np.ones(X.shape[0])
    w = np.asarray(w, float)
    sw = w.sum()
    if sw <= 0:
        nan = np.full(X.shape[1], np.nan)
        return nan, nan
    mu = (w[:, None] * X).sum(0) / sw
    var = (w[:, None] * (X - mu) ** 2).sum(0) / sw
    return mu, var


def smd(
    x_e: np.ndarray,
    x_c: np.ndarray,
    w_e: Optional[np.ndarray] = None,
    w_c: Optional[np.ndarray] = None,
    pooled_sd: Optional[float] = None,
) -> float:
    """(mean_e - mean_c) / sqrt((var_e + var_c)/2). ``pooled_sd`` overrides the denominator
    (used to keep the unadjusted denominator after adjustment)."""
    me, ve = weighted_mean_var(x_e, w_e)
    mc, vc = weighted_mean_var(x_c, w_c)
    sd = pooled_sd if pooled_sd is not None else float(np.sqrt((ve[0] + vc[0]) / 2))
    if not np.isfinite(sd) or sd <= 0:
        return 0.0
    return float((me[0] - mc[0]) / sd)


def balance_table(
    X: np.ndarray,
    t: np.ndarray,
    w_after: np.ndarray,
    names: Sequence[str],
    sources: Sequence[str],
    is_dummy: Sequence[bool],
    roles: Dict[str, str],
    before_mask: Optional[np.ndarray] = None,
) -> Tuple[List[BalanceRow], BalanceSummary]:
    """Balance before (unweighted, rows in ``before_mask``) and after (``w_after``).

    SMD denominators use the unadjusted pooled SD for both before and after.
    """
    t = np.asarray(t).astype(bool)
    n = len(t)
    if before_mask is None:
        before_mask = np.ones(n, bool)
    eb, cb = before_mask & t, before_mask & ~t
    me_b, ve_b = weighted_mean_var(X[eb])
    mc_b, vc_b = weighted_mean_var(X[cb])
    w_after = np.asarray(w_after, float)
    ea, ca = t & (w_after > 0), ~t & (w_after > 0)
    me_a, ve_a = weighted_mean_var(X[ea], w_after[ea])
    mc_a, vc_a = weighted_mean_var(X[ca], w_after[ca])
    sd = np.sqrt((ve_b + vc_b) / 2)
    with np.errstate(divide="ignore", invalid="ignore"):
        smd_b = np.where(sd > 0, (me_b - mc_b) / sd, 0.0)
        smd_a = np.where(sd > 0, (me_a - mc_a) / sd, 0.0)
        vr_b = np.where(vc_b > 0, ve_b / vc_b, np.nan)
        vr_a = np.where(vc_a > 0, ve_a / vc_a, np.nan)
    rows: List[BalanceRow] = []
    for j, name in enumerate(names):
        src = sources[j]
        rows.append(
            BalanceRow(
                variable=name,
                source_feature=src,
                role=roles.get(src, "model"),  # type: ignore[arg-type]
                mean_exposed_before=finite(me_b[j]),
                mean_control_before=finite(mc_b[j]),
                smd_before=finite(smd_b[j]),
                var_ratio_before=None if is_dummy[j] else finite_or_none(vr_b[j]),
                mean_exposed_after=finite(me_a[j]),
                mean_control_after=finite(mc_a[j]),
                smd_after=finite(smd_a[j]),
                var_ratio_after=None if is_dummy[j] else finite_or_none(vr_a[j]),
            )
        )
    return rows, summarize_balance(rows)


def summarize_balance(rows: Sequence[BalanceRow]) -> BalanceSummary:
    if not rows:
        return BalanceSummary(
            max_abs_smd_before=0.0, max_abs_smd_after=0.0, mean_abs_smd_before=0.0,
            mean_abs_smd_after=0.0, n_imbalanced_before=0, n_imbalanced_after=0,
        )
    b = np.abs([r.smd_before for r in rows])
    a = np.abs([r.smd_after for r in rows])
    return BalanceSummary(
        max_abs_smd_before=finite(b.max()),
        max_abs_smd_after=finite(a.max()),
        mean_abs_smd_before=finite(b.mean()),
        mean_abs_smd_after=finite(a.mean()),
        n_imbalanced_before=int((b > SMD_THRESHOLD).sum()),
        n_imbalanced_after=int((a > SMD_THRESHOLD).sum()),
    )
