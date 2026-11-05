"""Over/underlap diagnostics on the propensity score and on raw features."""

from __future__ import annotations

from typing import List, Optional, Tuple

import numpy as np
import pandas as pd

from ._utils import finite, hist_ovl, make_edges, weighted_hist
from .preprocess import categorical_labels, feature_numeric
from .schemas import (
    ColumnKind,
    DensityCurve,
    FeatureOverlap,
    LevelShare,
    OverlapSummary,
    Quantiles,
    RegionCount,
    TrimRule,
)

PS_BINS = 40
KDE_POINTS = 128


def quantiles(x: np.ndarray) -> Quantiles:
    x = np.asarray(x, float)
    x = x[np.isfinite(x)]
    if x.size == 0:
        return Quantiles(min=0, p05=0, p25=0, median=0, p75=0, p95=0, max=0, mean=0)
    q = np.quantile(x, [0, 0.05, 0.25, 0.5, 0.75, 0.95, 1])
    return Quantiles(
        min=finite(q[0]), p05=finite(q[1]), p25=finite(q[2]), median=finite(q[3]),
        p75=finite(q[4]), p95=finite(q[5]), max=finite(q[6]), mean=finite(x.mean()),
    )


def common_support(ps: np.ndarray, t: np.ndarray) -> Tuple[float, float]:
    t = np.asarray(t).astype(bool)
    pe, pc = ps[t], ps[~t]
    if pe.size == 0 or pc.size == 0:
        return 0.0, 1.0
    return float(max(pe.min(), pc.min())), float(min(pe.max(), pc.max()))


def trim_mask(ps: np.ndarray, t: np.ndarray, rule: TrimRule) -> np.ndarray:
    """Boolean mask of units KEPT under the trim rule."""
    ps = np.asarray(ps, float)
    if rule == "common_support":
        lo, hi = common_support(ps, t)
        return (ps >= lo) & (ps <= hi)
    if rule == "crump":
        return (ps >= 0.1) & (ps <= 0.9)
    return np.ones(ps.shape, bool)


def _kde(x: np.ndarray, grid: np.ndarray) -> np.ndarray:
    from scipy.stats import gaussian_kde

    x = x[np.isfinite(x)]
    if x.size < 2 or np.ptp(x) == 0:
        out = np.zeros_like(grid)
        if x.size:
            # degenerate: put all mass on nearest grid point
            step = grid[1] - grid[0] if grid.size > 1 else 1.0
            out[int(np.argmin(np.abs(grid - x[0])))] = 1.0 / step
        return out
    try:
        return gaussian_kde(x)(grid)
    except (np.linalg.LinAlgError, ValueError):
        return np.zeros_like(grid)


def region_counts(ps: np.ndarray, t: np.ndarray) -> List[RegionCount]:
    t = np.asarray(t).astype(bool)
    lo, hi = common_support(ps, t)
    n_e, n_c = max(int(t.sum()), 1), max(int((~t).sum()), 1)
    pmin = float(ps.min()) if ps.size else 0.0
    pmax = float(ps.max()) if ps.size else 1.0
    defs = [
        ("control_only", ps < lo, pmin, lo),
        ("both", (ps >= lo) & (ps <= hi), lo, hi),
        ("exposed_only", ps > hi, hi, pmax),
    ]
    out = []
    for name, m, a, b in defs:
        ne, nc = int((m & t).sum()), int((m & ~t).sum())
        out.append(
            RegionCount(
                region=name, lower=finite(a), upper=finite(b), n_exposed=ne, n_control=nc,
                pct_exposed=finite(100.0 * ne / n_e), pct_control=finite(100.0 * nc / n_c),
            )
        )
    return out


def ps_overlap_summary(
    ps: np.ndarray, t: np.ndarray, trim: TrimRule = "none", bins: int = PS_BINS
) -> OverlapSummary:
    """Propensity score over/underlap on the (pre-trim) sample."""
    ps = np.asarray(ps, float)
    t = np.asarray(t).astype(bool)
    pe, pc = ps[t], ps[~t]
    edges = make_edges(ps, bins)
    hist = weighted_hist(pe, pc, edges)
    lo_g = max(0.0, float(ps.min()) - 0.05) if ps.size else 0.0
    hi_g = min(1.0, float(ps.max()) + 0.05) if ps.size else 1.0
    grid = np.linspace(lo_g, hi_g, KDE_POINTS)
    lo, hi = common_support(ps, t)
    keep = trim_mask(ps, t, trim)
    return OverlapSummary(
        histogram=hist,
        density=DensityCurve(
            x=[finite(v) for v in grid],
            exposed=[finite(v) for v in _kde(pe, grid)],
            control=[finite(v) for v in _kde(pc, grid)],
        ),
        exposed_quantiles=quantiles(pe),
        control_quantiles=quantiles(pc),
        common_support_lower=finite(lo),
        common_support_upper=finite(hi),
        regions=region_counts(ps, t),
        overlap_coefficient=finite(hist_ovl(pe, pc, edges)),
        n_trimmed_exposed=int((~keep & t).sum()),
        n_trimmed_control=int((~keep & ~t).sum()),
    )


