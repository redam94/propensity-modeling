"""Job manager / analyses API tests using the fake job function from ``fakes.py``."""

from __future__ import annotations

import io
import json
import time
from datetime import datetime

import pytest
from backend_helpers import base_config, make_frame, upload, wait_for
from openpyxl import load_workbook


def _submit(c, cfg):
    r = c.post("/api/analyses", json=cfg)
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["status"] == "queued"
    return body["analysis_id"]


# --------------------------------------------------------------------------- validation
@pytest.mark.parametrize(
    "overrides, fragment",
    [
        ({"dataset_id": "0" * 32}, "not found"),
        ({"treatment_column": "nope"}, "Treatment column not found"),
        ({"outcome_columns": ["aware", "missing_kpi"]}, "'missing_kpi'"),
        ({"model_features": ["age", "ghost"]}, "Model feature(s) not found"),
        ({"matching_features": ["ghost2"]}, "Matching feature(s) not found"),
        ({"model_features": ["age", "aware"]}, "cannot also be features"),
        ({"model_features": ["age", "group"]}, "cannot also be a feature"),
        ({"model_features": [], "matching_features": []}, "at least one model feature"),
        ({"exposed_values": ["Nobody"]}, "exposed group has 0"),
        ({"control_values": ["Exposed"]}, "both exposed and control"),
        ({"exposed_values": ["Exposed", "EXPOSED"], "control_values": ["exposed"]}, "both exposed and control"),
        ({"sheet": "Nope"}, "not found"),
    ],
)
def test_submit_validation_422(app_factory, overrides, fragment):
    with app_factory() as c:
        did = upload(c)["dataset_id"]
        r = c.post("/api/analyses", json=base_config(did, **overrides))
        assert r.status_code == 422, r.text
        assert fragment in r.json()["detail"]
        assert c.get("/api/analyses").json() == []


def test_small_control_group_rejected(app_factory):
    with app_factory() as c:
        did = upload(c, make_frame(100, n_exposed=95))["dataset_id"]
        r = c.post("/api/analyses", json=base_config(did))
        assert r.status_code == 422
        assert "control group has 5" in r.json()["detail"]


def test_numeric_treatment_codes_match_loosely(app_factory):
    df = make_frame(100)
    df["group"] = (df["group"] == "Exposed").astype(int)
    with app_factory() as c:
        did = upload(c, df)["dataset_id"]
        # "1" (string) vs 1 (int column) and control None => every other value
        aid = _submit(c, base_config(did, exposed_values=["1"], control_values=None))
        assert wait_for(c, aid)["status"] == "completed"


def test_pydantic_shape_errors_are_422(app_factory):
    with app_factory() as c:
        r = c.post("/api/analyses", json={"dataset_id": "x"})
        assert r.status_code == 422


# --------------------------------------------------------------------------- lifecycle
def test_submit_poll_complete_and_list(app_factory):
    with app_factory() as c:
        did = upload(c, kind="xlsx")["dataset_id"]
        aid = _submit(c, base_config(did, name="sleep:0.5"))
        seen = set()
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            body = c.get(f"/api/analyses/{aid}").json()
            seen.add(body["status"])
            if body["status"] == "running":
                assert 0 <= body["progress"] <= 1 and body["stage"]
                assert body["started_at"] is not None
            if body["status"] == "completed":
                break
            time.sleep(0.05)
        assert body["status"] == "completed", body
        assert "running" in seen
        assert body["progress"] == 1.0 and body["error"] is None
        assert body["result"]["analysis_id"] == aid
        assert body["result"]["config"]["dataset_id"] == did
        assert body["started_at"] and body["finished_at"]

        listing = c.get("/api/analyses").json()
        assert [j["analysis_id"] for j in listing] == [aid]
        assert "result" not in listing[0]
        assert c.get("/api/analyses/" + "f" * 32).status_code == 404


def test_parallel_jobs_keep_event_loop_responsive(app_factory):
    with app_factory(max_workers=3) as c:
        did = upload(c)["dataset_id"]
        ids = [_submit(c, base_config(did, name="sleep:3")) for _ in range(3)]

        latencies = []
        while True:
            t0 = time.perf_counter()
            assert c.get("/api/health").status_code == 200
            latencies.append(time.perf_counter() - t0)
            statuses = [s["status"] for s in c.get("/api/analyses").json()]
            if all(s == "completed" for s in statuses):
                break
            assert not any(s in ("failed", "cancelled") for s in statuses), statuses
            time.sleep(0.05)

        assert len(latencies) > 20
        assert max(latencies) < 0.5, f"health latency spiked to {max(latencies):.3f}s"

        jobs = [c.get(f"/api/analyses/{a}").json() for a in ids]
        starts = [datetime.fromisoformat(j["started_at"]) for j in jobs]
        ends = [datetime.fromisoformat(j["finished_at"]) for j in jobs]
        # all three were running at the same moment
        assert max(starts) < min(ends), (starts, ends)


