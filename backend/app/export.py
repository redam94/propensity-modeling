"""Excel export of an :class:`AnalysisResult` (runs in a thread; pure function of the result)."""

from __future__ import annotations

import io
import json
from typing import Any, Dict, List

import pandas as pd
from propensity_lift.schemas import (
    AnalysisResult,
    BalanceRow,
    Histogram,
    OutcomeContrast,
)

CONTRAST_FIELDS = list(OutcomeContrast.model_fields)


def _hist_frame(h: Histogram) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "bin_lower": h.edges[:-1],
            "bin_upper": h.edges[1:],
            "exposed_count": h.exposed_counts,
            "control_count": h.control_counts,
            "exposed_density": h.exposed_density,
            "control_density": h.control_density,
        }
    )


def _frame(rows: List[Dict[str, Any]], columns: List[str]) -> pd.DataFrame:
    return pd.DataFrame(rows, columns=columns) if rows else pd.DataFrame(columns=columns)


def _cell(v: Any) -> Any:
    if isinstance(v, (list, dict)):
        return json.dumps(v, default=str)
    return v


def build_workbook(result: AnalysisResult) -> bytes:
    cfg = result.config
    s = result.sample
    o = result.overlap

    # ---------------------------------------------------------------- Summary
    summary: List[tuple] = [
        ("Analysis ID", result.analysis_id),
        ("Name", cfg.name or ""),
        ("Dataset ID", cfg.dataset_id),
        ("Sheet", cfg.sheet or ""),
        ("Created at (UTC)", result.created_at.isoformat()),
        ("Duration (s)", round(result.duration_seconds, 3)),
        ("Rows in input", s.n_rows_input),
        ("Exposed", s.n_exposed),
        ("Control", s.n_control),
        ("Dropped: treatment missing / other", s.n_dropped_treatment_missing),
        ("Dropped: feature missing", s.n_dropped_feature_missing),
        ("Analysed exposed (after trim)", s.n_analysed_exposed),
        ("Analysed control (after trim)", s.n_analysed_control),
        ("PS model", result.model.model_type),
        ("PS model AUC", result.model.auc),
        ("Encoded features", result.model.n_encoded_features),
        ("PS overlap coefficient (OVL)", o.overlap_coefficient),
        ("Common support lower", o.common_support_lower),
        ("Common support upper", o.common_support_upper),
        ("Trim rule", cfg.trim),
        ("Trimmed exposed", o.n_trimmed_exposed),
        ("Trimmed control", o.n_trimmed_control),
        ("Estimand", cfg.estimand),
    ]
    for m in result.methods:
        b = m.balance_summary
        summary += [
            (f"[{m.method}] label", m.label),
            (f"[{m.method}] exposed / control used", f"{m.n_exposed_used} / {m.n_control_used}"),
            (f"[{m.method}] max |SMD| before -> after", f"{b.max_abs_smd_before:.3f} -> {b.max_abs_smd_after:.3f}"),
            (f"[{m.method}] imbalanced vars before -> after", f"{b.n_imbalanced_before} -> {b.n_imbalanced_after}"),
        ]
        for w in m.warnings:
            summary.append((f"[{m.method}] warning", w))
    for w in result.warnings:
        summary.append(("Warning", w))
    summary_df = pd.DataFrame(summary, columns=["Item", "Value"])

    # -------------------------------------------------------------- Contrasts
    contrast_rows, subgroup_rows, balance_rows = [], [], []
    for m in result.methods:
        for c in m.contrasts:
            contrast_rows.append({"method": m.method, "method_label": m.label, **c.model_dump()})
        for g in m.subgroups:
            d = g.model_dump()
            subgroup_rows.append(
                {
                    "method": m.method,
                    "subgroup_column": d.pop("subgroup_column"),
                    "subgroup_level": d.pop("subgroup_level"),
                    **d,
                }
            )
        for r in m.balance:
            balance_rows.append({"method": m.method, **r.model_dump()})
    contrasts_df = _frame(contrast_rows, ["method", "method_label"] + CONTRAST_FIELDS)
    subgroups_df = _frame(subgroup_rows, ["method", "subgroup_column", "subgroup_level"] + CONTRAST_FIELDS)
    balance_df = _frame(balance_rows, ["method"] + list(BalanceRow.model_fields))

    # ---------------------------------------------------------------- Overlap
    regions_df = pd.DataFrame([r.model_dump() for r in o.regions])
    hist_df = _hist_frame(o.histogram)
    quant_df = pd.DataFrame(
        [{"group": "exposed", **o.exposed_quantiles.model_dump()}, {"group": "control", **o.control_quantiles.model_dump()}]
    )

    # --------------------------------------------------------- FeatureOverlap
    fo_rows = []
    for f in result.feature_overlap:
        fo_rows.append(
            {
                "feature": f.feature,
                "role": f.role,
                "kind": f.kind,
                "overlap_coefficient": f.overlap_coefficient,
                "pct_exposed_unsupported": f.pct_exposed_unsupported,
                "pct_control_unsupported": f.pct_control_unsupported,
                "exposed_only_levels": ", ".join(f.exposed_only_levels),
                "control_only_levels": ", ".join(f.control_only_levels),
                "exposed_min": f.exposed_range[0] if f.exposed_range else None,
                "exposed_max": f.exposed_range[1] if f.exposed_range else None,
                "control_min": f.control_range[0] if f.control_range else None,
                "control_max": f.control_range[1] if f.control_range else None,
            }
        )
    fo_df = _frame(
        fo_rows,
        [
            "feature", "role", "kind", "overlap_coefficient", "pct_exposed_unsupported",
            "pct_control_unsupported", "exposed_only_levels", "control_only_levels",
            "exposed_min", "exposed_max", "control_min", "control_max",
        ],
    )
    level_rows = [
        {"feature": f.feature, **lv.model_dump()} for f in result.feature_overlap for lv in f.levels
    ]
    levels_df = _frame(level_rows, ["feature", "level", "n_exposed", "n_control", "pct_exposed", "pct_control"])

    # ------------------------------------------------------------------ Model
    imp_df = _frame(
        [fi.model_dump() for fi in result.model.feature_importance], ["feature", "importance"]
    )
    calib_df = pd.DataFrame(result.model.calibration, columns=["mean_predicted", "observed_rate", "n"]) if (
        result.model.calibration
    ) else pd.DataFrame(columns=["mean_predicted", "observed_rate", "n"])

    # ----------------------------------------------------------------- Config
    config_df = pd.DataFrame(
        [(k, _cell(v)) for k, v in cfg.model_dump(mode="json").items()], columns=["Setting", "Value"]
    )

    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as xw:
        summary_df.to_excel(xw, sheet_name="Summary", index=False)
        contrasts_df.to_excel(xw, sheet_name="Contrasts", index=False)
        balance_df.to_excel(xw, sheet_name="Balance", index=False)

        row = 0
        pd.DataFrame([["Propensity-score support regions"]]).to_excel(
            xw, sheet_name="Overlap", index=False, header=False, startrow=row
        )
        regions_df.to_excel(xw, sheet_name="Overlap", index=False, startrow=row + 1)
        row += len(regions_df) + 3
        pd.DataFrame([["Propensity-score quantiles"]]).to_excel(
            xw, sheet_name="Overlap", index=False, header=False, startrow=row
        )
        quant_df.to_excel(xw, sheet_name="Overlap", index=False, startrow=row + 1)
        row += len(quant_df) + 3
        pd.DataFrame([["Propensity-score histogram (shared bins)"]]).to_excel(
            xw, sheet_name="Overlap", index=False, header=False, startrow=row
        )
        hist_df.to_excel(xw, sheet_name="Overlap", index=False, startrow=row + 1)

        fo_df.to_excel(xw, sheet_name="FeatureOverlap", index=False)
        if not levels_df.empty:
            levels_df.to_excel(xw, sheet_name="FeatureOverlap", index=False, startrow=len(fo_df) + 3)

        subgroups_df.to_excel(xw, sheet_name="Subgroups", index=False)

        imp_df.to_excel(xw, sheet_name="Model", index=False)
        calib_df.to_excel(xw, sheet_name="Model", index=False, startcol=3)

        config_df.to_excel(xw, sheet_name="Config", index=False)

        for ws in xw.book.worksheets:
            for col in ws.columns:
                width = max((len(str(c.value)) for c in col[:200] if c.value is not None), default=8)
                ws.column_dimensions[col[0].column_letter].width = min(max(10, width + 2), 60)
    return buf.getvalue()
