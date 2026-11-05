"""Runtime settings for the lift API, read from environment variables (or backend/.env).

Environment variables (case-insensitive):

* ``DATA_DIR``          where uploads, cached parquet and analysis results live
                        (default: ``backend/data``)
* ``MAX_WORKERS``       size of the analysis process pool (default: ``max(1, cpu_count - 1)``)
* ``MAX_UPLOAD_MB``     upload size limit in megabytes (default: 100)
* ``CORS_ORIGINS``      JSON list of allowed browser origins (default: ``["http://localhost:5173"]``)
* ``FRONTEND_DIST``     built frontend served at ``/`` when the directory exists
                        (default: ``frontend/dist``)
* ``SHUTDOWN_GRACE_SECONDS`` how long shutdown waits for running workers to stop (default: 5)
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import List

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_DIR.parent


def _default_workers() -> int:
    return max(1, (os.cpu_count() or 2) - 1)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    data_dir: Path = BACKEND_DIR / "data"
    max_workers: int = Field(default_factory=_default_workers, ge=1)
    max_upload_mb: float = Field(100.0, gt=0)
    cors_origins: List[str] = Field(default_factory=lambda: ["http://localhost:5173"])
    frontend_dist: Path = PROJECT_ROOT / "frontend" / "dist"
    shutdown_grace_seconds: float = Field(5.0, ge=0)

    @property
    def max_upload_bytes(self) -> int:
        return int(self.max_upload_mb * 1024 * 1024)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
