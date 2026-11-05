"""Background analysis jobs.

Design
------
* One :class:`JobManager` per app, created in the FastAPI lifespan.
* Analyses run in a ``ProcessPoolExecutor`` (``spawn`` context, ``MAX_WORKERS`` processes).
  ``submit`` schedules ``loop.run_in_executor(pool, job_fn, ...)`` and returns at once; an
  asyncio task (``_watch``) awaits the future and records the outcome. The event loop
  never runs analysis code and never blocks on a worker.
* Progress flows worker -> server through a ``multiprocessing.Manager().dict()``
  (see :mod:`app.worker`) and is merged into :class:`JobInfo` whenever a job is read.
  A job is reported ``running`` once its worker has written a progress entry.
* Every status change is persisted to ``DATA_DIR/analyses/{id}.meta.json``; completed
  results go to ``DATA_DIR/analyses/{id}.json``. On startup the index is rebuilt from
  those files; jobs left ``queued``/``running`` by a previous process become ``failed``.

Cancellation
------------
* Queued job: the pool future is cancelled, so it never starts.
* Running job: processes in a ``ProcessPoolExecutor`` cannot be interrupted safely, so the
  job is marked ``cancelled`` immediately and a cancel flag is set in the shared dict. The
  worker sees the flag at its next progress callback and aborts (freeing its slot); if it
  finishes before that, its result is discarded. Either way the job stays ``cancelled``.

Failures
--------
Worker exceptions never propagate: ``ValueError`` messages (the analysis package's
"bad input" signal) are shown verbatim, anything else as ``"TypeName: message"``. A crashed
worker process (``BrokenProcessPool``, e.g. out-of-memory kill) fails the job(s) that were
running; the pool is recreated and jobs that were still queued are resubmitted to it (at
most ``MAX_POOL_RETRIES`` times each).
"""

from __future__ import annotations

import asyncio
import json
import logging
import multiprocessing as mp
import os
import uuid
from collections import OrderedDict
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from propensity_lift.schemas import AnalysisConfig, AnalysisResult, JobDetail, JobInfo

from app.config import Settings
from app.storage import is_valid_id
from app.worker import CANCEL_PREFIX, JobCancelled, run_job

log = logging.getLogger(__name__)

TERMINAL = ("completed", "failed", "cancelled")
RESULT_CACHE_SIZE = 16
# How often a job that never started is resubmitted after the pool broke under it.
MAX_POOL_RETRIES = 2

JobFn = Callable[[str, str, str, Any], str]


class JobNotFound(LookupError):
    pass


class JobNotReady(Exception):
    pass


class ServiceUnavailable(Exception):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


def describe_error(exc: BaseException) -> str:
    if isinstance(exc, ValueError):
        msg = str(exc)
        return msg or "Invalid analysis input."
    msg = str(exc)
    return f"{type(exc).__name__}: {msg}" if msg else type(exc).__name__


def _atomic_write(path: Path, text: str) -> None:
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


@dataclass
class _Job:
    info: JobInfo
    config: Optional[AnalysisConfig] = None
    future: Optional[asyncio.Future] = None
    task: Optional[asyncio.Task] = None
    executor: Optional[ProcessPoolExecutor] = None
    cancel_requested: bool = False
    args: tuple = ()
    pool_retries: int = 0