def test_cancel_queued_and_running(app_factory):
    with app_factory(max_workers=1) as c:
        did = upload(c)["dataset_id"]
        running = _submit(c, base_config(did, name="sleep:30"))
        queued = _submit(c, base_config(did, name="sleep:30"))
        wait_for(c, running, statuses=("running",))
        assert c.get(f"/api/analyses/{queued}").json()["status"] == "queued"

        assert c.delete(f"/api/analyses/{queued}").status_code == 204
        assert c.get(f"/api/analyses/{queued}").json()["status"] == "cancelled"
        assert c.delete(f"/api/analyses/{running}").status_code == 204
        body = c.get(f"/api/analyses/{running}").json()
        assert body["status"] == "cancelled" and body["result"] is None

        # the single worker slot is released quickly (cooperative cancel), not after 30 s
        t0 = time.monotonic()
        quick = _submit(c, base_config(did, name="quick"))
        assert wait_for(c, quick, timeout=15)["status"] == "completed"
        assert time.monotonic() - t0 < 15

        # cancelled jobs stay cancelled; deleting a finished job removes it
        assert c.get(f"/api/analyses/{running}").json()["status"] == "cancelled"
        assert c.delete(f"/api/analyses/{running}").status_code == 204
        assert c.get(f"/api/analyses/{running}").status_code == 404
        assert c.delete(f"/api/analyses/{quick}").status_code == 204
        assert c.get(f"/api/analyses/{quick}").status_code == 404


def test_failures_are_surfaced(app_factory):
    with app_factory(max_workers=2) as c:
        did = upload(c)["dataset_id"]
        a = _submit(c, base_config(did, name="fail:value"))
        b = _submit(c, base_config(did, name="fail:runtime"))
        ja, jb = wait_for(c, a), wait_for(c, b)
        assert ja["status"] == "failed"
        assert ja["error"] == "Treatment column has only one level after filtering."
        assert jb["status"] == "failed"
        assert jb["error"].startswith("ZeroDivisionError:")
        assert ja["result"] is None

        crash = _submit(c, base_config(did, name="fail:crash"))
        jc = wait_for(c, crash)
        assert jc["status"] == "failed" and "crashed" in jc["error"]

        # server still healthy and the pool was rebuilt
        assert c.get("/api/health").status_code == 200
        ok = _submit(c, base_config(did, name="quick"))
        assert wait_for(c, ok)["status"] == "completed"
        assert c.get(f"/api/analyses/{a}/export").status_code == 409


def test_export_workbook(app_factory):
    with app_factory() as c:
        did = upload(c)["dataset_id"]
        aid = _submit(c, base_config(did, name="My Campaign Q3"))
        assert wait_for(c, aid)["status"] == "completed"
        r = c.get(f"/api/analyses/{aid}/export")
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("application/vnd.openxmlformats")
        assert "My_Campaign_Q3" in r.headers["content-disposition"]
        wb = load_workbook(io.BytesIO(r.content))
        for sheet in ("Summary", "Contrasts", "Balance", "Overlap", "FeatureOverlap", "Subgroups", "Config"):
            assert sheet in wb.sheetnames
        contrasts = list(wb["Contrasts"].values)
        assert contrasts[0][:3] == ("method", "method_label", "outcome")
        assert contrasts[1][0] == "ipw" and contrasts[1][2] == "aware"
        overlap_text = " ".join(str(v) for row in wb["Overlap"].values for v in row if v is not None)
        assert "control_only" in overlap_text and "exposed_only" in overlap_text and "bin_lower" in overlap_text
        assert c.get("/api/analyses/" + "0" * 32 + "/export").status_code == 404


