"""Lazy access to the propensity_lift public API.

Prefers the package's top-level exports (the documented contract); falls back to the
defining submodule so the service keeps working if ``__init__`` re-exports lag behind.
"""

from __future__ import annotations

import importlib
from typing import Any

_FALLBACK_MODULES = {
    "load_table": "propensity_lift.io",
    "list_sheets": "propensity_lift.io",
    "profile_dataframe": "propensity_lift.io",
    "run_analysis": "propensity_lift.pipeline",
}


def get(name: str) -> Any:
    pkg = importlib.import_module("propensity_lift")
    fn = getattr(pkg, name, None)
    if fn is None:
        fn = getattr(importlib.import_module(_FALLBACK_MODULES[name]), name)
    return fn
