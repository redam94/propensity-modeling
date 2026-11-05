"""Dev entry point: ``uv run python backend/run.py [--no-reload] [--port 8000] [--host 127.0.0.1]``.

Equivalent to ``uv run uvicorn app.main:app --app-dir backend --reload --port 8000``.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import uvicorn

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run the lift API")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-reload", action="store_true")
    args = parser.parse_args()
    backend_dir = Path(__file__).resolve().parent
    uvicorn.run(
        "app.main:app",
        app_dir=str(backend_dir),
        host=args.host,
        port=args.port,
        reload=not args.no_reload,
        reload_dirs=[str(backend_dir / "app"), str(backend_dir.parent / "packages")],
    )