def test_restart_persistence(app_factory, tmp_path):
    data_dir = tmp_path / "persist"
    with app_factory(data_dir=data_dir) as c:
        did = upload(c)["dataset_id"]
        done = _submit(c, base_config(did, name="quick"))
        assert wait_for(c, done)["status"] == "completed"
        interrupted = _submit(c, base_config(did, name="sleep:60"))
        wait_for(c, interrupted, statuses=("running",))
        t0 = time.monotonic()
    assert time.monotonic() - t0 < 10  # graceful shutdown doesn't wait for the 60 s job

    # simulate a crash that left a job 'running' on disk
    meta = json.loads((data_dir / "analyses" / f"{done}.meta.json").read_text())
    meta["info"].update(analysis_id="a" * 32, status="running", finished_at=None)
    (data_dir / "analyses" / f"{'a' * 32}.meta.json").write_text(json.dumps(meta))

    with app_factory(data_dir=data_dir) as c:
        assert c.get(f"/api/datasets/{did}").status_code == 200
        jd = c.get(f"/api/analyses/{done}").json()
        assert jd["status"] == "completed" and jd["result"]["analysis_id"] == done
        ji = c.get(f"/api/analyses/{interrupted}").json()
        assert ji["status"] == "failed" and "shut down" in ji["error"]
        jc = c.get(f"/api/analyses/{'a' * 32}").json()
        assert jc["status"] == "failed" and "stopped while this analysis was running" in jc["error"]
        assert len(c.get("/api/analyses").json()) == 3
        assert c.get(f"/api/analyses/{done}/export").status_code == 200


# --------------------------------------------------------------------------- review regressions
@pytest.mark.parametrize(
    "overrides, fragment",
    [
        ({"alpha": 0}, "alpha"),
        ({"alpha": -0.1}, "alpha"),
        ({"alpha": 1.5}, "alpha"),
        ({"caliper": 0}, "Caliper"),
        ({"caliper": -1}, "Caliper"),
        ({"weight_clip": 0}, "Weight clip"),
        ({"weight_clip": 2}, "Weight clip"),
    ],
)
def test_out_of_range_parameters_rejected(app_factory, overrides, fragment):
    with app_factory() as c:
        did = upload(c)["dataset_id"]
        r = c.post("/api/analyses", json=base_config(did, **overrides))
        assert r.status_code == 422, r.text
        assert fragment in r.json()["detail"]
        assert c.get("/api/analyses").json() == []
        # None still means "disabled"
        ok = c.post("/api/analyses", json=base_config(did, caliper=None, weight_clip=None, alpha=0.5))
        assert ok.status_code == 202, ok.text


def test_worker_crash_only_fails_running_job(app_factory):
    """A dead worker breaks every pending future; queued jobs must be resubmitted, not failed."""
    with app_factory(max_workers=1) as c:
        did = upload(c)["dataset_id"]
        crash = _submit(c, base_config(did, name="crash-after:1.0"))
        queued = [_submit(c, base_config(did, name=f"quick-{i}")) for i in range(2)]
        jc = wait_for(c, crash)
        assert jc["status"] == "failed" and "crashed" in jc["error"], jc
        for aid in queued:
            body = wait_for(c, aid)
            assert body["status"] == "completed", body
            assert body["error"] is None


def test_export_neutralises_formulas_and_control_characters():
    import pandas as pd

    import fakes
    from app.export import build_workbook
    from propensity_lift.schemas import AnalysisConfig

    cfg = AnalysisConfig.model_validate(
        base_config("d" * 32, name="=1+1", model_features=["reg\x01ion"], subgroup_columns=["region"])
    )
    result = fakes.fake_result(pd.DataFrame({"x": [1, 2]}), cfg, "a" * 32)
    m = result.methods[0]
    m.subgroups[0].subgroup_level = '=HYPERLINK("http://evil.example","click")'
    m.balance[0].variable = "region=North\x01East"
    m.warnings.append("@SUM(1,2)")
    result.feature_overlap[0].levels[0].level = "-2+3"
    result.feature_overlap[0].control_only_levels = ["+cmd", "North\x01East"]
    result.warnings.append("Note\x02 with control char")

    wb = load_workbook(io.BytesIO(build_workbook(result)))
    texts = []
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                assert cell.data_type != "f", (ws.title, cell.coordinate, cell.value)
                if isinstance(cell.value, str):
                    assert "\x01" not in cell.value and "\x02" not in cell.value
                    texts.append(cell.value)
    assert "'=1+1" in texts
    assert "'=HYPERLINK(\"http://evil.example\",\"click\")" in texts
    assert "region=NorthEast" in texts
    assert "'-2+3" in texts
    assert "'+cmd, NorthEast" in texts
    # numbers (including negatives) stay numeric
    assert any(isinstance(v, float) for v in next(wb["Contrasts"].iter_rows(min_row=2, values_only=True)))
