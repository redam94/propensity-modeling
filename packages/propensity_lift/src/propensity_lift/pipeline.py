"""End-to-end analysis orchestration: run_analysis(df, config) -> AnalysisResult."""

from __future__ import annotations

import math
import re
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

from ._utils import finite
from .diagnostics import balance_table
from .io import infer_kind
from .lift import analytic_se, bootstrap_se, contrast_fields, group_sums, lift_only, outcome_matrix
from .matching import MatchResult, nn_match
from .models import fit_propensity, logit
from .overlap import adjusted_ps_histogram, feature_overlap, ps_overlap_summary, trim_mask
from .preprocess import (
    OutcomeData,
    categorical_labels,
    code_treatment,
    encode_features,
    feature_missing_mask,
    feature_numeric,
    matching_strata,
    recode_outcome,
)
from .schemas import (
    AnalysisConfig,
    AnalysisResult,
    MatchingInfo,
    Method,
    MethodResult,
    OutcomeContrast,
    SampleSummary,
    SubgroupContrast,
    WeightSummary,
)
from .weighting import (
    clip_weights,
    ipw_weights,
    kish_ess,
    normalize_within_group,
    overlap_weights,
    stratification_weights,
)

ProgressFn = Callable[[float, str], None]

MIN_SUBGROUP_N = 10
MAX_SUBGROUP_LEVELS = 30


def _unique(seq: Sequence[str]) -> List[str]:
    seen, out = set(), []
    for s in seq:
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out


def _validate(df: pd.DataFrame, cfg: AnalysisConfig) -> None:
    cols = set(df.columns)
    needed = (
        [cfg.treatment_column] + list(cfg.outcome_columns) + list(cfg.model_features)
        + list(cfg.matching_features) + list(cfg.subgroup_columns)
    )
    missing = [c for c in _unique(needed) if c not in cols]
    if missing:
        raise ValueError(f"Columns not found in data: {missing}")
    if cfg.treatment_column in cfg.outcome_columns:
        raise ValueError("The treatment column cannot also be an outcome")
    if not cfg.exposed_values:
        raise ValueError("exposed_values must not be empty")


# --------------------------------------------------------------------------- #
# adjustment step (shared by point estimate and bootstrap replicates)
# --------------------------------------------------------------------------- #
@dataclass
class AdjustInfo:
    n_clipped: int = 0
    match: Optional[MatchResult] = None
    n_empty_strata: int = 0
    w_unclipped: Optional[np.ndarray] = None   # IPW only, when weight_clip changed any weight


def _adjust(
    method: str,
    ps: np.ndarray,
    lg: np.ndarray,
    t: np.ndarray,
    strata: Optional[np.ndarray],
    cfg: AnalysisConfig,
    caliper_abs: Optional[float],
) -> Tuple[np.ndarray, AdjustInfo]:
    info = AdjustInfo()
    if method == "nn_matching":
        mr = nn_match(lg, t, caliper_abs, cfg.match_ratio, cfg.replacement, strata, cfg.estimand)
        info.match = mr
        return mr.weights, info
    if method == "ipw":
        w_raw = ipw_weights(ps, t, cfg.estimand)
        w, info.n_clipped = clip_weights(w_raw, t, cfg.weight_clip)
        if info.n_clipped:
            info.w_unclipped = w_raw
        return w, info
    if method == "overlap_weights":
        return overlap_weights(ps, t), info
    if method == "stratification":
        w, info.n_empty_strata = stratification_weights(ps, t, cfg.n_strata, cfg.estimand)
        return w, info
    raise ValueError(f"Unknown method {method}")


def _label(method: str, cfg: AnalysisConfig) -> str:
    if method == "nn_matching":
        cal = f"caliper {cfg.caliper:g} SD" if cfg.caliper is not None else "no caliper"
        rep = "with" if cfg.replacement else "without"
        s = f"{cfg.match_ratio}:1 NN matching ({rep} replacement, {cal}"
        if cfg.matching_features:
            s += ", exact on " + ", ".join(cfg.matching_features)
        return s + ")"
    if method == "ipw":
        clip = f", clipped at p{cfg.weight_clip * 100:g}" if cfg.weight_clip else ""
        return f"IPW ({cfg.estimand}{clip})"
    if method == "overlap_weights":
        return "Overlap weights (ATO)"
    return f"PS stratification ({cfg.n_strata} strata, {cfg.estimand})"


