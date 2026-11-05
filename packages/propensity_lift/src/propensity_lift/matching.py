"""Greedy nearest-neighbour matching on logit(PS) with caliper, ratio,
replacement and exact-match strata.

Exact strata are handled by offsetting the matching distance of each stratum
by a large constant, so a single sorted search can be used for all strata
while never pairing units from different strata.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple

import numpy as np

# |logit(ps)| <= ~14 for ps clipped at 1e-6, so strata separated by 1000 never mix
_STRIDE = 1000.0
_MAX_DIST = _STRIDE / 4


@dataclass
class MatchPairs:
    treated: np.ndarray   # index (into input arrays) of the focal unit
    control: np.ndarray   # index of its matched counterpart
    weight: np.ndarray    # 1 / (number of matches of the focal unit)
    n_focal: int
    n_focal_matched: int


def _keys(score: np.ndarray, strata: Optional[np.ndarray]) -> np.ndarray:
    if strata is None:
        return np.asarray(score, dtype=float)
    return np.asarray(score, dtype=float) + np.asarray(strata, dtype=float) * _STRIDE


def match_one_direction(
    score: np.ndarray,
    focal: np.ndarray,
    pool: np.ndarray,
    caliper: Optional[float],
    ratio: int = 1,
    replacement: bool = True,
    strata: Optional[np.ndarray] = None,
) -> MatchPairs:
    """Match each focal unit (boolean mask ``focal``) to up to ``ratio`` units of
    ``pool`` (boolean mask) by nearest ``score`` within ``caliper`` (absolute,
    same scale as score) and within identical ``strata``."""
    key = _keys(score, strata)
    f_idx = np.flatnonzero(focal)
    p_idx = np.flatnonzero(pool)
    maxd = _MAX_DIST if caliper is None else min(float(caliper), _MAX_DIST)
    empty = MatchPairs(np.zeros(0, int), np.zeros(0, int), np.zeros(0), len(f_idx), 0)
    if len(f_idx) == 0 or len(p_idx) == 0:
        return empty
    order = np.argsort(key[p_idx], kind="stable")
    ps_sorted = key[p_idx][order]
    p_sorted = p_idx[order]
    m = len(ps_sorted)
    fk = key[f_idx]
    if replacement:
        k = min(ratio, m)
        pos = np.searchsorted(ps_sorted, fk)
        offs = np.arange(-k, k)
        cand = pos[:, None] + offs[None, :]
        valid = (cand >= 0) & (cand < m)
        candc = np.clip(cand, 0, m - 1)
        d = np.abs(ps_sorted[candc] - fk[:, None])
        d[~valid] = np.inf
        sel = np.argsort(d, axis=1, kind="stable")[:, :k]
        dsel = np.take_along_axis(d, sel, axis=1)
        csel = np.take_along_axis(candc, sel, axis=1)
        ok = dsel <= maxd
        rows = np.repeat(np.arange(len(f_idx)), k).reshape(len(f_idx), k)
        rr, cc = rows[ok], csel[ok]
    else:
        rr, cc = _greedy_without_replacement(ps_sorted, fk, score[f_idx], maxd, ratio)
    if rr.size == 0:
        return empty
    counts = np.bincount(rr, minlength=len(f_idx))
    w = 1.0 / counts[rr]
    return MatchPairs(f_idx[rr], p_sorted[cc], w, len(f_idx), int((counts > 0).sum()))


def _find(parent: list, i: int) -> int:
    root = i
    while parent[root] != root:
        root = parent[root]
    while parent[i] != root:
        nxt = parent[i]
        parent[i] = root
        i = nxt
    return root


def _greedy_without_replacement(
    sorted_keys: np.ndarray, fkeys: np.ndarray, fscore: np.ndarray, maxd: float, ratio: int
) -> Tuple[np.ndarray, np.ndarray]:
    """Greedy matching, focal units processed from largest score down, in ``ratio``
    rounds. Availability tracked with two union-find "next available" structures."""
    m = len(sorted_keys)
    right = list(range(m + 1))          # right[j] -> next available index >= j (m = none)
    left = list(range(m + 1))           # left[j]  -> (next available index <= j-1) + 1 (0 = none)
    pos = np.searchsorted(sorted_keys, fkeys).tolist()
    keys = sorted_keys.tolist()
    fk = fkeys.tolist()
    order = np.argsort(-fscore, kind="stable").tolist()
    active = set(order)
    rows: list = []
    cols: list = []
    for _ in range(ratio):
        if not active:
            break
        for i in order:
            if i not in active:
                continue
            p = pos[i]
            x = fk[i]
            r = _find(right, p)
            lj = _find(left, p) - 1
            best = -1
            bd = np.inf
            if r < m:
                best, bd = r, keys[r] - x
            if lj >= 0:
                dl = x - keys[lj]
                if dl < bd or (dl == bd and best == -1):
                    best, bd = lj, dl
            if best < 0 or bd > maxd:
                active.discard(i)
                continue
            rows.append(i)
            cols.append(best)
            right[best] = best + 1
            left[best + 1] = best
    return np.asarray(rows, dtype=int), np.asarray(cols, dtype=int)


@dataclass
class MatchResult:
    weights: np.ndarray            # unnormalised: exposed 1 if matched; control sum of 1/k
    n_exposed_matched: int
    n_exposed_unmatched: int
    n_unique_controls_used: int
    n_control_matched: int = 0     # ATE: controls with an exposed counterpart


def nn_match(
    logit_ps: np.ndarray,
    t: np.ndarray,
    caliper_abs: Optional[float],
    ratio: int = 1,
    replacement: bool = True,
    strata: Optional[np.ndarray] = None,
    estimand: str = "ATT",
) -> MatchResult:
    """Nearest-neighbour matching producing analysis weights.

    ATT: exposed weight 1 (if matched), control weight = sum over the exposed it
    serves of 1/k (k = matches of that exposed unit; = times used / ratio).
    ATE: matched in both directions; each unit's weight = 1 (if it found a
    counterpart) + its usage as a counterpart.
    """
    t = np.asarray(t).astype(bool)
    n = len(t)
    a = match_one_direction(logit_ps, t, ~t, caliper_abs, ratio, replacement, strata)
    w = np.zeros(n)
    if a.treated.size:
        w[np.unique(a.treated)] = 1.0
        w += np.bincount(a.control, weights=a.weight, minlength=n)
    n_ctrl_matched = 0
    if estimand == "ATE":
        b = match_one_direction(logit_ps, ~t, t, caliper_abs, ratio, replacement, strata)
        if b.treated.size:
            w[np.unique(b.treated)] += 1.0
            w += np.bincount(b.control, weights=b.weight, minlength=n)
        n_ctrl_matched = b.n_focal_matched
    used_controls = int(np.unique(a.control).size) if a.control.size else 0
    return MatchResult(w, a.n_focal_matched, a.n_focal - a.n_focal_matched, used_controls, n_ctrl_matched)
