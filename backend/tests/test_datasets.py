from __future__ import annotations

from backend_helpers import csv_bytes, make_frame, upload, xlsx_bytes


def test_health(app_factory):
    with app_factory(max_workers=3) as c:
        r = c.get("/api/health")
        assert r.status_code == 200
        assert r.json() == {"status": "ok", "workers": 3}


def test_upload_csv_profile(app_factory):
    with app_factory() as c:
        prof = upload(c, kind="csv")
        assert len(prof["dataset_id"]) == 32
        assert prof["filename"] == "survey.csv"
        assert prof["sheet_names"] == [] and prof["sheet"] is None
        assert prof["n_rows"] == 200 and prof["n_cols"] == 7
        cols = {col["name"]: col for col in prof["columns"]}
        assert cols["age"]["kind"] == "numeric"
        assert {v["value"] for v in cols["group"]["top_values"]} == {"Exposed", "Control"}

        r = c.get(f"/api/datasets/{prof['dataset_id']}")
        assert r.status_code == 200 and r.json() == prof
        listing = c.get("/api/datasets").json()
        assert [d["dataset_id"] for d in listing] == [prof["dataset_id"]]


def test_upload_xlsx_multiple_sheets(app_factory):
    df1, df2 = make_frame(50), make_frame(30, seed=1).drop(columns=["intent"])
    content = xlsx_bytes({"Wave 1": df1, "Wave 2": df2})
    with app_factory() as c:
        r = c.post(
            "/api/datasets",
            files={"file": ("../../evil name?.xlsx", content, "application/octet-stream")},
        )
        assert r.status_code == 201, r.text
        prof = r.json()
        assert prof["filename"] == "evil name_.xlsx"
        assert prof["sheet_names"] == ["Wave 1", "Wave 2"]
        assert prof["sheet"] == "Wave 1" and prof["n_rows"] == 50

        r = c.get(f"/api/datasets/{prof['dataset_id']}", params={"sheet": "Wave 2"})
        assert r.status_code == 200
        assert r.json()["sheet"] == "Wave 2" and r.json()["n_rows"] == 30 and r.json()["n_cols"] == 6

        r = c.get(f"/api/datasets/{prof['dataset_id']}", params={"sheet": "Nope"})
        assert r.status_code == 422 and "Wave 1" in r.json()["detail"]

        # upload choosing a sheet up front
        r = c.post("/api/datasets", params={"sheet": "Wave 2"}, files={"file": ("w.xlsx", content)})
        assert r.status_code == 201 and r.json()["sheet"] == "Wave 2"
        r = c.post("/api/datasets", params={"sheet": "Missing"}, files={"file": ("w.xlsx", content)})
        assert r.status_code == 422


def test_upload_rejections(app_factory):
    with app_factory(max_upload_mb=0.01) as c:
        r = c.post("/api/datasets", files={"file": ("data.txt", b"a,b\n1,2\n")})
        assert r.status_code == 415
        r = c.post("/api/datasets", files={"file": ("data.csv", b"")})
        assert r.status_code == 422
        r = c.post("/api/datasets", files={"file": ("big.csv", b"a,b\n" + b"1,2\n" * 5000)})
        assert r.status_code == 413
        r = c.post("/api/datasets", files={"file": ("broken.xlsx", b"this is not a workbook")})
        assert r.status_code == 422
        # nothing half-written left behind
        assert c.get("/api/datasets").json() == []


def test_delete_dataset(app_factory):
    with app_factory() as c:
        prof = upload(c)
        did = prof["dataset_id"]
        assert c.delete(f"/api/datasets/{did}").status_code == 204
        assert c.get(f"/api/datasets/{did}").status_code == 404
        assert c.delete(f"/api/datasets/{did}").status_code == 404
        assert c.get("/api/datasets/../../etc").status_code == 404


def test_mixed_type_column_survives_cache(app_factory):
    df = make_frame(60)
    df["notes"] = [1, "two", 3.5] * 20  # parquet can't store this -> pickle fallback
    with app_factory() as c:
        r = c.post("/api/datasets", files={"file": ("m.csv", csv_bytes(df))})
        assert r.status_code == 201
        r = c.post("/api/datasets", files={"file": ("m.xlsx", xlsx_bytes({"S": df}))})
        assert r.status_code == 201, r.text


def test_frontend_served_with_spa_fallback(app_factory, tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>spa</html>")
    (dist / "assets" / "app.js").write_text("console.log(1)")
    with app_factory(frontend_dist=dist) as c:
        assert "spa" in c.get("/").text
        assert c.get("/assets/app.js").text == "console.log(1)"
        assert "spa" in c.get("/results/abc").text
        assert c.get("/api/health").json()["status"] == "ok"
        assert c.get("/api/does-not-exist").status_code == 404
