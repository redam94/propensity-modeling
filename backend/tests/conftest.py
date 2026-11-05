from __future__ import annotations

import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

import pytest
from fastapi.testclient import TestClient

# Spawned worker processes inherit sys.path; make `fakes` importable there too.
TESTS_DIR = str(Path(__file__).resolve().parent)
if TESTS_DIR not in sys.path:
    sys.path.insert(0, TESTS_DIR)

from app.config import Settings
from app.main import create_app
from backend_helpers import base_config, csv_bytes, make_frame, upload, wait_for, xlsx_bytes  # noqa: F401,E402


@pytest.fixture
def app_factory(tmp_path: Path):
    """Return a context-manager factory yielding a TestClient (lifespan running)."""

    @contextmanager
    def factory(job_fn: Any = "fake", data_dir: Optional[Path] = None, **settings: Any) -> Iterator[TestClient]:
        import fakes

        fn = fakes.fake_job if job_fn == "fake" else job_fn
        s = Settings(
            data_dir=data_dir or tmp_path / "data",
            max_workers=settings.pop("max_workers", 2),
            frontend_dist=settings.pop("frontend_dist", tmp_path / "no-frontend"),
            shutdown_grace_seconds=settings.pop("shutdown_grace_seconds", 10),
            **settings,
        )
        app = create_app(s, job_fn=fn)
        with TestClient(app) as client:
            yield client

    return factory
