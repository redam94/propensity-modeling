"""Write sample_data/brand_lift_sample.xlsx (sheets "Respondents" and "Notes").

Usage:  uv run python scripts/make_sample_excel.py [--n 3000] [--seed 0] [--out PATH]
"""

from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd

from propensity_lift.sample_data import (
    SAMPLE_MATCHING_FEATURES,
    SAMPLE_MODEL_FEATURES,
    SAMPLE_TOP2_BOX,
    TRUE_EFFECTS,
    make_brand_lift_sample,
)

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=3000)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", default=str(ROOT / "sample_data" / "brand_lift_sample.xlsx"))
    args = ap.parse_args()

    df = make_brand_lift_sample(args.n, args.seed)
    notes = pd.DataFrame(
        [
            ("Description", "Synthetic brand-lift survey, one row per respondent."),
            ("Rows", str(len(df))),
            ("Treatment column", "group  (Exposed / Control)"),
            ("Outcomes", ", ".join(TRUE_EFFECTS)),
            ("True effects (latent scale)", "; ".join(f"{k}={v}" for k, v in TRUE_EFFECTS.items())),
            ("Null outcome", "unaided_awareness has NO true exposure effect"),
            ("Top-2-box recode", f"purchase_intent positive = {SAMPLE_TOP2_BOX['purchase_intent']}"),
            ("Matching features", ", ".join(SAMPLE_MATCHING_FEATURES)),
            ("Suggested model features", ", ".join(SAMPLE_MODEL_FEATURES)),
            ("Confounding", "Exposure depends on age, gender, region, income, media usage, prior brand usage, "
                            "device and ad blocking, which also drive the KPIs: raw lift overstates true lift."),
            ("Generator", f"propensity_lift.sample_data.make_brand_lift_sample(n={args.n}, seed={args.seed})"),
        ],
        columns=["Item", "Value"],
    )
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with pd.ExcelWriter(out, engine="openpyxl") as xw:
        df.to_excel(xw, sheet_name="Respondents", index=False)
        notes.to_excel(xw, sheet_name="Notes", index=False)
    print(f"wrote {out} ({len(df)} rows x {df.shape[1]} columns)")


if __name__ == "__main__":
    main()
