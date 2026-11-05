from __future__ import annotations

import asyncio
from typing import List, Optional

from fastapi import APIRouter, File, HTTPException, Query, Request, Response, UploadFile
from propensity_lift.schemas import DatasetProfile

from app.storage import DatasetNotFound, DatasetStore, SheetNotFound, UploadError

router = APIRouter(prefix="/datasets", tags=["datasets"])


def _store(request: Request) -> DatasetStore:
    return request.app.state.store


@router.post("", response_model=DatasetProfile, status_code=201)
async def upload_dataset(
    request: Request,
    file: UploadFile = File(..., description="Excel (.xlsx/.xls) or CSV of respondent-level data"),
    sheet: Optional[str] = Query(None, description="Sheet to profile (default: first sheet)"),
) -> DatasetProfile:
    store = _store(request)
    settings = request.app.state.settings
    try:
        partial = await store.save_upload(file, settings.max_upload_bytes)
        return await asyncio.to_thread(store.ingest, partial, sheet)
    except UploadError as exc:
        raise HTTPException(exc.status_code, exc.detail) from exc
    finally:
        await file.close()


@router.get("", response_model=List[DatasetProfile])
async def list_datasets(request: Request) -> List[DatasetProfile]:
    return await asyncio.to_thread(_store(request).list_profiles)


@router.get("/{dataset_id}", response_model=DatasetProfile)
async def get_dataset(request: Request, dataset_id: str, sheet: Optional[str] = Query(None)) -> DatasetProfile:
    try:
        return await asyncio.to_thread(_store(request).get_profile, dataset_id, sheet)
    except DatasetNotFound as exc:
        raise HTTPException(404, f"Dataset '{dataset_id}' not found.") from exc
    except SheetNotFound as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:  # parsing a not-yet-cached sheet failed
        raise HTTPException(422, f"Could not read sheet '{sheet}': {exc}") from exc


@router.delete("/{dataset_id}", status_code=204)
async def delete_dataset(request: Request, dataset_id: str) -> Response:
    try:
        await asyncio.to_thread(_store(request).delete, dataset_id)
    except DatasetNotFound as exc:
        raise HTTPException(404, f"Dataset '{dataset_id}' not found.") from exc
    return Response(status_code=204)
