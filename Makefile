# Propensity Modeling & Brand Lift Analyzer — developer shortcuts.
# Run from the repository root. Requires uv (Python) and npm (Node 18+).

PORT ?= 8000
HOST ?= 127.0.0.1
SITE_PORT ?= 4173

.PHONY: help install dev-backend dev-frontend test test-python test-frontend build serve sample lint clean site site-data site-check

help:
	@echo "make install       uv sync + npm install"
	@echo "make dev-backend   FastAPI with auto-reload on :$(PORT)"
	@echo "make dev-frontend  Vite dev server on :5173 (proxies /api to :$(PORT))"
	@echo "make test          all Python + frontend tests"
	@echo "make build         production frontend build (frontend/dist)"
	@echo "make serve         single-process prod: build, then uvicorn serves API + UI on :$(PORT)"
	@echo "make sample        regenerate sample_data/brand_lift_sample.xlsx"
	@echo "make site          preview the documentation site on :$(SITE_PORT)"
	@echo "make site-data     regenerate the site's API reference and walkthrough data"
	@echo "make site-check    fail if the committed API reference is out of date"

install:
	uv sync
	cd frontend && npm install

dev-backend:
	uv run python backend/run.py --host $(HOST) --port $(PORT)

dev-frontend:
	cd frontend && API_TARGET=http://localhost:$(PORT) npm run dev

test: test-python test-frontend

test-python:
	uv run pytest packages backend -q

test-frontend:
	cd frontend && npx tsc --noEmit && npx vitest run

build:
	cd frontend && npm run build

serve: build
	uv run uvicorn app.main:app --app-dir backend --host $(HOST) --port $(PORT)

sample:
	uv run python scripts/make_sample_excel.py

site:
	uv run python -m http.server $(SITE_PORT) --bind $(HOST) --directory site

site-data:
	uv run python scripts/build_site_data.py

site-check:
	uv run python scripts/build_site_data.py --check

lint:
	uv run ruff check packages backend

clean:
	rm -rf frontend/dist .pytest_cache .ruff_cache
