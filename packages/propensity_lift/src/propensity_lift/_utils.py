"""Small shared helpers (JSON-safety, value normalisation, histograms)."""

from __future__ import annotations

import math
from datetime import date, datetime
from typing import Any, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

from .schemas import Histogram

EPS = 1e-6


def finite(x: Any, default: float = 0.0) -> float:
    """Return ``float(x)`` if finite, else ``default``."""
    try:
        f = float(x)
    except (TypeError, ValueError):
        return default
    return f if math.isfinite(f) else default


def finite_or_none(x: Any) -> Optional[float]:
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def is_missing(v: Any) -> bool:
    if v is None:
        return True
    try:
        r = pd.isna(v)
    except (TypeError, ValueError):
        return False
    return bool(r) if isinstance(r, (bool, np.bool_)) else False


def json_scalar(v: Any) -> Any:
    """Convert a (numpy / pandas) scalar to a JSON-safe python scalar (or None)."""
    if is_missing(v):
        return None
    if isinstance(v, (bool, np.bool_)):
        return bool(v)
    if isinstance(v, (np.integer, int)):
        return int(v)
    if isinstance(v, (np.floating, float)):
        f = float(v)
        if not math.isfinite(f):
            return None
        if f.is_integer() and abs(f) < 2**53:
            return int(f)
        return f
    if isinstance(v, (pd.Timestamp, datetime, date)):
        return pd.Timestamp(v).isoformat()
    if isinstance(v, np.datetime64):
        return pd.Timestamp(v).isoformat()
    if isinstance(v, str):
        return v
    return str(v)


Key = Optional[Tuple[str, Any]]

_TRUE_STRINGS = {"true"}
_FALSE_STRINGS = {"false"}


def norm_key(v: Any) -> Key:
    """Normalise a value for robust equality comparison.

    * numbers / bools / numeric strings -> ("n", float)   (1 == 1.0 == "1" == True)
    * other strings -> ("s", lower-cased stripped)
    * missing / empty string -> None
    """
    if is_missing(v):
        return None
    if isinstance(v, (bool, np.bool_)):
        return ("n", 1.0 if v else 0.0)
    if isinstance(v, (int, float, np.integer, np.floating)):
        f = float(v)
        if not math.isfinite(f):
            return None
        return ("n", f)
    if isinstance(v, (pd.Timestamp, datetime, date, np.datetime64)):
        return ("s", pd.Timestamp(v).isoformat().lower())
    s = str(v).strip()
    if s == "":
        return None
    low = s.lower()
    if low in _TRUE_STRINGS:
        return ("n", 1.0)
    if low in _FALSE_STRINGS:
        return ("n", 0.0)
    try:
        f = float(s)
        if math.isfinite(f):
            return ("n", f)
    except ValueError:
        pass
    return ("s", low)


def series_keys(s: pd.Series) -> List[Key]:
    """norm_key applied element-wise, computed once per unique value."""
    values = s.to_numpy(dtype=object)
    cache: dict = {}
    out: List[Key] = []
    for v in values:
        try:
            k = cache[v]
        except (KeyError, TypeError):
            k = norm_key(v)
            try:
                cache[v] = k
            except TypeError:
                pass
        out.append(k)
    return out


def level_label(v: Any) -> str:
    """String label for a categorical level (1.0 -> '1')."""
    j = json_scalar(v)
    if j is None:
        return "(missing)"
    return str(j)


# --------------------------------------------------------------------------- #
# histograms
# --------------------------------------------------------------------------- #
def make_edges(x: np.ndarray, bins: int) -> np.ndarray:
    x = x[np.isfinite(x)]
    if x.size == 0:
        return np.linspace(0.0, 1.0, bins + 1)
    lo, hi = float(x.min()), float(x.max())
    if hi - lo < 1e-12:
        lo, hi = lo - 0.5, hi + 0.5
    return np.linspace(lo, hi, bins + 1)


def weighted_hist(
    x_e: np.ndarray,
    x_c: np.ndarray,
    edges: np.ndarray,
    w_e: Optional[np.ndarray] = None,
    w_c: Optional[np.ndarray] = None,
) -> Histogram:
    """Shared-bin histogram for two groups (optionally weighted).

    With weights, counts are weighted counts rescaled so that they sum to the
    number of units with positive weight (rounded to int) and densities use
    the weighted mass.
    """
    widths = np.diff(edges)
    widths = np.where(widths <= 0, 1.0, widths)

    def one(x: np.ndarray, w: Optional[np.ndarray]):
        m = np.isfinite(x)
        x = np.clip(x[m], edges[0], edges[-1])
        if w is None:
            c, _ = np.histogram(x, bins=edges)
            n = c.sum()
            dens = c / (n * widths) if n > 0 else np.zeros_like(widths)
            return c.astype(int).tolist(), dens
        w = w[m]
        pos = w > 0
        x, w = x[pos], w[pos]
        c, _ = np.histogram(x, bins=edges, weights=w)
        tot = c.sum()
        if tot <= 0:
            return [0] * len(widths), np.zeros_like(widths)
        dens = c / (tot * widths)
        counts = np.rint(c / tot * pos.sum()).astype(int)
        return counts.tolist(), dens

    ce, de = one(np.asarray(x_e, float), None if w_e is None else np.asarray(w_e, float))
    cc, dc = one(np.asarray(x_c, float), None if w_c is None else np.asarray(w_c, float))
    return Histogram(
        edges=[finite(e) for e in edges],
        exposed_counts=ce,
        control_counts=cc,
        exposed_density=[finite(d) for d in de],
        control_density=[finite(d) for d in dc],
    )


def hist_ovl(x_e: np.ndarray, x_c: np.ndarray, edges: np.ndarray) -> float:
    """Overlap coefficient of two samples via shared-bin histogram masses."""
    x_e = x_e[np.isfinite(x_e)]
    x_c = x_c[np.isfinite(x_c)]
    if x_e.size == 0 or x_c.size == 0:
        return 0.0
    ce, _ = np.histogram(np.clip(x_e, edges[0], edges[-1]), bins=edges)
    cc, _ = np.histogram(np.clip(x_c, edges[0], edges[-1]), bins=edges)
    return float(np.clip(np.minimum(ce / ce.sum(), cc / cc.sum()).sum(), 0.0, 1.0))


def unique_names(names: Sequence[Any]) -> List[str]:
    """Strip whitespace and de-duplicate column names (a, a_2, a_3 ...)."""
    out: List[str] = []
    seen: dict = {}
    used = set()
    for i, n in enumerate(names):
        s = "" if is_missing(n) else str(n).strip()
        if s == "" or s.lower().startswith("unnamed:"):
            s = s if s else f"column_{i + 1}"
        base = s
        if base in used:
            k = seen.get(base, 1)
            while True:
                k += 1
                cand = f"{base}_{k}"
                if cand not in used:
                    break
            seen[base] = k
            s = cand
        used.add(s)
        out.append(s)
    return out
