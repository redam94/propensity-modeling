"""Generate the data files the documentation site reads.

Writes two JSON files under ``site/assets/data``:

* ``api.json``          the API reference, introspected from the installed
                        ``propensity_lift`` package, its CLI and the FastAPI
                        app, so the published reference cannot drift from
                        the code.
* ``walkthrough.json``  a real ``run_analysis`` result on the bundled sample
                        data, trimmed to what the walkthrough page plots.

Usage (from the repository root)::

    uv run python scripts/build_site_data.py            # write both files
    uv run python scripts/build_site_data.py --api-only # skip the analysis run
    uv run python scripts/build_site_data.py --check    # exit 1 if api.json is stale
"""

from __future__ import annotations

import argparse
import contextlib
import dataclasses
import importlib
import inspect
import io
import json
import re
import sys
import typing
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "site" / "assets" / "data"
PACKAGE = "propensity_lift"
SOURCE_URL = "https://github.com/redam94/propensity-modeling/blob/main"

# Modules in the order the reference presents them, with a one-line role.
MODULES = [
    ("pipeline", "Run a whole analysis"),
    ("io", "Load and profile data"),
    ("sample_data", "Synthetic sample data"),
    ("preprocess", "Treatment, outcome and feature coding"),
    ("models", "Propensity score models"),
    ("overlap", "Overlap and common support"),
    ("matching", "Nearest-neighbour matching"),
    ("weighting", "Weights and effective sample size"),
    ("doubly_robust", "Doubly robust (AIPW) estimation"),
    ("diagnostics", "Covariate balance"),
    ("lift", "Lift, standard errors and intervals"),
    ("cli", "Command line entry point"),
]

# Result and config models, grouped the way a reader meets them.
SCHEMA_GROUPS = [
    ("Configuration", ["AnalysisConfig"]),
    ("Dataset profile", ["DatasetProfile", "ColumnProfile", "ValueCount"]),
    ("Analysis result", ["AnalysisResult", "SampleSummary", "ModelSummary", "FeatureImportance"]),
    ("Overlap", ["OverlapSummary", "RegionCount", "Histogram", "DensityCurve", "Quantiles",
                 "FeatureOverlap", "LevelShare"]),
    ("Per-method output", ["MethodResult", "BalanceRow", "BalanceSummary", "OutcomeContrast",
                           "SubgroupContrast", "MatchingInfo", "WeightSummary"]),
    ("Job envelopes (HTTP API)", ["JobInfo", "JobDetail", "AnalysisSubmitted"]),
]

TYPE_ALIASES = ["Scalar", "ColumnKind", "ModelType", "Method", "Estimand", "TrimRule", "OutcomeType",
                "JobStatus", "SupportRegion"]


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _type_str(tp: Any) -> str:
    """Readable type annotation: ``Optional[List[str]]`` rather than a repr."""
    if tp is type(None):
        return "None"
    if isinstance(tp, str):
        return tp
    if isinstance(tp, list):  # the parameter list of a Callable
        return "[" + ", ".join(_type_str(a) for a in tp) + "]"
    origin = typing.get_origin(tp)
    args = typing.get_args(tp)
    if origin is typing.Union and set(args) == {str, int, float, bool}:
        return "Scalar"  # the schema module's alias for a cell value
    if origin is typing.Union:
        non_none = [a for a in args if a is not type(None)]
        if len(non_none) < len(args):
            if set(non_none) == {str, int, float, bool}:
                return "Optional[Scalar]"
            inner = _type_str(non_none[0]) if len(non_none) == 1 else " | ".join(_type_str(a) for a in non_none)
            return f"Optional[{inner}]"
        return " | ".join(_type_str(a) for a in args)
    if origin is typing.Literal:
        return "Literal[" + ", ".join(repr(a) for a in args) + "]"
    if origin is not None:
        name = getattr(origin, "__name__", str(origin)).replace("list", "List").replace("dict", "Dict")
        name = {"tuple": "Tuple", "Sequence": "Sequence", "Callable": "Callable"}.get(name, name)
        if args:
            return f"{name}[{', '.join(_type_str(a) for a in args)}]"
        return name
    if hasattr(tp, "__name__"):
        return tp.__name__
    return str(tp).replace("typing.", "")


def _default_str(value: Any) -> str:
    if isinstance(value, str):
        return json.dumps(value)
    return repr(value)


def _clean_doc(obj: Any) -> str:
    return inspect.cleandoc(obj.__doc__) if getattr(obj, "__doc__", None) else ""


