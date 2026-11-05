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


@dataclass
class _Setup:
    f_idx: np.ndarray      # focal indices (into input arrays)
    p_sorted: np.ndarray   # pool indices sorted by key
    ps_sorted: np.ndarray  # sorted pool keys
    fk: np.ndarray         # focal keys
    maxd: float


def _setup(score, focal, pool, caliper, strata) -> _Setup:
    key = _keys(score, strata)
    f_idx = np.flatnonzero(focal)
    p_idx = np.flatnonzero(pool)
    maxd = _MAX_DIST if caliper is None else min(float(caliper), _MAX_DIST)
    order = np.argsort(key[p_idx], kind="stable")
    return _Setup(f_idx, p_idx[order], key[p_idx][order], key[f_idx], maxd)


def _replacement_ranges(ps_sorted: np.ndarray, fk: np.ndarray, ratio: int, maxd: float) -> Tuple[np.ndarray, np.ndarray]:
    """For each focal key, the half-open range [lo, hi) of sorted pool positions it is matched to.

    The range holds the ``ratio`` nearest pool units **plus every unit tied with the
    ratio-th nearest distance** (restricted to the caliper ``maxd``). Including the
    whole tie block matters for survey data with categorical-only PS models, where
    the score takes few distinct values: picking "the first k in sorted order"
    would send every tied focal unit to the same few controls.
    """
    m = len(ps_sorted)
    k = min(ratio, m)
    pos = np.searchsorted(ps_sorted, fk)
    offs = np.arange(-k, k)
    cand = pos[:, None] + offs[None, :]
    valid = (cand >= 0) & (cand < m)
    d = np.abs(ps_sorted[np.clip(cand, 0, m - 1)] - fk[:, None])
    d[~valid] = np.inf
    dk = np.partition(d, k - 1, axis=1)[:, k - 1]          # k-th smallest distance
    r = np.minimum(dk, maxd)
    tol = 1e-10 + 1e-12 * np.abs(fk)                       # absorb float noise in "tied" scores
    lo = np.searchsorted(ps_sorted, fk - r - tol, side="left")
    hi = np.searchsorted(ps_sorted, fk + r + tol, side="right")
    hi = np.maximum(hi, lo)
    return lo, hi


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
    same scale as score) and within identical ``strata``.

    With replacement, pool units tied with the ``ratio``-th nearest distance are
    all used and share the focal unit's weight (so a focal unit may get more than
    ``ratio`` matches, each weighted 1/n_matches)."""
    su = _setup(score, focal, pool, caliper, strata)
    nf = len(su.f_idx)
    empty = MatchPairs(np.zeros(0, int), np.zeros(0, int), np.zeros(0), nf, 0)
    if nf == 0 or len(su.p_sorted) == 0:
        return empty
    if replacement:
        lo, hi = _replacement_ranges(su.ps_sorted, su.fk, ratio, su.maxd)
        lengths = hi - lo
        total = int(lengths.sum())
        rr = np.repeat(np.arange(nf), lengths)
        starts = np.cumsum(lengths) - lengths
        cc = np.arange(total) - np.repeat(starts - lo, lengths)
    else:
        rr, cc = _greedy_without_replacement(su.ps_sorted, su.fk, np.asarray(score)[su.f_idx], su.maxd, ratio)
    if rr.size == 0:
        return empty
    counts = np.bincount(rr, minlength=nf)
    w = 1.0 / counts[rr]
    return MatchPairs(su.f_idx[rr], su.p_sorted[cc], w, nf, int((counts > 0).sum()))


@dataclass
class _DirectionWeights:
    focal_matched: np.ndarray   # indices of focal units with >= 1 match
    pool_weight: np.ndarray     # length-n: sum over focal units served of 1/k
    n_focal: int
    n_pool_used: int


def _direction_weights(score, focal, pool, caliper, ratio, replacement, strata, n) -> _DirectionWeights:
    """Like :func:`match_one_direction` but returns aggregated weights only.

    With replacement the tie blocks can be large (all-categorical PS models), so
    weights are accumulated with a difference array over sorted pool positions
    instead of materialising every (focal, control) pair."""
    if not replacement:
        mp = match_one_direction(score, focal, pool, caliper, ratio, False, strata)
        pw = np.bincount(mp.control, weights=mp.weight, minlength=n) if mp.control.size else np.zeros(n)
        used = int(np.unique(mp.control).size) if mp.control.size else 0
        return _DirectionWeights(np.unique(mp.treated), pw, mp.n_focal, used)
    su = _setup(score, focal, pool, caliper, strata)
    nf, m = len(su.f_idx), len(su.p_sorted)
    pw = np.zeros(n)
    if nf == 0 or m == 0:
        return _DirectionWeights(np.zeros(0, int), pw, nf, 0)
    lo, hi = _replacement_ranges(su.ps_sorted, su.fk, ratio, su.maxd)
    ok = hi > lo
    lo, hi = lo[ok], hi[ok]
    share = 1.0 / (hi - lo)
    dw = np.zeros(m + 1)
    np.add.at(dw, lo, share)
    np.add.at(dw, hi, -share)
    dc = np.zeros(m + 1)
    np.add.at(dc, lo, 1.0)
    np.add.at(dc, hi, -1.0)
    w_sorted = np.cumsum(dw)[:m]
    cover = np.cumsum(dc)[:m]
    w_sorted[cover < 0.5] = 0.0     # remove float residue outside every range
    pw[su.p_sorted] = w_sorted
    return _DirectionWeights(su.f_idx[ok], pw, nf, int((cover > 0.5).sum()))


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
    a = _direction_weights(logit_ps, t, ~t, caliper_abs, ratio, replacement, strata, n)
    w = np.zeros(n)
    w[a.focal_matched] = 1.0
    w += a.pool_weight
    n_ctrl_matched = 0
    if estimand == "ATE":
        b = _direction_weights(logit_ps, ~t, t, caliper_abs, ratio, replacement, strata, n)
        w[b.focal_matched] += 1.0
        w += b.pool_weight
        n_ctrl_matched = int(b.focal_matched.size)
    n_matched = int(a.focal_matched.size)
    return MatchResult(w, n_matched, a.n_focal - n_matched, a.n_pool_used, n_ctrl_matched)
