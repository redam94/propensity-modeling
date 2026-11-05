"""End-to-end through the real worker (``app.worker.run_job`` -> ``propensity_lift.run_analysis``)."""

from __future__ import annotations

import io

import pytest
from backend_helpers import upload, wait_for
from openpyxl import load_workbook

try:

    IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover - only while the package is incomplete
    IMPORT_ERROR = f"propensity_lift analysis functions unavailable: {exc!r}"

pytestmark = pytest.mark.skipif(IMPORT_ERROR is not None, reason=IMPORT_ERROR or "")


def _sample_config(profile):
    by_role = {}
    for col in profile["columns"]:
        by_role.setdefault(col["suggested_role"], []).append(col)
    treatment = by_role["treatment"][0]
    values = [v["value"] for v in treatment["top_values"]]
    outcomes = [c["name"] for c in by_role.get("outcome", [])][:2]
    features = [c["name"] for c in by_role.get("model_feature", [])]
    matching = [c["name"] for c in by_role.get("matching_feature", [])]
    return treatment["name"], values, outcomes, features, matching


def test_real_analysis_end_to_end(app_factory):
    from propensity_lift.sample_data import make_brand_lift_sample

    df = make_brand_lift_sample(n=1500, seed=1)
    with app_factory(job_fn=None, max_workers=2) as c:
        prof = upload(c, df, kind="xlsx")
        treatment, values, outcomes, features, matching = _sample_config(prof)
        assert outcomes and (features or matching), prof
        exposed = [v for v in values if str(v).lower() in ("1", "exposed", "true", "test")] or values[:1]
        cfg = {
            "dataset_id": prof["dataset_id"],
            "name": "e2e",
            "treatment_column": treatment,
            "exposed_values": exposed,
            "outcome_columns": outcomes,
            "model_features": features,
            "matching_features": matching,
            "methods": ["nn_matching", "ipw", "overlap_weights", "stratification"],
            "n_bootstrap": 20,
        }
        r = c.post("/api/analyses", json=cfg)
        assert r.status_code == 202, r.text
        aid = r.json()["analysis_id"]
        body = wait_for(c, aid, timeout=180)
        assert body["status"] == "completed", body["error"]
        res = body["result"]
        assert {m["method"] for m in res["methods"]} == set(cfg["methods"])
        assert [rg["region"] for rg in res["overlap"]["regions"]] == ["control_only", "both", "exposed_only"]
        assert len(res["methods"][0]["contrasts"]) == len(outcomes)

        x = c.get(f"/api/analyses/{aid}/export")
        assert x.status_code == 200
        wb = load_workbook(io.BytesIO(x.content))
        assert {"Summary", "Contrasts", "Balance", "Overlap", "FeatureOverlap", "Subgroups", "Config"} <= set(
            wb.sheetnames
        )
        assert wb["Contrasts"].max_row == 1 + 4 * len(outcomes)


def test_real_analysis_minimal_config_csv(app_factory):
    """CSV upload, a single method, analytic CIs (n_bootstrap=0) through the real worker."""
    from propensity_lift.sample_data import make_brand_lift_sample

    df = make_brand_lift_sample(n=400, seed=2)
    with app_factory(job_fn=None, max_workers=1) as c:
        prof = upload(c, df)
        treatment, values, outcomes, features, matching = _sample_config(prof)
        exposed = [v for v in values if str(v).lower() in ("1", "exposed", "true", "test")] or values[:1]
        cfg = {
            "dataset_id": prof["dataset_id"],
            "treatment_column": treatment,
            "exposed_values": exposed,
            "outcome_columns": outcomes[:1],
            "model_features": features,
            "matching_features": matching,
            "methods": ["ipw"],
            "n_bootstrap": 0,
        }
        r = c.post("/api/analyses", json=cfg)
        assert r.status_code == 202, r.text
        body = wait_for(c, r.json()["analysis_id"], timeout=120)
        assert body["status"] == "completed", body["error"]