# --------------------------------------------------------------------------- #
# subgroup design matrix
# --------------------------------------------------------------------------- #
def _subgroup_labels(s: pd.Series) -> np.ndarray:
    x = feature_numeric(s)
    if x is not None and np.unique(x[np.isfinite(x)]).size > 10:
        q = pd.qcut(pd.Series(x), 5, duplicates="drop")
        lab = q.astype(str).to_numpy(dtype=object)
        return np.where(np.isfinite(x), lab, "(missing)")
    return categorical_labels(s)


def _natural_key(level: Any) -> Tuple[Any, ...]:
    """Sort levels like a human: '18-24' < '25-34' < '55+', '(9.5, 20]' < '(20, 31]', '(missing)' last."""
    text = str(level)
    # a '-' counts as a sign only when not preceded by a digit ('18-24' is a range, '(-0.3, 0.2]' negative)
    parts = re.split(r"((?<![\d.])-?\d+(?:\.\d+)?)", text)
    key = tuple((0, float(p), "") if i % 2 else (1, 0.0, p.lower()) for i, p in enumerate(parts) if p != "")
    return (text in ("(missing)", "__other__"),) + key


def _design(
    d: pd.DataFrame, t: np.ndarray, analysed: np.ndarray, subgroup_cols: Sequence[str], warn: List[str]
) -> Tuple[np.ndarray, List[Tuple[str, str]]]:
    n = len(d)
    cols = [np.ones(n)]
    groups: List[Tuple[str, str]] = [("", "")]
    for col in subgroup_cols:
        labels = _subgroup_labels(d[col])
        vc = pd.Series(labels[analysed]).value_counts()
        if len(vc) > MAX_SUBGROUP_LEVELS:
            warn.append(f"Subgroup '{col}': only the {MAX_SUBGROUP_LEVELS} most frequent of {len(vc)} levels analysed")
        for lv in sorted(list(vc.index)[:MAX_SUBGROUP_LEVELS], key=_natural_key):
            m = labels == lv
            ne = int((m & analysed & (t == 1)).sum())
            nc = int((m & analysed & (t == 0)).sum())
            if ne < MIN_SUBGROUP_N or nc < MIN_SUBGROUP_N:
                warn.append(
                    f"Subgroup {col}={lv} skipped ({ne} exposed, {nc} control; need >= {MIN_SUBGROUP_N} each)"
                )
                continue
            cols.append(m.astype(float))
            groups.append((col, str(lv)))
    return np.column_stack(cols), groups


# --------------------------------------------------------------------------- #
# JSON safety net
# --------------------------------------------------------------------------- #
def _sanitize(obj: Any, path: str, bad: List[str]) -> Any:
    if isinstance(obj, float):
        if not math.isfinite(obj):
            bad.append(path)
            return 0.0
        return obj
    if isinstance(obj, dict):
        return {k: _sanitize(v, f"{path}.{k}", bad) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize(v, f"{path}[{i}]", bad) for i, v in enumerate(obj)]
    return obj


# --------------------------------------------------------------------------- #
# main entry point
# --------------------------------------------------------------------------- #
@dataclass
class _Ctx:
    cfg: AnalysisConfig
    t: np.ndarray
    ps: np.ndarray
    lg: np.ndarray
    analysed: np.ndarray
    strata: Optional[np.ndarray]
    n_strata: int
    caliper_abs: Optional[float]
    D: np.ndarray
    groups: List[Tuple[str, str]]
    Y: np.ndarray
    M: np.ndarray
    X_model: np.ndarray            # PS model design matrix (bootstrap refits)
    outcomes: List[OutcomeData]
    raw_e: Any
    raw_c: Any
    X_bal: np.ndarray
    bal_names: List[str]
    bal_sources: List[str]
    bal_dummy: List[bool]
    roles: Dict[str, str]
    ps_edges: np.ndarray
    warnings: List[str] = field(default_factory=list)