class JobManager:
    def __init__(self, settings: Settings, job_fn: Optional[JobFn] = None):
        self.settings = settings
        self.dir = Path(settings.data_dir) / "analyses"
        self._job_fn: JobFn = job_fn or run_job
        self._ctx = mp.get_context("spawn")
        self._jobs: Dict[str, _Job] = {}
        self._results: OrderedDict[str, AnalysisResult] = OrderedDict()
        self._executor: Optional[ProcessPoolExecutor] = None
        self._mp_manager: Any = None
        self._progress: Any = None
        self._shutting_down = False

    # ------------------------------------------------------------ lifecycle
    @property
    def max_workers(self) -> int:
        return self.settings.max_workers

    async def start(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(self._load_index)
        self._mp_manager = await asyncio.to_thread(self._ctx.Manager)
        self._progress = self._mp_manager.dict()
        self._executor = self._new_executor()

    def _new_executor(self) -> ProcessPoolExecutor:
        return ProcessPoolExecutor(max_workers=self.max_workers, mp_context=self._ctx)

    async def shutdown(self) -> None:
        """Stop accepting work, cancel queued jobs, ask running ones to stop, then tear down.

        Jobs that had not finished are recorded as failed ("server shut down").
        """
        self._shutting_down = True
        active = [j for j in self._jobs.values() if j.info.status not in TERMINAL]
        for job in active:
            self._set_cancel_flag(job.info.analysis_id)
            if job.future is not None:
                job.future.cancel()
        tasks = [j.task for j in active if j.task is not None]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

        executor, self._executor = self._executor, None
        if executor is not None:
            try:
                await asyncio.wait_for(
                    asyncio.to_thread(executor.shutdown, wait=True, cancel_futures=True),
                    timeout=self.settings.shutdown_grace_seconds,
                )
            except asyncio.TimeoutError:
                log.warning("Workers did not stop within grace period; terminating them")
                for proc in list((getattr(executor, "_processes", None) or {}).values()):
                    try:
                        proc.terminate()
                    except Exception:
                        pass
                executor.shutdown(wait=False, cancel_futures=True)
        if self._mp_manager is not None:
            try:
                await asyncio.to_thread(self._mp_manager.shutdown)
            except Exception:
                pass
            self._mp_manager = None
            self._progress = None

    # ---------------------------------------------------------- persistence
    def _meta_path(self, aid: str) -> Path:
        return self.dir / f"{aid}.meta.json"

    def _result_path(self, aid: str) -> Path:
        return self.dir / f"{aid}.json"

    def _write_meta(self, job: _Job) -> None:
        payload = {
            "info": job.info.model_dump(mode="json"),
            "config": job.config.model_dump(mode="json") if job.config is not None else None,
        }
        try:
            _atomic_write(self._meta_path(job.info.analysis_id), json.dumps(payload))
        except OSError:
            log.exception("Could not persist job %s", job.info.analysis_id)

    def _load_index(self) -> None:
        for path in sorted(self.dir.glob("*.meta.json")):
            aid = path.name[: -len(".meta.json")]
            if not is_valid_id(aid):
                continue
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                info = JobInfo.model_validate(data["info"])
                config = AnalysisConfig.model_validate(data["config"]) if data.get("config") else None
            except Exception:
                log.exception("Skipping unreadable job file %s", path)
                continue
            job = _Job(info=info, config=config)
            if info.status in ("queued", "running"):
                info.status = "failed"
                info.error = (
                    f"The server stopped while this analysis was {data['info'].get('status')}; "
                    "it did not finish. Please run it again."
                )
                info.finished_at = _now()
                self._write_meta(job)
            elif info.status == "completed" and not self._result_path(aid).is_file():
                info.status = "failed"
                info.error = "The result file for this analysis is missing."
                self._write_meta(job)
            self._jobs[aid] = job

    def _store_result(self, aid: str, result_json: str) -> AnalysisResult:
        result = AnalysisResult.model_validate_json(result_json)
        _atomic_write(self._result_path(aid), result_json)
        return result

    def _read_result(self, aid: str) -> AnalysisResult:
        return AnalysisResult.model_validate_json(self._result_path(aid).read_text(encoding="utf-8"))

    def _cache_result(self, aid: str, result: AnalysisResult) -> None:
        self._results[aid] = result
        self._results.move_to_end(aid)
        while len(self._results) > RESULT_CACHE_SIZE:
            self._results.popitem(last=False)

    # ------------------------------------------------------------ submission
    async def submit(self, config: AnalysisConfig, data_path: Path) -> JobInfo:
        if self._shutting_down or self._executor is None:
            raise ServiceUnavailable("The server is shutting down; try again shortly.")
        aid = uuid.uuid4().hex
        info = JobInfo(
            analysis_id=aid,
            name=config.name,
            dataset_id=config.dataset_id,
            status="queued",
            progress=0.0,
            stage="queued",
            submitted_at=_now(),
        )
        job = _Job(info=info, config=config)
        args = (aid, config.model_dump_json(), str(data_path), self._progress)
        job.args = args
        loop = asyncio.get_running_loop()
        try:
            job.executor = self._executor
            job.future = loop.run_in_executor(self._executor, self._job_fn, *args)
        except BrokenProcessPool:
            self._replace_executor(job.executor)
            job.executor = self._executor
            job.future = loop.run_in_executor(self._executor, self._job_fn, *args)
        self._jobs[aid] = job
        await asyncio.to_thread(self._write_meta, job)
        job.task = asyncio.create_task(self._watch(job), name=f"analysis-{aid}")
        return self._view(job, {})

    def _replace_executor(self, broken: Optional[ProcessPoolExecutor]) -> None:
        if self._shutting_down or broken is not self._executor:
            return
        log.warning("Process pool broken; creating a new one")
        self._executor = self._new_executor()
        if broken is not None:
            broken.shutdown(wait=False, cancel_futures=True)

    def _absorb_progress(self, job: _Job) -> None:
        """Copy the worker's last progress entry into the job record and drop it from the dict."""
        entry = self._progress_entry(job.info.analysis_id)
        if entry:
            if job.info.started_at is None:
                job.info.started_at = _parse_dt(entry.get("started_at"))
            job.info.progress = float(entry.get("progress", job.info.progress))
            job.info.stage = entry.get("stage") or job.info.stage
        if self._progress is not None and not job.cancel_requested:
            try:
                self._progress.pop(job.info.analysis_id, None)
            except Exception:
                pass

    def _resubmit(self, job: _Job) -> bool:
        """Re-queue a job that never started on the current pool. Returns False if impossible."""
        if (
            job.cancel_requested
            or self._shutting_down
            or self._executor is None
            or not job.args
            or job.pool_retries >= MAX_POOL_RETRIES
        ):
            return False
        job.pool_retries += 1
        try:
            job.executor = self._executor
            job.future = asyncio.get_running_loop().run_in_executor(self._executor, self._job_fn, *job.args)
        except (BrokenProcessPool, RuntimeError):
            log.exception("Could not resubmit analysis %s", job.info.analysis_id)
            return False
        log.info("Resubmitted queued analysis %s after a worker crash", job.info.analysis_id)
        return True

    async def _watch(self, job: _Job) -> None:
        aid = job.info.analysis_id
        while True:
            assert job.future is not None
            try:
                result_json = await job.future
                break
            except asyncio.CancelledError:
                if job.cancel_requested:
                    self._finish(job, "cancelled")
                else:  # shutdown
                    self._absorb_progress(job)
                    self._finish(
                        job,
                        "failed",
                        "The server shut down before this analysis finished. Please run it again.",
                    )
                return
            except JobCancelled:
                self._finish(job, "cancelled")
                return
            except BrokenProcessPool:
                # A dead worker breaks the whole pool: every pending future fails, including
                # jobs that were still queued. Only the ones that had started (the worker
                # writes a progress entry first thing) can be blamed; the rest are re-queued.
                # Check before _absorb_progress, which pops the entry.
                started = self._progress_entry(aid) is not None or job.info.started_at is not None
                self._replace_executor(job.executor)
                if not started and self._resubmit(job):
                    continue  # stays 'queued'
                self._absorb_progress(job)
                self._finish(
                    job,
                    "failed",
                    "The worker process running this analysis crashed unexpectedly "
                    "(it may have run out of memory)."
                    if started
                    else "The analysis could not start because the worker pool kept crashing. "
                    "Please run it again.",
                )
                return
            except Exception as exc:
                self._absorb_progress(job)
                self._finish(job, "failed", describe_error(exc))
                return
        self._absorb_progress(job)

        if job.cancel_requested:
            self._finish(job, "cancelled")
            return
        try:
            result = await asyncio.to_thread(self._store_result, aid, result_json)
        except Exception as exc:
            self._finish(job, "failed", f"The analysis returned an invalid result: {describe_error(exc)}")
            return
        if job.cancel_requested:  # cancelled while we were saving
            return
        self._cache_result(aid, result)
        self._finish(job, "completed")

    def _finish(self, job: _Job, status: str, error: Optional[str] = None) -> None:
        info = job.info
        if info.status in TERMINAL:
            return
        if info.started_at is None:
            entry = self._progress_entry(info.analysis_id)
            if entry:
                info.started_at = _parse_dt(entry.get("started_at"))
                info.progress = float(entry.get("progress", info.progress))
        info.status = status  # type: ignore[assignment]
        info.error = error
        info.finished_at = _now()
        if status == "completed":
            info.progress = 1.0
            info.stage = "done"
        elif status == "cancelled":
            info.stage = "cancelled"
        self._write_meta(job)

    # ----------------------------------------------------------------- reads
    def _progress_entry(self, aid: str) -> Optional[Dict[str, Any]]:
        if self._progress is None:
            return None
        try:
            entry = self._progress.get(aid)
        except Exception:
            return None
        return entry if isinstance(entry, dict) else None

    def _snapshot(self) -> Dict[str, Any]:
        if self._progress is None or not any(j.info.status not in TERMINAL for j in self._jobs.values()):
            return {}
        try:
            return self._progress.copy()
        except Exception:
            return {}

    def _view(self, job: _Job, snapshot: Dict[str, Any]) -> JobInfo:
        info = job.info
        if info.status in TERMINAL:
            return info.model_copy()
        entry = snapshot.get(info.analysis_id)
        if not isinstance(entry, dict):
            return info.model_copy()
        return info.model_copy(
            update={
                "status": "running",
                "progress": float(entry.get("progress", 0.0)),
                "stage": entry.get("stage"),
                "started_at": _parse_dt(entry.get("started_at")) or info.started_at,
            }
        )

    def _get(self, aid: str) -> _Job:
        job = self._jobs.get(aid)
        if job is None:
            raise JobNotFound(aid)
        return job

    def list_jobs(self) -> List[JobInfo]:
        snap = self._snapshot()
        infos = [self._view(j, snap) for j in self._jobs.values()]
        infos.sort(key=lambda i: i.submitted_at, reverse=True)
        return infos

    def get_info(self, aid: str) -> JobInfo:
        job = self._get(aid)
        snap = {aid: self._progress_entry(aid)} if job.info.status not in TERMINAL else {}
        return self._view(job, snap)

    def get_config(self, aid: str) -> Optional[AnalysisConfig]:
        return self._get(aid).config

    async def get_result(self, aid: str) -> AnalysisResult:
        job = self._get(aid)
        if job.info.status != "completed":
            raise JobNotReady(f"Analysis is {job.info.status}; no result available.")
        cached = self._results.get(aid)
        if cached is not None:
            self._results.move_to_end(aid)
            return cached
        result = await asyncio.to_thread(self._read_result, aid)
        self._cache_result(aid, result)
        return result

    async def get_detail(self, aid: str) -> JobDetail:
        info = self.get_info(aid)
        result = await self.get_result(aid) if info.status == "completed" else None
        return JobDetail(**info.model_dump(), result=result)

    # ------------------------------------------------------- cancel / delete
    def _set_cancel_flag(self, aid: str) -> None:
        if self._progress is None:
            return
        try:
            self._progress[CANCEL_PREFIX + aid] = True
        except Exception:
            pass

    async def cancel_or_delete(self, aid: str) -> str:
        """Cancel a queued/running job (returns "cancelled") or delete a finished one ("deleted")."""
        job = self._get(aid)
        if job.info.status not in TERMINAL:
            job.cancel_requested = True
            self._set_cancel_flag(aid)
            if job.future is not None:
                job.future.cancel()
            self._finish(job, "cancelled")
            return "cancelled"
        self._jobs.pop(aid, None)
        self._results.pop(aid, None)
        for p in (self._meta_path(aid), self._result_path(aid)):
            try:
                p.unlink()
            except FileNotFoundError:
                pass
        return "deleted"


def _parse_dt(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value))
    except ValueError:
        return None