def _source_link(obj: Any) -> dict[str, Any] | None:
    try:
        path = Path(inspect.getsourcefile(obj) or "").resolve()
        line = inspect.getsourcelines(obj)[1]
        rel = path.relative_to(ROOT).as_posix()
    except (TypeError, OSError, ValueError):
        return None
    return {"path": rel, "line": line, "url": f"{SOURCE_URL}/{rel}#L{line}"}


def _field_comments(cls: type) -> dict[str, str]:
    """Map field name -> the comment written beside or above it in the class body.

    The schema module documents fields with inline comments rather than
    ``Field(description=...)``, so the reference reads them from the source.
    """
    try:
        lines = inspect.getsource(cls).splitlines()
    except (OSError, TypeError):
        return {}
    out: dict[str, str] = {}
    pending: list[str] = []
    for raw in lines[1:]:
        stripped = raw.strip()
        if stripped.startswith("#"):
            text = stripped.lstrip("#").strip()
            if text and not set(text) <= set("-= "):
                pending.append(text)
            continue
        m = re.match(r"^(\w+)\s*:\s*[^#]*?(?:#\s*(.*))?$", stripped)
        if m and not stripped.startswith(("def ", "class ", '"""')):
            parts = list(pending)
            if m.group(2):
                parts.append(m.group(2).strip())
            if parts:
                out[m.group(1)] = " ".join(parts)
        if stripped:
            pending = []
    return out


def _signature(fn: Any) -> str:
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return "(...)"
    text = str(sig)
    return re.sub(r"\b(?:typing|numpy|pandas\.core\.frame|pandas\.core\.series|pandas)\.", "", text)


def _params(fn: Any) -> list[dict[str, Any]]:
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return []
    out = []
    for p in sig.parameters.values():
        ann = "" if p.annotation is inspect.Parameter.empty else _type_str(p.annotation)
        entry: dict[str, Any] = {"name": p.name, "type": ann, "required": p.default is inspect.Parameter.empty}
        if p.default is not inspect.Parameter.empty:
            entry["default"] = _default_str(p.default)
        out.append(entry)
    return out


# --------------------------------------------------------------------------- #
# sections
# --------------------------------------------------------------------------- #
def _model_entry(cls: type) -> dict[str, Any]:
    comments = _field_comments(cls)
    own = set(getattr(cls, "__annotations__", {}))
    fields = []
    for name, info in cls.model_fields.items():
        constraints = []
        for meta in info.metadata:
            for key in ("ge", "le", "gt", "lt", "min_length", "max_length"):
                val = getattr(meta, key, None)
                if val is not None:
                    constraints.append(f"{key}={val}")
        entry: dict[str, Any] = {
            "name": name,
            "type": _type_str(info.annotation),
            "required": info.is_required(),
            "description": comments.get(name, ""),
            "constraints": constraints,
            "inherited": name not in own,
        }
        if not info.is_required():
            default = info.default_factory() if info.default_factory is not None else info.default
            entry["default"] = _default_str(default)
        fields.append(entry)
    bases = [b.__name__ for b in cls.__mro__[1:] if b.__name__ not in ("BaseModel", "object")
             and hasattr(b, "model_fields")]
    return {"name": cls.__name__, "kind": "model", "doc": _clean_doc(cls) if cls.__doc__ and
            not cls.__doc__.startswith("Usage docs") and "A base class for creating Pydantic models" not in cls.__doc__
            else "", "bases": bases, "fields": fields, "source": _source_link(cls)}


def _dataclass_entry(cls: type) -> dict[str, Any]:
    comments = _field_comments(cls)
    hints = typing.get_type_hints(cls)
    fields = []
    for f in dataclasses.fields(cls):
        entry: dict[str, Any] = {
            "name": f.name,
            "type": _type_str(hints.get(f.name, f.type)),
            "required": f.default is dataclasses.MISSING and f.default_factory is dataclasses.MISSING,
            "description": comments.get(f.name, ""),
            "constraints": [],
            "inherited": False,
        }
        if f.default is not dataclasses.MISSING:
            entry["default"] = _default_str(f.default)
        elif f.default_factory is not dataclasses.MISSING:
            entry["default"] = _default_str(f.default_factory())
        fields.append(entry)
    methods = []
    for name, member in inspect.getmembers(cls):
        if name.startswith("_"):
            continue
        if isinstance(inspect.getattr_static(cls, name), property):
            methods.append({"name": name, "kind": "property", "doc": _clean_doc(member)})
        elif inspect.isfunction(member):
            methods.append({"name": name, "kind": "method", "signature": _signature(member),
                            "doc": _clean_doc(member)})
    return {"name": cls.__name__, "kind": "dataclass", "doc": _clean_doc(cls)
            if cls.__doc__ and not cls.__doc__.startswith(cls.__name__ + "(") else "",
            "fields": fields, "methods": methods, "source": _source_link(cls)}