def run_analysis(
    df: pd.DataFrame,
    config: AnalysisConfig,
    analysis_id: Optional[str] = None,
    progress: Optional[ProgressFn] = None,
) -> AnalysisResult:
    """Run a full propensity / brand-lift analysis.

    ``progress(fraction, stage)`` is called at each stage (fraction in [0, 1]).
    """
    t_start = time.perf_counter()
    cfg = config
    analysis_id = analysis_id or uuid.uuid4().hex[:12]

    def report(frac: float, stage: str) -> None:
        if progress is not None:
            progress(float(min(max(frac, 0.0), 1.0)), stage)

    warnings: List[str] = []
    report(0.0, "validating configuration")
    _validate(df, cfg)

    # ---- treatment ------------------------------------------------------- #
    report(0.03, "coding treatment")
    n_input = int(len(df))
    t_all = code_treatment(df[cfg.treatment_column], cfg.exposed_values, cfg.control_values)
    keep = t_all >= 0
    n_drop_treat = int((~keep).sum())
    if not cfg.control_values:
        ctl_levels = sorted({str(v).strip() for v in df[cfg.treatment_column][t_all == 0].dropna().unique()})
        if len(ctl_levels) > 1:
            shown = ", ".join(repr(v) for v in ctl_levels[:10]) + (" ..." if len(ctl_levels) > 10 else "")
            warnings.append(
                f"control_values not set: {len(ctl_levels)} different treatment values were pooled into the "
                f"control group ({shown}); set control_values to exclude codes such as 'Unknown' or 99"
            )
    if n_drop_treat:
        warnings.append(
            f"{n_drop_treat} rows dropped: treatment value missing or in neither the exposed nor control values"
        )

    excluded = {cfg.treatment_column, *cfg.outcome_columns}
    model_feats = _unique(
        list(cfg.model_features) + (list(cfg.matching_features) if cfg.include_matching_in_model else [])
    )
    for f in [f for f in model_feats if f in excluded]:
        warnings.append(f"'{f}' is the treatment or an outcome and was removed from the model features")
    model_feats = [f for f in model_feats if f not in excluded]
    match_feats = [f for f in _unique(cfg.matching_features) if f not in excluded]
    balance_feats = _unique(model_feats + match_feats)
    roles: Dict[str, str] = {}
    for f in balance_feats:
        in_m, in_x = f in set(cfg.model_features), f in set(match_feats)
        roles[f] = "both" if (in_m and in_x) else ("matching" if in_x else "model")

    n_drop_feat = 0
    if cfg.missing_strategy == "drop" and balance_feats:
        miss = feature_missing_mask(df, balance_feats)
        n_drop_feat = int((keep & miss).sum())
        keep = keep & ~miss
        if n_drop_feat:
            warnings.append(f"{n_drop_feat} rows dropped for missing feature values (missing_strategy='drop')")

    d = df.loc[keep].reset_index(drop=True)
    t = t_all[keep].astype(np.int64)
    n_e, n_c = int((t == 1).sum()), int((t == 0).sum())
    if n_e < 2 or n_c < 2:
        raise ValueError(f"Need at least 2 exposed and 2 control respondents (got {n_e} exposed, {n_c} control)")

    # ---- outcomes -------------------------------------------------------- #
    outcomes: List[OutcomeData] = []
    for o in _unique(cfg.outcome_columns):
        od = recode_outcome(d[o], o, cfg.outcome_positive_values.get(o))
        if od.note:
            warnings.append(od.note)
        outcomes.append(od)

    # ---- features & PS model -------------------------------------------- #
    report(0.08, "encoding features")
    if not model_feats:
        raise ValueError("No propensity model features: select model features (or matching features with "
                         "include_matching_in_model=true)")
    enc = encode_features(d, balance_feats)
    warnings.extend(enc.warnings)
    model_enc = enc.subset(model_feats)
    if model_enc.X.shape[1] == 0:
        raise ValueError("None of the selected model features has usable (non-constant) values")

    report(0.12, "fitting propensity model")
    ps, model_summary = fit_propensity(model_enc.X, t, cfg.model_type, cfg.random_state, model_enc.sources)
    lg = logit(ps)
    if model_summary.auc > 0.9:
        warnings.append(
            f"Propensity model AUC is {model_summary.auc:.2f}: groups are highly separable, "
            "expect poor overlap and unstable estimates"
        )

    # ---- overlap --------------------------------------------------------- #
    report(0.25, "computing overlap")
    overlap = ps_overlap_summary(ps, t, cfg.trim)
    analysed = trim_mask(ps, t, cfg.trim)
    na_e, na_c = int((analysed & (t == 1)).sum()), int((analysed & (t == 0)).sum())
    if na_e < 2 or na_c < 2:
        raise ValueError(f"Trimming rule '{cfg.trim}' leaves too few respondents ({na_e} exposed, {na_c} control)")
    if cfg.trim != "none":
        warnings.append(
            f"Trim rule '{cfg.trim}' removed {overlap.n_trimmed_exposed} exposed and "
            f"{overlap.n_trimmed_control} control respondents"
        )
    exp_only = next(r for r in overlap.regions if r.region == "exposed_only")
    if exp_only.pct_exposed > 5:
        warnings.append(
            f"{exp_only.pct_exposed:.1f}% of exposed respondents have propensity scores above every control "
            "(exposed-only region); consider trimming"
        )

    report(0.3, "feature over/underlap")
    feat_overlap = []
    for f in balance_feats:
        kind, _ = infer_kind(d[f])
        feat_overlap.append(feature_overlap(d[f], t, f, roles[f], kind))

    strata, n_strata = matching_strata(d, match_feats)
    D, groups = _design(d, t, analysed, cfg.subgroup_columns, warnings)
    Y, M = outcome_matrix([o.y for o in outcomes])
    te = (t == 1).astype(float)
    raw_e = group_sums(te, D, Y, M)
    raw_c = group_sums(1 - te, D, Y, M)

    caliper_abs = None
    if cfg.caliper is not None:
        sd = float(np.std(lg[analysed]))
        caliper_abs = float(cfg.caliper * sd) if sd > 0 else None

    ctx = _Ctx(
        cfg=cfg, t=t, ps=ps, lg=lg, analysed=analysed,
        strata=strata if match_feats else None, n_strata=n_strata, caliper_abs=caliper_abs,
        D=D, groups=groups, Y=Y, M=M, X_model=model_enc.X, outcomes=outcomes, raw_e=raw_e, raw_c=raw_c,
        X_bal=enc.X, bal_names=enc.names, bal_sources=enc.sources, bal_dummy=enc.is_dummy,
        roles=roles, ps_edges=np.asarray(overlap.histogram.edges),
    )

    methods_out: List[MethodResult] = []
    methods = _unique(cfg.methods)
    span = 0.65 / max(len(methods), 1)
    for i, m in enumerate(methods):
        lo = 0.33 + i * span
        methods_out.append(_run_method(m, ctx, lambda f, s, lo=lo: report(lo + f * span, s)))

    report(0.98, "assembling results")
    sample = SampleSummary(
        n_rows_input=n_input, n_exposed=n_e, n_control=n_c,
        n_dropped_treatment_missing=n_drop_treat, n_dropped_feature_missing=n_drop_feat,
        n_analysed_exposed=na_e, n_analysed_control=na_c,
    )
    result = AnalysisResult(
        analysis_id=analysis_id, config=cfg, created_at=datetime.now(timezone.utc),
        duration_seconds=0.0, sample=sample, model=model_summary, overlap=overlap,
        feature_overlap=feat_overlap, methods=methods_out, warnings=_unique(warnings),
    )
    bad: List[str] = []
    data = _sanitize(result.model_dump(mode="python"), "result", bad)
    if bad:
        data["warnings"].append(f"{len(bad)} non-finite values replaced by 0 (e.g. {bad[0]})")
    data["duration_seconds"] = round(time.perf_counter() - t_start, 4)
    result = AnalysisResult.model_validate(data)
    report(1.0, "done")
    return result