def feature_overlap(
    s: pd.Series,
    t: np.ndarray,
    name: str,
    role: str,
    kind: ColumnKind,
    max_levels: int = 30,
    bins: int = 30,
) -> FeatureOverlap:
    """Raw-data over/underlap for one feature."""
    t = np.asarray(t).astype(bool)
    x = feature_numeric(s) if kind in ("numeric", "datetime") else None
    if x is not None:
        xe, xc = x[t], x[~t]
        xe, xc = xe[np.isfinite(xe)], xc[np.isfinite(xc)]
        allx = np.concatenate([xe, xc])
        nu = np.unique(allx).size
        edges = make_edges(allx, max(1, min(bins, nu)))
        if xe.size and xc.size:
            pe_unsup = 100.0 * float(((xe < xc.min()) | (xe > xc.max())).mean())
            pc_unsup = 100.0 * float(((xc < xe.min()) | (xc > xe.max())).mean())
        else:
            pe_unsup = 100.0 if xe.size else 0.0
            pc_unsup = 100.0 if xc.size else 0.0
        return FeatureOverlap(
            feature=name, role=role, kind=kind,  # type: ignore[arg-type]
            overlap_coefficient=finite(hist_ovl(xe, xc, edges)),
            pct_exposed_unsupported=finite(pe_unsup),
            pct_control_unsupported=finite(pc_unsup),
            histogram=weighted_hist(xe, xc, edges),
            exposed_range=[finite(xe.min()), finite(xe.max())] if xe.size else None,
            control_range=[finite(xc.min()), finite(xc.max())] if xc.size else None,
        )
    labels = categorical_labels(s)
    le = pd.Series(labels[t]).value_counts()
    lc = pd.Series(labels[~t]).value_counts()
    ne, nc = int(t.sum()), int((~t).sum())
    all_levels = le.add(lc, fill_value=0).sort_values(ascending=False)
    pe = le / ne if ne else le * 0
    pc = lc / nc if nc else lc * 0
    idx = all_levels.index
    pe_a = pe.reindex(idx, fill_value=0.0).to_numpy()
    pc_a = pc.reindex(idx, fill_value=0.0).to_numpy()
    ovl = float(np.minimum(pe_a, pc_a).sum()) if ne and nc else 0.0
    e_only = [str(lv) for lv in idx if lv in le.index and lv not in lc.index]
    c_only = [str(lv) for lv in idx if lv in lc.index and lv not in le.index]
    levels = [
        LevelShare(
            level=str(lv),
            n_exposed=int(le.get(lv, 0)),
            n_control=int(lc.get(lv, 0)),
            pct_exposed=finite(100.0 * le.get(lv, 0) / ne) if ne else 0.0,
            pct_control=finite(100.0 * lc.get(lv, 0) / nc) if nc else 0.0,
        )
        for lv in idx[:max_levels]
    ]
    return FeatureOverlap(
        feature=name, role=role, kind=kind,  # type: ignore[arg-type]
        overlap_coefficient=finite(min(max(ovl, 0.0), 1.0)),
        pct_exposed_unsupported=finite(100.0 * sum(int(le[lv]) for lv in e_only) / ne) if ne else 0.0,
        pct_control_unsupported=finite(100.0 * sum(int(lc[lv]) for lv in c_only) / nc) if nc else 0.0,
        exposed_only_levels=e_only[:100],
        control_only_levels=c_only[:100],
        levels=levels,
    )


def adjusted_ps_histogram(
    ps: np.ndarray, t: np.ndarray, w: np.ndarray, edges: Optional[np.ndarray] = None
):
    t = np.asarray(t).astype(bool)
    if edges is None:
        edges = make_edges(ps, PS_BINS)
    return weighted_hist(ps[t], ps[~t], edges, w[t], w[~t])