def _function_entry(fn: Any, module: str, exported: bool) -> dict[str, Any]:
    ret = inspect.signature(fn).return_annotation
    return {
        "name": fn.__name__,
        "kind": "function",
        "module": f"{PACKAGE}.{module}",
        "exported": exported,
        "signature": _signature(fn),
        "params": _params(fn),
        "returns": "" if ret is inspect.Signature.empty else _type_str(ret),
        "doc": _clean_doc(fn),
        "source": _source_link(fn),
    }


def build_modules(exported: set) -> list[dict[str, Any]]:
    out = []
    for name, role in MODULES:
        mod = importlib.import_module(f"{PACKAGE}.{name}")
        hints = typing.get_type_hints(mod) if hasattr(mod, "__annotations__") else {}
        members = []
        constants = []
        for attr, value in vars(mod).items():
            if attr.startswith("_"):
                continue
            if inspect.isfunction(value) and value.__module__ == mod.__name__:
                with contextlib.suppress(Exception):
                    value.__annotations__ = typing.get_type_hints(value)
                members.append(_function_entry(value, name, attr in exported))
            elif inspect.isclass(value) and value.__module__ == mod.__name__ and dataclasses.is_dataclass(value):
                members.append(_dataclass_entry(value))
            elif attr.isupper() and isinstance(value, (list, dict, tuple, str, int, float)):
                constants.append({"name": attr, "type": _type_str(hints.get(attr, type(value))),
                                  "value": json.dumps(value, default=str)})
        members.sort(key=lambda m: (m.get("source") or {}).get("line", 0))
        out.append({"name": name, "import": f"{PACKAGE}.{name}", "role": role, "doc": _clean_doc(mod),
                    "members": members, "constants": constants,
                    "source": {"path": f"packages/{PACKAGE}/src/{PACKAGE}/{name}.py",
                               "url": f"{SOURCE_URL}/packages/{PACKAGE}/src/{PACKAGE}/{name}.py"}})
    return out


def build_schemas() -> dict[str, Any]:
    schemas = importlib.import_module(f"{PACKAGE}.schemas")
    grouped, seen = [], set()
    for title, names in SCHEMA_GROUPS:
        grouped.append({"title": title, "models": [_model_entry(getattr(schemas, n)) for n in names]})
        seen.update(names)
    from pydantic import BaseModel

    missing = sorted(n for n, v in vars(schemas).items() if inspect.isclass(v) and issubclass(v, BaseModel)
                     and v is not BaseModel and v.__module__ == schemas.__name__ and n not in seen)
    if missing:
        raise SystemExit(f"schemas not assigned to a reference group: {missing} (edit SCHEMA_GROUPS)")
    aliases = []
    for name in TYPE_ALIASES:
        tp = getattr(schemas, name)
        values = list(typing.get_args(tp)) if typing.get_origin(tp) is typing.Literal else []
        aliases.append({"name": name, "type": _type_str(tp), "values": values})
    return {"doc": _clean_doc(schemas), "groups": grouped, "aliases": aliases}


def build_cli() -> list[dict[str, str]]:
    """Capture the real ``--help`` text of the CLI and each subcommand."""
    cli = importlib.import_module(f"{PACKAGE}.cli")
    out = []
    for args in ([], ["profile"], ["run"]):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.suppress(SystemExit):
            cli.main([*args, "--help"])
        out.append({"command": " ".join(["propensity-lift", *args]), "help": buf.getvalue().strip()})
    return out


def build_http() -> list[dict[str, Any]]:
    """Route table from the FastAPI OpenAPI document (empty if the backend is not importable)."""
    backend = ROOT / "backend"
    if str(backend) not in sys.path:
        sys.path.insert(0, str(backend))
    try:
        from app.main import create_app  # type: ignore
    except Exception as exc:  # pragma: no cover - backend extras missing
        print(f"warning: HTTP API not introspected ({exc})", file=sys.stderr)
        return []
    spec = create_app().openapi()

    def ref_name(schema: dict | None) -> str:
        if not schema:
            return ""
        if "$ref" in schema:
            return schema["$ref"].rsplit("/", 1)[-1]
        if schema.get("type") == "array":
            return ref_name(schema.get("items")) + "[]"
        if "anyOf" in schema:
            return " | ".join(filter(None, (ref_name(s) for s in schema["anyOf"])))
        return schema.get("type", "")

    routes = []
    for path, ops in spec.get("paths", {}).items():
        for method, op in ops.items():
            if method not in ("get", "post", "put", "patch", "delete"):
                continue
            body = ""
            for ctype, media in (op.get("requestBody", {}).get("content", {}) or {}).items():
                body = ref_name(media.get("schema")) or ctype
                if ctype.startswith("multipart"):
                    body = "multipart file upload"
            responses = []
            for code, resp in sorted(op.get("responses", {}).items()):
                schema = next(iter((resp.get("content") or {}).values()), {}).get("schema")
                responses.append({"status": code, "description": resp.get("description", ""),
                                  "schema": ref_name(schema)})
            routes.append({
                "method": method.upper(), "path": path,
                "summary": op.get("summary", ""), "description": inspect.cleandoc(op.get("description", "") or ""),
                "params": [{"name": p["name"], "in": p["in"], "required": p.get("required", False),
                            "type": ref_name(p.get("schema"))} for p in op.get("parameters", [])],
                "body": body, "responses": responses,
            })
    return routes


