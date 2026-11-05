"""FastAPI application factory.

Run from the project root::

    uv run uvicorn app.main:app --app-dir backend --reload --port 8000

or ``uv run python backend/run.py``.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from app import __version__
from app.config import Settings, get_settings
from app.jobs import JobFn, JobManager
from app.routes import analyses, datasets
from app.storage import DatasetStore

log = logging.getLogger(__name__)


class SPAStaticFiles(StaticFiles):
    """Static files with single-page-app fallback: unknown non-API paths serve index.html."""

    async def get_response(self, path: str, scope):  # type: ignore[override]
        # Decide on the raw request path: ``path`` has already been normalised by StaticFiles,
        # so e.g. ``/api/datasets/..%2f..%2fx`` would no longer look like an API path.
        raw = scope.get("path", "") or ""
        is_api = raw == "/api" or raw.startswith("/api/") or path == "api" or path.startswith("api/")
        # Missing files (e.g. a stale hashed bundle) must stay 404, not turn into index.html.
        last = raw.rstrip("/").rsplit("/", 1)[-1]
        no_fallback = is_api or raw.startswith("/assets/") or "." in last
        try:
            response = await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code != 404 or no_fallback:
                raise
            return await super().get_response("index.html", scope)
        if response.status_code == 404 and not no_fallback:
            return await super().get_response("index.html", scope)
        return response


class _BodyTooLarge(Exception):
    pass


class UploadLimitMiddleware:
    """Pure ASGI middleware capping the request body of ``POST /api/datasets``.

    Checks ``Content-Length`` up front and, because chunked requests have none, also counts
    body bytes as they are received and aborts with 413 once the limit (plus 1 MB multipart
    overhead) is exceeded -- before the multipart parser can spool the whole file to disk.
    ``DatasetStore.save_upload`` keeps its own byte check as defence in depth.
    """

    OVERHEAD = 1024 * 1024

    def __init__(self, app, max_bytes: int, limit_mb: float):
        self.app = app
        self.limit = max_bytes + self.OVERHEAD
        self.limit_mb = limit_mb

    async def _reject(self, scope, send) -> None:
        response = JSONResponse(
            {"detail": f"File is larger than the {self.limit_mb:g} MB upload limit."},
            status_code=413,
            headers={"Connection": "close"},
        )

        async def no_receive():  # body is not read again
            return {"type": "http.disconnect"}

        await response(scope, no_receive, send)

    async def __call__(self, scope, receive, send):
        if (
            scope["type"] != "http"
            or scope.get("method") != "POST"
            or scope.get("path", "").rstrip("/") != "/api/datasets"
        ):
            await self.app(scope, receive, send)
            return
        length = dict(scope.get("headers") or []).get(b"content-length")
        if length is not None and length.isdigit() and int(length) > self.limit:
            await self._reject(scope, send)
            return

        seen = 0
        too_large = False

        async def limited_receive():
            nonlocal seen, too_large
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > self.limit:
                    too_large = True
                    raise _BodyTooLarge()
            return message

        async def guarded_send(message):
            # FastAPI turns errors raised while reading the body into a 400 response; once
            # the cap has been hit, drop whatever the app sends and answer 413 ourselves.
            if not too_large:
                await send(message)

        try:
            await self.app(scope, limited_receive, guarded_send)
        except Exception:
            if not too_large:
                raise
        if too_large:
            await self._reject(scope, send)


def create_app(settings: Optional[Settings] = None, job_fn: Optional[JobFn] = None) -> FastAPI:
    """Build the app. ``job_fn`` replaces :func:`app.worker.run_job` (tests use this)."""
    settings = settings or get_settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        jobs = JobManager(settings, job_fn=job_fn)
        await jobs.start()
        app.state.jobs = jobs
        log.info("lift-api started: data_dir=%s workers=%d", settings.data_dir, settings.max_workers)
        try:
            yield
        finally:
            await jobs.shutdown()

    app = FastAPI(
        title="Propensity Modeling & Brand Lift API",
        version=__version__,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.store = DatasetStore(settings.data_dir)

    # Wraps the router, so the multipart parser only ever sees the capped body stream.
    # Added before CORS so CORSMiddleware (outer) still decorates the 413 response.
    app.add_middleware(
        UploadLimitMiddleware,
        max_bytes=settings.max_upload_bytes,
        limit_mb=settings.max_upload_mb,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Disposition"],
    )

    api = APIRouter(prefix="/api")

    @api.get("/health", tags=["meta"])
    async def health() -> dict:
        return {"status": "ok", "workers": settings.max_workers}

    api.include_router(datasets.router)
    api.include_router(analyses.router)
    app.include_router(api)

    dist = Path(settings.frontend_dist)
    if (dist / "index.html").is_file():
        app.mount("/", SPAStaticFiles(directory=str(dist), html=True), name="frontend")
    return app


app = create_app()
