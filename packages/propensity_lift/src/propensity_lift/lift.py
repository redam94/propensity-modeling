"""Outcome contrasts: weighted means, absolute / relative lift, SEs, CIs, p-values.

Everything is computed for many outcomes (K) and many row-groups (G: the full
sample plus each subgroup level) at once with matrix products, so bootstrap
replicates are cheap: per replicate we only need the replicate weights.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable, List, Optional, Sequence

import numpy as np
from scipy.stats import norm

from ._utils import finite, finite_or_none


@dataclass
class Sums:
    sw: np.ndarray     # G x K  sum of weights over valid rows
    swy: np.ndarray    # G x K  sum w*y
    swy2: np.ndarray   # G x K  sum w*y^2
    sw2: np.ndarray    # G x K  sum w^2
    cnt: np.ndarray    # G x K  number of valid rows with w > 0

    def mean(self) -> np.ndarray:
        with np.errstate(divide="ignore", invalid="ignore"):
            return np.where(self.sw > 0, self.swy / self.sw, np.nan)

    def var(self) -> np.ndarray:
        """Weighted (population) variance."""
        with np.errstate(divide="ignore", invalid="ignore"):
            mu = self.mean()
            v = np.where(self.sw > 0, self.swy2 / self.sw - mu**2, np.nan)
        return np.maximum(v, 0.0)

    def ess(self) -> np.ndarray:
        with np.errstate(divide="ignore", invalid="ignore"):
            return np.where(self.sw2 > 0, self.sw**2 / self.sw2, 0.0)


def outcome_matrix(ys: Sequence[np.ndarray]):
    """Stack outcome vectors -> (Y with 0 for missing, M validity mask) both n x K."""
    Yr = np.column_stack(ys) if len(ys) else np.zeros((0, 0))
    M = np.isfinite(Yr).astype(float)
    Y = np.where(M > 0, Yr, 0.0)
    return Y, M


def group_sums(w: np.ndarray, D: np.ndarray, Y: np.ndarray, M: np.ndarray, full: bool = True) -> Sums:
    """Sums for one treatment group: ``w`` already zero outside the group.
    D: n x G group-membership matrix (0/1)."""
    wM = w[:, None] * M
    wY = w[:, None] * Y
    sw = D.T @ wM
    swy = D.T @ wY
    if not full:
        z = np.zeros_like(sw)
        return Sums(sw, swy, z, z, z)
    swy2 = D.T @ (wY * Y)
    sw2 = D.T @ ((w**2)[:, None] * M)
    cnt = D.T @ ((w > 0).astype(float)[:, None] * M)
    return Sums(sw, swy, swy2, sw2, cnt)


def lift_only(w: np.ndarray, t: np.ndarray, D: np.ndarray, Y: np.ndarray, M: np.ndarray) -> np.ndarray:
    """G x K lift (weighted exposed mean - weighted control mean) for weights ``w``."""
    te = t.astype(float)
    se = group_sums(w * te, D, Y, M, full=False)
    sc = group_sums(w * (1 - te), D, Y, M, full=False)
    return se.mean() - sc.mean()


def analytic_se(e: Sums, c: Sums) -> np.ndarray:
    """SE of a difference of weighted means: sqrt(var_e/ESS_e + var_c/ESS_c)."""
    with np.errstate(divide="ignore", invalid="ignore"):
        ve = np.where(e.ess() > 0, e.var() / e.ess(), np.nan)
        vc = np.where(c.ess() > 0, c.var() / c.ess(), np.nan)
    return np.sqrt(ve + vc)


def bootstrap_se(boot_lifts: np.ndarray) -> np.ndarray:
    """SD over replicates (axis 0), ignoring non-finite replicates; nan if < 2 valid."""
    b = np.asarray(boot_lifts, float)
    valid = np.isfinite(b)
    n = valid.sum(0)
    bz = np.where(valid, b, 0.0)
    with np.errstate(divide="ignore", invalid="ignore"):
        mu = bz.sum(0) / n
        var = (np.where(valid, (b - mu) ** 2, 0.0)).sum(0) / (n - 1)
    return np.where(n >= 2, np.sqrt(var), np.nan)


def p_value(lift: float, se: float) -> float:
    if not (math.isfinite(lift) and math.isfinite(se)):
        return 1.0
    if se <= 0:
        return 1.0 if abs(lift) < 1e-12 else 0.0
    return float(2 * norm.sf(abs(lift / se)))


def normal_ci(lift: float, se: float, alpha: float):
    z = float(norm.ppf(1 - alpha / 2))
    return lift - z * se, lift + z * se


def contrast_fields(
    *,
    outcome: str,
    outcome_type: str,
    exposed_mean: float,
    control_mean_raw: float,
    raw_exposed_mean: float,
    control_mean_adjusted: float,
    n_exposed: int,
    n_control: int,
    effective_n_control: float,
    se: float,
    ci_method: str,
    alpha: float,
    warn: Optional[Callable[[str], None]] = None,
) -> dict:
    """Assemble a JSON-safe dict of OutcomeContrast fields."""
    def chk(v, label):
        if v is None or not math.isfinite(v):
            if warn is not None:
                warn(f"{outcome}: {label} undefined (no data); reported as 0")
            return 0.0
        return float(v)

    em = chk(exposed_mean, "exposed mean")
    cm_adj = chk(control_mean_adjusted, "adjusted control mean")
    cm_raw = chk(control_mean_raw, "raw control mean")
    rem = chk(raw_exposed_mean, "raw exposed mean")
    lift = em - cm_adj
    se_f = finite(se, 0.0)
    if not math.isfinite(se if se is not None else float("nan")):
        if warn is not None:
            warn(f"{outcome}: standard error undefined; reported as 0")
    lo, hi = normal_ci(lift, se_f, alpha)
    p = p_value(lift, se_f) if se_f > 0 or lift == 0 else 1.0
    rel = finite_or_none(lift / cm_adj * 100.0) if abs(cm_adj) > 1e-12 else None
    return dict(
        outcome=outcome,
        outcome_type=outcome_type,
        n_exposed=int(n_exposed),
        n_control=int(n_control),
        effective_n_control=finite(effective_n_control),
        exposed_mean=em,
        control_mean_raw=cm_raw,
        control_mean_adjusted=cm_adj,
        raw_diff=rem - cm_raw,
        lift=finite(lift),
        relative_lift=rel,
        se=se_f,
        ci_low=finite(lo),
        ci_high=finite(hi),
        p_value=finite(p, 1.0),
        significant=bool(se_f > 0 and p < alpha),
        ci_method=ci_method,
    )


# --------------------------------------------------------------------------- #
# Simple single-outcome helper (handy for notebooks / tests)
# --------------------------------------------------------------------------- #
def weighted_lift(y: np.ndarray, t: np.ndarray, w: Optional[np.ndarray] = None, alpha: float = 0.05) -> dict:
    """Weighted difference of means with analytic SE / CI / p-value."""
    y = np.asarray(y, float)
    t = np.asarray(t).astype(bool)
    w = np.ones_like(y) if w is None else np.asarray(w, float)
    Y, M = outcome_matrix([y])
    D = np.ones((len(y), 1))
    e = group_sums(w * t, D, Y, M)
    c = group_sums(w * ~t, D, Y, M)
    lift = float((e.mean() - c.mean())[0, 0])
    se = float(analytic_se(e, c)[0, 0])
    lo, hi = normal_ci(lift, se, alpha)
    return dict(lift=lift, se=se, ci_low=lo, ci_high=hi, p_value=p_value(lift, se),
                exposed_mean=float(e.mean()[0, 0]), control_mean=float(c.mean()[0, 0]))


__all__: List[str] = [
    "Sums", "outcome_matrix", "group_sums", "lift_only", "analytic_se", "bootstrap_se",
    "p_value", "normal_ci", "contrast_fields", "weighted_lift",
]