def build_api() -> dict[str, Any]:
    pkg = importlib.import_module(PACKAGE)
    exported = set(pkg.__all__)
    return {
        "package": PACKAGE,
        "distribution": "propensity-lift",
        "version": pkg.__version__,
        "exports": sorted(n for n in pkg.__all__ if not n.startswith("__")),
        "modules": build_modules(exported),
        "schemas": build_schemas(),
        "cli": build_cli(),
        "http": build_http(),
    }


# --------------------------------------------------------------------------- #
# walkthrough
# --------------------------------------------------------------------------- #
def _round(obj: Any, nd: int = 5) -> Any:
    if isinstance(obj, float):
        return round(obj, nd)
    if isinstance(obj, dict):
        return {k: _round(v, nd) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_round(v, nd) for v in obj]
    return obj


def build_walkthrough() -> dict[str, Any]:
    from propensity_lift import make_brand_lift_sample, profile_dataframe, run_analysis
    from propensity_lift.sample_data import TRUE_EFFECTS, sample_analysis_config

    df = make_brand_lift_sample(n=3000, seed=0)
    profile = profile_dataframe(df, dataset_id="sample", filename="brand_lift_sample.xlsx")
    cfg = sample_analysis_config(methods=["nn_matching", "ipw", "overlap_weights", "stratification", "aipw"])
    stages: list[list[Any]] = []
    result = run_analysis(df, cfg, analysis_id="walkthrough",
                          progress=lambda frac, stage: stages.append([round(frac, 3), stage]))
    data = json.loads(result.model_dump_json())
    data.pop("created_at", None)
    data.pop("duration_seconds", None)
    # Per-level tables and per-feature histograms are large and not plotted on the page.
    slim_features = []
    for f in data["feature_overlap"]:
        slim_features.append({k: f[k] for k in ("feature", "role", "kind", "overlap_coefficient",
                                                "pct_exposed_unsupported", "pct_control_unsupported",
                                                "exposed_only_levels", "control_only_levels")})
    data["feature_overlap"] = slim_features
    dedup_stages: list[list[Any]] = []
    for frac, stage in stages:
        stage = re.sub(r"\s*\(\d+/\d+\)$", "", stage)  # collapse "bootstrapping (10/200)" ticks
        if not dedup_stages or dedup_stages[-1][1] != stage:
            dedup_stages.append([frac, stage])
    return _round({
        "generated_by": "scripts/build_site_data.py",
        "n_rows": len(df),
        "n_cols": int(df.shape[1]),
        "head": json.loads(df.head(6).to_json(orient="records")),
        "profile": [{"name": c.name, "kind": c.kind, "n_missing": c.n_missing, "n_unique": c.n_unique,
                     "suggested_role": c.suggested_role} for c in profile.columns],
        "true_effects": TRUE_EFFECTS,
        "stages": dedup_stages,
        "result": data,
    })


# --------------------------------------------------------------------------- #
# entry point
# --------------------------------------------------------------------------- #
def _dump(obj: Any) -> str:
    return json.dumps(obj, indent=1, sort_keys=False, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--api-only", action="store_true", help="skip the sample analysis run")
    parser.add_argument("--check", action="store_true", help="exit 1 if the committed api.json is out of date")
    args = parser.parse_args(argv)

    api_text = _dump(build_api())
    api_path = OUT_DIR / "api.json"
    if args.check:
        current = api_path.read_text(encoding="utf-8") if api_path.exists() else ""
        if current != api_text:
            print("site/assets/data/api.json is out of date; run: uv run python scripts/build_site_data.py",
                  file=sys.stderr)
            return 1
        print("api.json is up to date")
        return 0

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    api_path.write_text(api_text, encoding="utf-8")
    print(f"wrote {api_path.relative_to(ROOT)}")
    if not args.api_only:
        walk_path = OUT_DIR / "walkthrough.json"
        walk_path.write_text(_dump(build_walkthrough()), encoding="utf-8")
        print(f"wrote {walk_path.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
