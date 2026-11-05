"""On-disk dataset store.

Layout::

    DATA_DIR/datasets/{dataset_id}/
        original.xlsx|.xls|.csv     the uploaded file, as received
        meta.json                   filename, sheet names, default sheet, created_at
        {key}.parquet               parsed sheet cache (``{key}.pkl`` if parquet can't hold the data)
        profile_{key}.json          DatasetProfile for that sheet

``key`` is ``data`` for CSV files and ``sheet{index}`` for workbook sheets (sheet names
are never used in paths). Parsing Excel is slow, so every sheet is parsed once and cached;
worker processes read the cache, not the original file.

Every method here is synchronous and may be slow (Excel parsing); callers on the event
loop run them via ``asyncio.to_thread``. The only async method is :meth:`save_upload`.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import unicodedata
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import pandas as pd
from propensity_lift.schemas import DatasetProfile

ALLOWED_EXTENSIONS = (".xlsx", ".xls", ".csv")
CHUNK_SIZE = 1024 * 1024
_ID_RE = re.compile(r"^[0-9a-f]{32}$")


class DatasetNotFound(LookupError):
    pass


class SheetNotFound(ValueError):
    pass


class UploadError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def is_valid_id(value: str) -> bool:
    return bool(_ID_RE.match(value or ""))


def sanitize_filename(name: Optional[str]) -> str:
    """Return a safe display/storage name: basename only, ASCII, no odd characters."""
    base = (name or "").replace("\\", "/").split("/")[-1]
    base = unicodedata.normalize("NFKD", base).encode("ascii", "ignore").decode("ascii")
    base = re.sub(r"[^A-Za-z0-9._ -]+", "_", base).strip(" .")
    if not base:
        base = "upload"
    if len(base) > 120:
        stem, ext = os.path.splitext(base)
        base = stem[: 120 - len(ext)] + ext
    return base


def _atomic_write_text(path: Path, text: str) -> None:
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _normalise_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Column names as unique strings (parquet requires str names; JSON configs use str)."""
    seen: Dict[str, int] = {}
    names: List[str] = []
    for col in df.columns:
        name = str(col).strip() or "unnamed"
        if name in seen:
            seen[name] += 1
            name = f"{name}.{seen[name]}"
        seen.setdefault(name, 0)
        names.append(name)
    if names != list(df.columns):
        df = df.copy()
        df.columns = names
    return df


def write_frame_cache(df: pd.DataFrame, base: Path) -> Path:
    """Cache ``df`` at ``base.parquet``; fall back to pickle for data parquet can't represent
    (e.g. object columns mixing numbers and strings, common in hand-made Excel sheets)."""
    target = base.with_suffix(".parquet")
    tmp = base.with_name(f".{base.name}.{uuid.uuid4().hex}.tmp")
    try:
        df.to_parquet(tmp, index=False)
    except Exception:
        tmp.unlink(missing_ok=True)
        target = base.with_suffix(".pkl")
        df.to_pickle(tmp)
    os.replace(tmp, target)
    return target


def read_frame_cache(path: Path, columns: Optional[Sequence[str]] = None) -> pd.DataFrame:
    path = Path(path)
    if path.suffix == ".parquet":
        return pd.read_parquet(path, columns=list(columns) if columns is not None else None)
    df = pd.read_pickle(path)
    return df[list(columns)] if columns is not None else df


