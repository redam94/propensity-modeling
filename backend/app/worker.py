"""Code executed inside the analysis worker processes.

Everything here must be importable and picklable at module top level because the
process pool uses the ``spawn`` start method (fresh interpreter, no inherited state).

Progress protocol (``progress_dict`` is a ``multiprocessing.Manager().dict()`` proxy):

* ``progress_dict[analysis_id] = {"progress": float, "stage": str, "started_at": iso}``
  is written by the worker; its presence means the job is *running*.
* ``progress_dict[CANCEL_PREFIX + analysis_id] = True`` is written by the server to
  request cooperative cancellation; the worker checks it at every progress callback and
  aborts by raising :class:`JobCancelled`.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

CANCEL_PREFIX = "__cancel__:"

AnalysisFn = Callable[..., Any]  # (df, config, analysis_id=, progress=) -> AnalysisResult


class JobCancelled(Exception):
    """Raised inside a worker when the server asked the job to stop."""


def _cancel_requested(progress_dict: Any, analysis_id: str) -> bool:
    if progress_dict is None:
        return False
    try:
        return bool(progress_dict.get(CANCEL_PREFIX + analysis_id, False))
    except Exception:  # manager gone (server shutting down) -> stop
        return True


def execute(
    analysis_id: str,
    config_json: str,
    data_path: str,
    progress_dict: Any,
    analysis_fn: Optional[AnalysisFn] = None,
) -> str:
    """Load the cached frame, run ``analysis_fn`` with a progress callback, return result JSON."""
    from propensity_lift.schemas import AnalysisConfig

    from app.storage import read_frame_cache

    started_at = datetime.now(timezone.utc).isoformat()
    cancelled = False

    def report(fraction: float, stage: str) -> None:
        if _cancel_requested(progress_dict, analysis_id):
            raise JobCancelled("Analysis was cancelled.")
        if progress_dict is None:
            return
        try:
            frac = float(fraction)
        except (TypeError, ValueError):
            frac = 0.0
        try:
            progress_dict[analysis_id] = {
                "progress": min(1.0, max(0.0, frac)),
                "stage": str(stage) if stage is not None else None,
                "started_at": started_at,
            }
        except Exception:
            pass  # progress is best effort

    try:
        report(0.0, "loading data")
        df = read_frame_cache(Path(data_path))
        config = AnalysisConfig.model_validate_json(config_json)
        if analysis_fn is None:
            from app.pl_api import get

            analysis_fn = get("run_analysis")
        report(0.02, "starting analysis")
        result = analysis_fn(df, config, analysis_id=analysis_id, progress=report)
        report(1.0, "saving results")
        return result.model_dump_json()
    except JobCancelled:
        cancelled = True
        raise
    finally:
        if progress_dict is not None:
            try:
                progress_dict.pop(CANCEL_PREFIX + analysis_id, None)
                if cancelled:
                    progress_dict.pop(analysis_id, None)
            except Exception:
                pass


def run_job(analysis_id: str, config_json: str, data_path: str, progress_dict: Any) -> str:
    """Process-pool entry point: run the real ``propensity_lift.run_analysis``."""
    return execute(analysis_id, config_json, data_path, progress_dict)
