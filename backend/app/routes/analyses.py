from __future__ import annotations

import asyncio
import re
from typing import List

from fastapi import APIRouter, HTTPException, Request, Response
from propensity_lift.schemas import (
    AnalysisConfig,
    AnalysisSubmitted,
    JobDetail,
    JobInfo,
)

from app.export import build_workbook
from app.jobs import JobManager, JobNotFound, JobNotReady, ServiceUnavailable
from app.storage import DatasetNotFound, DatasetStore, SheetNotFound
from app.validation import check_columns, check_groups

router = APIRouter(prefix="/analyses", tags=["analyses"])

XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _jobs(request: Request) -> JobManager:
    return request.app.state.jobs


def _store(request: Request) -> DatasetStore:
    return request.app.state.store


def _prepare(store: DatasetStore, config: AnalysisConfig):
    """Blocking validation (runs in a thread). Returns the cached data path or raises HTTPException."""
    try:
        profile = store.get_profile(config.dataset_id, config.sheet)
    except DatasetNotFound:
        raise HTTPException(422, f"Dataset '{config.dataset_id}' not found. Upload it again.")
    except SheetNotFound as exc:
        raise HTTPException(422, str(exc))
    errors = check_columns(config, profile)
    if errors:
        raise HTTPException(422, " ".join(errors))
    data_path = store.data_path(config.dataset_id, config.sheet)
    treatment = store.load_columns(config.dataset_id, config.sheet, [config.treatment_column])[
        config.treatment_column
    ]
    errors = check_groups(config, treatment)
    if errors:
        raise HTTPException(422, " ".join(errors))
    return data_path


@router.post("", response_model=AnalysisSubmitted, status_code=202)
async def submit_analysis(request: Request, config: AnalysisConfig) -> AnalysisSubmitted:
    data_path = await asyncio.to_thread(_prepare, _store(request), config)
    try:
        info = await _jobs(request).submit(config, data_path)
    except ServiceUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    return AnalysisSubmitted(analysis_id=info.analysis_id, status=info.status)


@router.get("", response_model=List[JobInfo])
async def list_analyses(request: Request) -> List[JobInfo]:
    return _jobs(request).list_jobs()


@router.get("/{analysis_id}", response_model=JobDetail)
async def get_analysis(request: Request, analysis_id: str) -> JobDetail:
    try:
        return await _jobs(request).get_detail(analysis_id)
    except JobNotFound as exc:
        raise HTTPException(404, f"Analysis '{analysis_id}' not found.") from exc


@router.delete("/{analysis_id}", status_code=204)
async def delete_analysis(request: Request, analysis_id: str) -> Response:
    try:
        await _jobs(request).cancel_or_delete(analysis_id)
    except JobNotFound as exc:
        raise HTTPException(404, f"Analysis '{analysis_id}' not found.") from exc
    return Response(status_code=204)


@router.get("/{analysis_id}/export")
async def export_analysis(request: Request, analysis_id: str) -> Response:
    jobs = _jobs(request)
    try:
        result = await jobs.get_result(analysis_id)
    except JobNotFound as exc:
        raise HTTPException(404, f"Analysis '{analysis_id}' not found.") from exc
    except JobNotReady as exc:
        raise HTTPException(409, str(exc)) from exc
    content = await asyncio.to_thread(build_workbook, result)
    stem = re.sub(r"[^A-Za-z0-9_-]+", "_", result.config.name or "")[:60].strip("_") or "brand_lift"
    filename = f"{stem}_{analysis_id[:8]}.xlsx"
    return Response(
        content=content,
        media_type=XLSX_MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
