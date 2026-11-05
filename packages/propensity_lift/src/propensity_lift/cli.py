"""Command line interface: ``propensity-lift profile|run``."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import List, Optional

from .io import list_sheets, load_table, profile_dataframe
from .pipeline import run_analysis
from .schemas import AnalysisConfig


def _progress(frac: float, stage: str) -> None:
    print(f"[{frac * 100:5.1f}%] {stage}", file=sys.stderr)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="propensity-lift", description="Propensity score brand lift analysis")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("profile", help="profile a data file and print DatasetProfile JSON")
    p.add_argument("file")
    p.add_argument("--sheet", default=None)

    r = sub.add_parser("run", help="run an analysis from an AnalysisConfig JSON file")
    r.add_argument("file")
    r.add_argument("--config", required=True, help="AnalysisConfig JSON (dataset_id may be any string)")
    r.add_argument("--sheet", default=None, help="overrides config.sheet")
    r.add_argument("--out", default=None, help="write AnalysisResult JSON here (default: stdout)")
    r.add_argument("--quiet", action="store_true", help="no progress output")

    args = parser.parse_args(argv)
    path = Path(args.file)
    try:
        if args.command == "profile":
            sheets = list_sheets(path)
            df = load_table(path, args.sheet)
            sheet = args.sheet or (sheets[0] if sheets else None)
            prof = profile_dataframe(df, path.stem, path.name, sheets, sheet)
            print(prof.model_dump_json(indent=2))
            return 0
        cfg_data = json.loads(Path(args.config).read_text())
        cfg_data.setdefault("dataset_id", path.stem)
        cfg = AnalysisConfig.model_validate(cfg_data)
        sheet = args.sheet or cfg.sheet
        df = load_table(path, sheet)
        result = run_analysis(df, cfg, progress=None if args.quiet else _progress)
        text = result.model_dump_json(indent=2)
        if args.out:
            Path(args.out).write_text(text)
            print(f"wrote {args.out} ({result.duration_seconds:.1f}s)", file=sys.stderr)
        else:
            print(text)
        return 0
    except (ValueError, FileNotFoundError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