def _run_method(method: Method, ctx: _Ctx, report: ProgressFn) -> MethodResult:
    cfg = ctx.cfg
    t, n = ctx.t, len(ctx.t)
    warn: List[str] = []
    idx = np.flatnonzero(ctx.analysed)
    st = ctx.strata[idx] if ctx.strata is not None else None
    report(0.0, f"{method}: adjusting")

    w_sub, info = _adjust(method, ctx.ps[idx], ctx.lg[idx], t[idx], st, cfg, ctx.caliper_abs)
    w = np.zeros(n)
    w[idx] = normalize_within_group(w_sub, t[idx])
    te = (t == 1).astype(float)

    # ---- warnings / info ------------------------------------------------- #
    matching = None
    if method == "nn_matching" and info.match is not None:
        mr = info.match
        matching = MatchingInfo(
            n_exposed_matched=mr.n_exposed_matched,
            n_exposed_unmatched=mr.n_exposed_unmatched,
            n_unique_controls_used=mr.n_unique_controls_used,
            caliper_abs=ctx.caliper_abs,
            n_exact_strata=ctx.n_strata if ctx.strata is not None else 0,
        )
        if mr.n_exposed_matched == 0:
            warn.append("No exposed respondent could be matched (caliper / exact strata too strict)")
        elif mr.n_exposed_unmatched:
            pct = 100 * mr.n_exposed_unmatched / max(mr.n_exposed_matched + mr.n_exposed_unmatched, 1)
            warn.append(
                f"{mr.n_exposed_unmatched} exposed ({pct:.1f}%) had no control within the caliper/exact strata "
                f"and were excluded; the estimate refers to matched exposed respondents"
            )
        if cfg.estimand == "ATE":
            n_ctrl = int((t[idx] == 0).sum())
            if mr.n_control_matched < n_ctrl:
                warn.append(f"{n_ctrl - mr.n_control_matched} controls had no exposed match (ATE direction)")
    if method == "overlap_weights":
        warn.append("Overlap weights target the ATO (population with the most overlap), not the "
                    f"configured {cfg.estimand}")
    if method == "stratification" and info.n_empty_strata:
        warn.append(f"{info.n_empty_strata} PS strata lacked exposed or control respondents; their units "
                    "received weight 0")
    if info.n_clipped:
        warn.append(f"{info.n_clipped} weights clipped at the {cfg.weight_clip} quantile")

    wa, ta = w[idx], t[idx]
    ess_e, ess_c = kish_ess(wa[ta == 1]), kish_ess(wa[ta == 0])
    n_c_used = int(((wa > 0) & (ta == 0)).sum())
    if method == "nn_matching" and info.match is not None:
        mr = info.match
        if mr.n_exposed_matched and (
            (n_c_used and ess_c < 0.2 * n_c_used)
            or mr.n_unique_controls_used < max(2.0, 0.1 * mr.n_exposed_matched)
        ):
            warn.append(
                f"Only {mr.n_unique_controls_used} distinct controls used for {mr.n_exposed_matched} matched "
                f"exposed; control ESS {ess_c:.1f}: the estimate rests on very few controls "
                "(consider a larger match_ratio, IPW or overlap weights)"
            )
    elif n_c_used and ess_c < 0.2 * n_c_used:
        warn.append(f"Low control effective sample size ({ess_c:.0f} of {n_c_used}): extreme weights")
    pos = wa[wa > 0]
    weights = WeightSummary(
        min=finite(pos.min()) if pos.size else 0.0,
        max=finite(pos.max()) if pos.size else 0.0,
        mean=finite(pos.mean()) if pos.size else 0.0,
        n_clipped=int(info.n_clipped),
        ess_exposed=finite(ess_e),
        ess_control=finite(ess_c),
    )

    # ---- balance --------------------------------------------------------- #
    report(0.05, f"{method}: balance")
    balance, bsum = balance_table(
        ctx.X_bal, t, w, ctx.bal_names, ctx.bal_sources, ctx.bal_dummy, ctx.roles
    )

    # ---- point estimates ------------------------------------------------- #
    e = group_sums(w * te, ctx.D, ctx.Y, ctx.M)
    c = group_sums(w * (1 - te), ctx.D, ctx.Y, ctx.M)
    se_an = analytic_se(e, c)

    # ---- bootstrap ------------------------------------------------------- #
    # Weighting methods: the PS model is refitted in every replicate (logistic only -- cheap),
    # so the SE reflects PS estimation; holding the PS fixed makes IPW / overlap SEs roughly
    # 2x too large. Replicates resample the pre-trim sample and re-apply the trim rule, as the
    # point estimate does. NN matching keeps the PS fixed and re-matches each replicate: the
    # naive bootstrap is only approximate for matching (Abadie & Imbens 2008), but simulations
    # show it is well calibrated for matching with replacement here.
    B = int(cfg.n_bootstrap)
    se_bs = None
    refit = method != "nn_matching" and cfg.model_type == "logistic"
    if B > 0 and method != "nn_matching" and not refit:
        warn.append(
            f"Bootstrap SEs hold the {cfg.model_type} propensity model fixed (refitting is only done for "
            "logistic models), which tends to overstate SEs for weighting methods"
        )
    if B == 0:
        warn.append(
            "Analytic SEs (n_bootstrap=0) ignore estimation of the propensity score"
            + (" and the reuse/pairing of matched controls" if method == "nn_matching" else "")
            + "; use the bootstrap for reliable CIs and p-values"
        )
    if B > 0:
        rng = np.random.default_rng(cfg.random_state)
        pool = np.arange(n) if refit else idx
        e_pos, c_pos = pool[t[pool] == 1], pool[t[pool] == 0]
        ne, nc = len(e_pos), len(c_pos)
        lifts = np.empty((B,) + e.sw.shape)
        step = max(1, B // 20)
        for b in range(B):
            bi = np.concatenate([e_pos[rng.integers(0, ne, ne)], c_pos[rng.integers(0, nc, nc)]])
            if refit:
                tb = t[bi]
                try:
                    psb, _ = fit_propensity(ctx.X_model[bi], tb, cfg.model_type, cfg.random_state, ps_only=True)
                except Exception:  # noqa: BLE001 - a degenerate replicate is simply skipped
                    lifts[b] = np.nan
                    continue
                if cfg.trim != "none":
                    kb = trim_mask(psb, tb, cfg.trim)
                    bi, psb, tb = bi[kb], psb[kb], tb[kb]
                    if (tb == 1).sum() < 2 or (tb == 0).sum() < 2:
                        lifts[b] = np.nan
                        continue
                lgb = logit(psb)
            else:
                psb, lgb = ctx.ps[bi], ctx.lg[bi]
            stb = ctx.strata[bi] if ctx.strata is not None else None
            wb_sub, _ = _adjust(method, psb, lgb, t[bi], stb, cfg, ctx.caliper_abs)
            wb = np.bincount(bi, weights=wb_sub, minlength=n)
            with np.errstate(divide="ignore", invalid="ignore"):
                lifts[b] = lift_only(wb, t, ctx.D, ctx.Y, ctx.M)
            if b % step == 0:
                report(0.1 + 0.85 * b / B, f"{method}: bootstrapping ({b}/{B})")
        se_bs = bootstrap_se(lifts)

    lift_unclipped = None
    if info.w_unclipped is not None:
        w_unc = np.zeros(n)
        w_unc[idx] = normalize_within_group(info.w_unclipped, t[idx])
        with np.errstate(divide="ignore", invalid="ignore"):
            lift_unclipped = lift_only(w_unc, t, ctx.D, ctx.Y, ctx.M)

    # ---- contrasts ------------------------------------------------------- #
    report(0.96, f"{method}: contrasts")
    em, cm = e.mean(), c.mean()
    rem, rcm = ctx.raw_e.mean(), ctx.raw_c.mean()
    ess_c_g = c.ess()
    contrasts: List[OutcomeContrast] = []
    subgroups: List[SubgroupContrast] = []
    fallback_warned = False
    for g, (gcol, glev) in enumerate(ctx.groups):
        for k, od in enumerate(ctx.outcomes):
            se, ci_method = float(se_an[g, k]), "analytic"
            if se_bs is not None:
                if math.isfinite(se_bs[g, k]):
                    se, ci_method = float(se_bs[g, k]), "bootstrap"
                elif not fallback_warned:
                    warn.append("Some bootstrap SEs were undefined; analytic SEs used instead")
                    fallback_warned = True
            prefix = od.name if g == 0 else f"{od.name} [{gcol}={glev}]"
            fields = contrast_fields(
                outcome=od.name,
                outcome_type=od.outcome_type,
                exposed_mean=float(em[g, k]),
                control_mean_raw=float(rcm[g, k]),
                raw_exposed_mean=float(rem[g, k]),
                control_mean_adjusted=float(cm[g, k]),
                n_exposed=int(round(e.cnt[g, k])),
                n_control=int(round(c.cnt[g, k])),
                effective_n_control=float(c.cnt[g, k]) if method == "nn_matching" else float(ess_c_g[g, k]),
                se=se,
                ci_method=ci_method,
                alpha=cfg.alpha,
                warn=lambda msg, p=prefix, nm=od.name: warn.append(msg.replace(nm, p, 1)),
            )
            if g == 0:
                contrasts.append(OutcomeContrast(**fields))
                if lift_unclipped is not None and cfg.weight_clip:
                    unc, clp = float(lift_unclipped[0, k]), fields["lift"]
                    if math.isfinite(unc) and abs(unc - clp) > 0.25 * fields["se"]:
                        warn.append(
                            f"IPW weight clipping at p{cfg.weight_clip * 100:g} shifted the {od.name} estimate "
                            f"from {unc:.3g} (unclipped) to {clp:.3g}; clipping trades bias for variance and "
                            "changes the effective estimand (consider overlap weights or trimming instead)"
                        )
            else:
                subgroups.append(SubgroupContrast(subgroup_column=gcol, subgroup_level=glev, **fields))

    return MethodResult(
        method=method,
        label=_label(method, cfg),
        estimand=cfg.estimand,
        n_exposed_used=int(((wa > 0) & (ta == 1)).sum()),
        n_control_used=n_c_used,
        balance=balance,
        balance_summary=bsum,
        contrasts=contrasts,
        subgroups=subgroups,
        matching=matching,
        weights=weights,
        adjusted_ps_histogram=adjusted_ps_histogram(ctx.ps, t, w, ctx.ps_edges),
        warnings=_unique(warn),
    )