class DatasetStore:
    def __init__(self, data_dir: Path):
        self.root = Path(data_dir) / "datasets"
        self.root.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ paths
    def _dir(self, dataset_id: str) -> Path:
        if not is_valid_id(dataset_id):
            raise DatasetNotFound(dataset_id)
        d = self.root / dataset_id
        if not (d / "meta.json").is_file():
            raise DatasetNotFound(dataset_id)
        return d

    def exists(self, dataset_id: str) -> bool:
        try:
            self._dir(dataset_id)
            return True
        except DatasetNotFound:
            return False

    def get_meta(self, dataset_id: str) -> Dict[str, Any]:
        return json.loads((self._dir(dataset_id) / "meta.json").read_text(encoding="utf-8"))

    @staticmethod
    def _sheet_key(meta: Dict[str, Any], sheet: Optional[str]) -> str:
        if not meta["sheet_names"]:
            return "data"
        return f"sheet{meta['sheet_names'].index(sheet)}"

    def resolve_sheet(self, meta: Dict[str, Any], sheet: Optional[str]) -> Optional[str]:
        """Map a requested sheet (None = default) to an actual sheet name; None for CSV."""
        names: List[str] = meta["sheet_names"]
        if not names:
            if sheet:
                raise SheetNotFound(f"Sheet '{sheet}' not found: '{meta['filename']}' is a CSV file without sheets.")
            return None
        if sheet is None or sheet == "":
            return meta.get("default_sheet") or names[0]
        if sheet not in names:
            raise SheetNotFound(
                f"Sheet '{sheet}' not found. Available sheets: {', '.join(names)}"
            )
        return sheet

    # ----------------------------------------------------------------- upload
    async def save_upload(self, upload: Any, max_bytes: int) -> Dict[str, Any]:
        """Stream an UploadFile to ``DATA_DIR/datasets/{id}/original{ext}``.

        Returns a partial meta dict; call :meth:`ingest` (in a thread) afterwards.
        """
        filename = sanitize_filename(getattr(upload, "filename", None))
        ext = os.path.splitext(filename)[1].lower()
        if ext not in ALLOWED_EXTENSIONS:
            raise UploadError(
                415,
                f"Unsupported file type '{ext or '(none)'}'. Upload an Excel (.xlsx, .xls) or CSV file.",
            )
        dataset_id = uuid.uuid4().hex
        d = self.root / dataset_id
        d.mkdir(parents=True)
        dest = d / f"original{ext}"
        size = 0
        fh = await asyncio.to_thread(open, dest, "wb")
        try:
            try:
                while True:
                    chunk = await upload.read(CHUNK_SIZE)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > max_bytes:
                        raise UploadError(
                            413,
                            f"File is larger than the {max_bytes / (1024 * 1024):g} MB upload limit.",
                        )
                    await asyncio.to_thread(fh.write, chunk)
            finally:
                fh.close()
            if size == 0:
                raise UploadError(422, "The uploaded file is empty.")
        except BaseException:
            shutil.rmtree(d, ignore_errors=True)
            raise
        return {"dataset_id": dataset_id, "filename": filename, "stored_as": dest.name, "size_bytes": size}

    def ingest(self, partial_meta: Dict[str, Any], sheet: Optional[str]) -> DatasetProfile:
        """Parse the stored upload, cache the chosen sheet, write meta + profile.

        Removes the dataset directory on any failure.
        """
        from app.pl_api import get

        list_sheets = get("list_sheets")

        dataset_id = partial_meta["dataset_id"]
        d = self.root / dataset_id
        path = d / partial_meta["stored_as"]
        try:
            try:
                sheet_names = [] if path.suffix.lower() == ".csv" else [str(s) for s in list_sheets(path)]
            except Exception as exc:  # corrupt / not really an Excel file
                raise UploadError(422, f"Could not read '{partial_meta['filename']}': {exc}") from exc
            meta = dict(partial_meta)
            meta.update(
                sheet_names=sheet_names,
                default_sheet=None,
                created_at=datetime.now(timezone.utc).isoformat(),
            )
            if sheet_names:
                if sheet and sheet not in sheet_names:
                    raise UploadError(
                        422, f"Sheet '{sheet}' not found. Available sheets: {', '.join(sheet_names)}"
                    )
                meta["default_sheet"] = sheet or sheet_names[0]
            profile = self._parse_and_cache(d, meta, meta["default_sheet"])
            _atomic_write_text(d / "meta.json", json.dumps(meta, indent=2))
            return profile
        except UploadError:
            shutil.rmtree(d, ignore_errors=True)
            raise
        except Exception as exc:
            shutil.rmtree(d, ignore_errors=True)
            raise UploadError(422, f"Could not read '{partial_meta['filename']}': {exc}") from exc

    def _parse_and_cache(self, d: Path, meta: Dict[str, Any], sheet: Optional[str]) -> DatasetProfile:
        from app.pl_api import get

        load_table, profile_dataframe = get("load_table"), get("profile_dataframe")

        key = self._sheet_key(meta, sheet)
        df = load_table(d / meta["stored_as"], sheet=sheet)
        df = _normalise_columns(df)
        write_frame_cache(df, d / key)
        profile = profile_dataframe(
            df,
            dataset_id=meta["dataset_id"],
            filename=meta["filename"],
            sheet_names=meta["sheet_names"],
            sheet=sheet,
        )
        _atomic_write_text(d / f"profile_{key}.json", profile.model_dump_json())
        return profile

    # ------------------------------------------------------------------ reads
    def get_profile(self, dataset_id: str, sheet: Optional[str] = None) -> DatasetProfile:
        d = self._dir(dataset_id)
        meta = self.get_meta(dataset_id)
        sheet = self.resolve_sheet(meta, sheet)
        p = d / f"profile_{self._sheet_key(meta, sheet)}.json"
        if p.is_file():
            return DatasetProfile.model_validate_json(p.read_text(encoding="utf-8"))
        return self._parse_and_cache(d, meta, sheet)

    def data_path(self, dataset_id: str, sheet: Optional[str] = None) -> Path:
        """Path of the cached frame for ``sheet`` (parsing + caching it if needed)."""
        d = self._dir(dataset_id)
        meta = self.get_meta(dataset_id)
        sheet = self.resolve_sheet(meta, sheet)
        key = self._sheet_key(meta, sheet)
        for suffix in (".parquet", ".pkl"):
            if (d / f"{key}{suffix}").is_file():
                return d / f"{key}{suffix}"
        self._parse_and_cache(d, meta, sheet)
        return self.data_path(dataset_id, sheet)

    def load_columns(self, dataset_id: str, sheet: Optional[str], columns: Sequence[str]) -> pd.DataFrame:
        return read_frame_cache(self.data_path(dataset_id, sheet), columns=columns)

    def list_profiles(self) -> List[DatasetProfile]:
        items = []
        for d in self.root.iterdir():
            if not d.is_dir() or not is_valid_id(d.name):
                continue
            try:
                meta = self.get_meta(d.name)
                items.append((meta.get("created_at", ""), self.get_profile(d.name)))
            except Exception:
                continue  # half-written or corrupt dataset; skip rather than break the listing
        items.sort(key=lambda t: t[0], reverse=True)
        return [p for _, p in items]

    def delete(self, dataset_id: str) -> None:
        d = self._dir(dataset_id)
        shutil.rmtree(d)
