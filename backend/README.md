# lift-api (FastAPI backend)

Run from the project root (uv workspace already synced):

```bash
uv run uvicorn app.main:app --app-dir backend --reload --port 8000
# or, reloading only on backend/ + packages/ changes:
uv run python backend/run.py            # --no-reload, --port, --host
```

Settings (env vars or `backend/.env`): `DATA_DIR` (default `backend/data`), `MAX_WORKERS`
(default `cpu_count-1`), `MAX_UPLOAD_MB` (100), `CORS_ORIGINS` (JSON list, default
`["http://localhost:5173"]`), `FRONTEND_DIST` (default `frontend/dist`; served at `/` with SPA
fallback when it exists), `SHUTDOWN_GRACE_SECONDS` (5).

Tests: `uv run pytest backend/tests -q`

Notes
* Analyses run in a spawn-context `ProcessPoolExecutor`; the event loop only schedules and polls.
* Cancelling a *running* job marks it `cancelled` at once; the worker stops at its next progress
  checkpoint (cooperative flag) and any result it still produces is discarded.
* Jobs that were queued/running when the server stopped are reported as `failed` after restart.
* Validation errors from `POST /api/analyses` are 422 with a string `detail`; request-shape errors
  (pydantic) are FastAPI's standard 422 with a list `detail`.
