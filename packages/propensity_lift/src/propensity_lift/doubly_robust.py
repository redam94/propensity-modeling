"""Doubly robust (AIPW) estimation: an outcome regression plus an IPW correction of its residuals.

For each arm ``a`` an outcome model ``m_a(x) = E[Y | X = x, T = a]`` is fitted on that arm, then

    mu_a = mean over the target population of m_a(X)  +  IPW-weighted mean over arm ``a`` of (Y - m_a(X))

and lift = mu_1 - mu_0. The estimate is consistent when EITHER the propensity model or the outcome
model is correctly specified. The target population is everyone for the ATE and the exposed for the
ATT; with ATT weights (exposed = 1) the exposed-arm model cancels, so ``mu_1`` is the observed
exposed mean and only ``m_0`` has to be fitted.

Like lift.py, everything is computed for K outcomes and G row-groups at once.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

import numpy as np

from .lift import group_sums

RIDGE = 1.0   # L2 penalty of the logistic outcome model on standardised features (as the PS model, C=1)


@dataclass
class AipwEstimate:
    exposed_mean: np.ndarray           # G x K  mu_1
    control_mean: np.ndarray           # G x K  mu_0
    se: Optional[np.ndarray] = None    # G x K  influence-function SE of the lift (with_se=True)

    @property
    def lift(self) -> np.ndarray:
        return self.exposed_mean - self.control_mean


# --------------------------------------------------------------------------- #
# outcome models
# --------------------------------------------------------------------------- #
def _solve(H: np.ndarray, g: np.ndarray) -> np.ndarray:
    try:
        return np.linalg.solve(H, g)
    except np.linalg.LinAlgError:
        return np.linalg.lstsq(H, g, rcond=None)[0]


def _fit_linear(A: np.ndarray, y: np.ndarray, w: np.ndarray) -> np.ndarray:
    r = np.sqrt(w)
    return np.linalg.lstsq(A * r[:, None], y * r, rcond=None)[0]


def _fit_logistic(A: np.ndarray, y: np.ndarray, w: np.ndarray, n_iter: int = 25, tol: float = 1e-8) -> np.ndarray:
    """Weighted ridge logistic regression by Newton steps (intercept in column 0, unpenalised)."""
    p = A.shape[1]
    R = RIDGE * np.eye(p)
    R[0, 0] = 0.0
    ybar = float(np.clip(np.average(y, weights=w), 1e-6, 1 - 1e-6))
    beta = np.zeros(p)
    beta[0] = np.log(ybar / (1 - ybar))
    for _ in range(n_iter):
        mu = 1.0 / (1.0 + np.exp(-np.clip(A @ beta, -30, 30)))
        s = w * mu * (1 - mu)
        step = _solve((A * s[:, None]).T @ A + R, A.T @ (w * (y - mu)) - R @ beta)
        beta = beta + step
        if np.max(np.abs(step)) < tol:
            break
    return beta


def _predict(A: np.ndarray, y: np.ndarray, w: np.ndarray, binary: bool) -> np.ndarray:
    """Fit on the rows with ``w > 0`` and predict for every row; degenerate fits fall back to the mean."""
    fit = w > 0
    n_fit = int(fit.sum())
    if n_fit == 0:
        return np.zeros(len(y))
    yf, wf = y[fit], w[fit]
    if n_fit <= A.shape[1] or np.ptp(yf) == 0:
        return np.full(len(y), float(np.average(yf, weights=wf)))
    if binary and np.isin(yf, (0.0, 1.0)).all():
        beta = _fit_logistic(A[fit], yf, wf)
        return 1.0 / (1.0 + np.exp(-np.clip(A @ beta, -30, 30)))
    return A @ _fit_linear(A[fit], yf, wf)


def fit_outcome_models(
    X: np.ndarray,
    Y: np.ndarray,
    M: np.ndarray,
    t: np.ndarray,
    binary: Sequence[bool],
    sample_weight: np.ndarray,
    arms: Sequence[int] = (0, 1),
) -> Tuple[np.ndarray, np.ndarray]:
    """Per-arm outcome regressions on ``X``: logistic for binary outcomes, linear otherwise.

    Returns ``(m0, m1)``, both n x K: the predicted outcome of EVERY row under control / exposure.
    ``sample_weight`` (n,) selects and weights the rows used for fitting (0 = not used, bootstrap
    multiplicities otherwise); rows with a missing outcome (``M == 0``) are never used. An arm that
    is not in ``arms`` is returned as zeros.
    """
    n, K = Y.shape
    sd = X.std(axis=0)
    Xs = (X - X.mean(axis=0)) / np.where(sd > 0, sd, 1.0)
    A = np.column_stack([np.ones(n), Xs])
    preds: List[np.ndarray] = []
    for arm in (0, 1):
        out = np.zeros((n, K))
        if arm in arms:
            w_arm = np.where(t == arm, sample_weight, 0.0)
            for k in range(K):
                out[:, k] = _predict(A, Y[:, k], w_arm * M[:, k], bool(binary[k]))
        preds.append(out)
    return preds[0], preds[1]


# --------------------------------------------------------------------------- #
# estimator
# --------------------------------------------------------------------------- #
def aipw_estimate(
    w: np.ndarray,
    q: np.ndarray,
    t: np.ndarray,
    D: np.ndarray,
    Y: np.ndarray,
    M: np.ndarray,
    m0: np.ndarray,
    m1: np.ndarray,
    with_se: bool = False,
) -> AipwEstimate:
    """Augmented IPW means for weights ``w`` (IPW weights, 0 for rows left out) and target weights ``q``.

    ``q`` (n,) defines the population the outcome-model predictions are averaged over: 1 for every
    analysed row (ATE) or for the analysed exposed rows only (ATT), times any bootstrap multiplicity.
    Weights are self-normalised (Hajek), so ``w`` and ``q`` need no particular scale.
    """
    te = (t == 1).astype(float)
    we, wc = w * te, w * (1 - te)
    r1 = group_sums(we, D, (Y - m1) * M, M, full=False)   # weighted residuals of each arm
    r0 = group_sums(wc, D, (Y - m0) * M, M, full=False)
    p1 = group_sums(q, D, m1 * M, M, full=False)          # predictions over the target population
    p0 = group_sums(q, D, m0 * M, M, full=False)
    est = AipwEstimate(exposed_mean=p1.mean() + r1.mean(), control_mean=p0.mean() + r0.mean())
    if not with_se:
        return est

    # Influence function of the Hajek AIPW lift, per row; Var(lift) ~ sum of squares.
    r1m, r0m, dm = r1.mean(), r0.mean(), p1.mean() - p0.mean()
    se = np.full(est.exposed_mean.shape, np.nan)
    with np.errstate(divide="ignore", invalid="ignore"):
        for g in range(D.shape[1]):
            phi = (D[:, g] * q)[:, None] / p1.sw[g] * ((m1 - m0) - dm[g])
            phi = phi + (D[:, g] * we)[:, None] / r1.sw[g] * ((Y - m1) - r1m[g])
            phi = phi - (D[:, g] * wc)[:, None] / r0.sw[g] * ((Y - m0) - r0m[g])
            se[g] = np.sqrt(((phi * M) ** 2).sum(axis=0))
    est.se = se
    return est


__all__: List[str] = ["AipwEstimate", "fit_outcome_models", "aipw_estimate"]
