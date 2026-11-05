"""Propensity-score weights: IPW (ATT/ATE), overlap weights, stratification."""

from __future__ import annotations

from typing import Optional, Tuple

import numpy as np

from ._utils import EPS


def ipw_weights(ps: np.ndarray, t: np.ndarray, estimand: str = "ATT") -> np.ndarray:
    """ATT: exposed 1, control e/(1-e).  ATE: exposed 1/e, control 1/(1-e)."""
    ps = np.clip(np.asarray(ps, float), EPS, 1 - EPS)
    t = np.asarray(t).astype(bool)
    if estimand == "ATT":
        return np.where(t, 1.0, ps / (1 - ps))
    return np.where(t, 1.0 / ps, 1.0 / (1 - ps))


def overlap_weights(ps: np.ndarray, t: np.ndarray) -> np.ndarray:
    """Overlap (ATO) weights: exposed 1-e, control e."""
    ps = np.clip(np.asarray(ps, float), EPS, 1 - EPS)
    t = np.asarray(t).astype(bool)
    return np.where(t, 1 - ps, ps)


def stratification_weights(
    ps: np.ndarray, t: np.ndarray, n_strata: int = 5, estimand: str = "ATT"
) -> Tuple[np.ndarray, int]:
    """PS-quantile strata (exposed quantiles for ATT, all units for ATE).

    ATT: exposed 1, control n_e,s / n_c,s.  ATE: exposed n_s / n_e,s, control n_s / n_c,s.
    Units in strata lacking either group get weight 0. Returns (weights, n_empty_strata).
    """
    ps = np.asarray(ps, float)
    t = np.asarray(t).astype(bool)
    ref = ps[t] if estimand == "ATT" else ps
    if ref.size == 0:
        return np.zeros_like(ps), n_strata
    inner = np.unique(np.quantile(ref, np.linspace(0, 1, n_strata + 1)[1:-1]))
    s = np.searchsorted(inner, ps, side="right")
    k = inner.size + 1
    ne = np.bincount(s[t], minlength=k).astype(float)
    nc = np.bincount(s[~t], minlength=k).astype(float)
    ok = (ne > 0) & (nc > 0)
    with np.errstate(divide="ignore", invalid="ignore"):
        if estimand == "ATT":
            we = np.where(ok, 1.0, 0.0)
            wc = np.where(ok, ne / nc, 0.0)
        else:
            ns = ne + nc
            we = np.where(ok, ns / ne, 0.0)
            wc = np.where(ok, ns / nc, 0.0)
    w = np.where(t, we[s], wc[s])
    return np.nan_to_num(w), int((~ok).sum())


def clip_weights(w: np.ndarray, t: np.ndarray, quantile: Optional[float]) -> Tuple[np.ndarray, int]:
    """Cap weights at the ``quantile`` of their group (groups with constant weights untouched)."""
    if quantile is None or not (0 < quantile < 1):
        return w, 0
    w = np.asarray(w, float).copy()
    t = np.asarray(t).astype(bool)
    n_clipped = 0
    for g in (t, ~t):
        wg = w[g]
        pos = wg[wg > 0]
        if pos.size < 2 or np.ptp(pos) == 0:
            continue
        cap = float(np.quantile(pos, quantile))
        over = wg > cap
        n_clipped += int(over.sum())
        wg[over] = cap
        w[g] = wg
    return w, n_clipped


def normalize_within_group(w: np.ndarray, t: np.ndarray) -> np.ndarray:
    """Scale weights so each group's weights sum to its number of units."""
    w = np.asarray(w, float).copy()
    t = np.asarray(t).astype(bool)
    for g in (t, ~t):
        s = w[g].sum()
        if s > 0:
            w[g] = w[g] * (g.sum() / s)
    return w


def kish_ess(w: np.ndarray) -> float:
    """Kish effective sample size (sum w)^2 / sum w^2."""
    w = np.asarray(w, float)
    s2 = float((w**2).sum())
    return float(w.sum() ** 2 / s2) if s2 > 0 else 0.0
