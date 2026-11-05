"""Shared helpers for backend tests.

Kept out of conftest.py: a bare ``from conftest import ...`` collides with the package's
tests/conftest.py when both suites run in one pytest session.
"""
from __future__ import annotations

import io
import time
from typing import Any, Dict, Optional

import numpy as np
import pandas as pd
from fastapi.testclient import TestClient

def make_frame(n: int = 200, seed: int = 0, n_exposed: Optional[int] = None) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    age = rng.integers(18, 70, n)
    region = rng.choice(["North", "South", "East", "West"], n)
    gender = rng.choice(["F", "M"], n)
    p = 1 / (1 + np.exp(-(age - 40) / 15))
    exposed = rng.random(n) < p
    if n_exposed is not None:
        exposed = np.zeros(n, dtype=bool)
        exposed[:n_exposed] = True
    aware = (rng.random(n) < 0.3 + 0.2 * exposed).astype(int)
    intent = rng.integers(1, 6, n)
    return pd.DataFrame(
        {
            "resp_id": np.arange(n),
            "group": np.where(exposed, "Exposed", "Control"),
            "age": age,
            "region": region,
            "gender": gender,
            "aware": aware,
            "intent": intent,
        }
    )


def xlsx_bytes(sheets: Dict[str, pd.DataFrame]) -> bytes:
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as xw:
        for name, df in sheets.items():
            df.to_excel(xw, sheet_name=name, index=False)
    return buf.getvalue()


def csv_bytes(df: pd.DataFrame) -> bytes:
    return df.to_csv(index=False).encode()


def base_config(did: str, **overrides: Any) -> Dict[str, Any]:
    cfg: Dict[str, Any] = {
        "dataset_id": did,
        "treatment_column": "group",
        "exposed_values": ["Exposed"],
        "control_values": ["Control"],
        "outcome_columns": ["aware"],
        "model_features": ["age", "region"],
        "matching_features": ["gender"],
        "methods": ["ipw"],
        "n_bootstrap": 0,
    }
    cfg.update(overrides)
    return cfg


def upload(client: TestClient, df: Optional[pd.DataFrame] = None, kind: str = "csv", **params: Any) -> Dict[str, Any]:
    df = make_frame() if df is None else df
    if kind == "csv":
        files = {"file": ("survey.csv", csv_bytes(df), "text/csv")}
    else:
        files = {"file": ("survey.xlsx", xlsx_bytes({"Respondents": df}), "application/octet-stream")}
    r = client.post("/api/datasets", files=files, params=params)
    assert r.status_code == 201, r.text
    return r.json()


def wait_for(client: TestClient, aid: str, statuses=("completed", "failed", "cancelled"), timeout: float = 60) -> Dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        r = client.get(f"/api/analyses/{aid}")
        assert r.status_code == 200, r.text
        body = r.json()
        if body["status"] in statuses:
            return body
        time.sleep(0.1)
    raise AssertionError(f"analysis {aid} did not reach {statuses}; last={body['status']}")
