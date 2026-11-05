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

from fastapi import APIRouter, FastAPI, Request
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
        is_api = path == "api" or path.startswith("api/")
        try:
            response = await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code != 404 or is_api:
                raise
            return await super().get_response("index.html", scope)
        if response.status_code == 404 and not is_api:
            return await super().get_response("index.html", scope)
        return response


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

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Disposition"],
    )

    @app.middleware("http")
    async def limit_upload_size(request: Request, call_next):
        # Reject oversized uploads before the multipart body is parsed / spooled to disk.
        if request.method == "POST" and request.url.path.rstrip("/") == "/api/datasets":
            length = request.headers.get("content-length")
            # multipart overhead allowance: 1 MB
            if length and length.isdigit() and int(length) > settings.max_upload_bytes + 1024 * 1024:
                return JSONResponse(
                    {"detail": f"File is larger than the {settings.max_upload_mb:g} MB upload limit."},
                    status_code=413,
                )
        return await call_next(request)

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
