# Propensity Modeling & Brand Lift Analyzer — Architecture

Monorepo, `uv` workspace (Python 3.10+) + Vite/React/TypeScript frontend.

```
pyproject.toml                    uv workspace root (members: packages/propensity_lift, backend)
packages/propensity_lift/         pip-installable analysis library  (import name: propensity_lift)
  src/propensity_lift/
    schemas.py      CONTRACT — pydantic models shared by everything (do not change shapes casually)
    io.py           load_table(path, sheet) -> DataFrame; list_sheets(path); profile_dataframe(df, ...) -> DatasetProfile
    preprocess.py   treatment coding, outcome recoding (top-box), feature encoding (one-hot, impute, scale), missing handling
    models.py       fit_propensity(X, t, model_type, random_state) -> (ps array, ModelSummary)
    matching.py     nearest-neighbour matching on logit(PS), caliper, ratio, replacement, exact strata (matching_features)
    weighting.py    IPW (ATT/ATE), overlap weights, stratification weights, clipping, Kish ESS
    doubly_robust.py  AIPW: per-arm outcome regressions + IPW-weighted residual correction, influence-function SE
    diagnostics.py  balance table (SMD, variance ratios, weighted), BalanceSummary
    overlap.py      PS over/underlap (histogram, KDE, regions, OVL, trimming) + per-feature over/underlap
    lift.py         outcome contrasts: weighted means, absolute/relative lift, bootstrap/analytic CI, p-values, subgroups
    pipeline.py     run_analysis(df, config, analysis_id=None, progress=None) -> AnalysisResult   (orchestrates all of the above)
    cli.py          `propensity-lift profile FILE` / `propensity-lift run FILE --config cfg.json --out result.json`
    sample_data.py  make_brand_lift_sample(n=3000, seed=0) -> DataFrame  (synthetic, realistic, confounded)
  tests/
backend/                          FastAPI service (distribution name: lift-api, import name: app)
  app/
    main.py         create_app(); CORS; mounts routers under /api
    config.py       settings (DATA_DIR, MAX_WORKERS, MAX_UPLOAD_MB) from env
    storage.py      dataset store on disk: DATA_DIR/datasets/{id}/ original file + cached parquet per sheet + profile json
    jobs.py         JobManager: ProcessPoolExecutor, asyncio futures, status/progress, cancellation, results persisted to DATA_DIR/analyses/{id}.json
    worker.py       top-level picklable function executed in worker processes
    routes/datasets.py, routes/analyses.py
  tests/
frontend/                         Vite + React 18 + TypeScript, @tanstack/react-query, recharts, react-router
  src/api/types.ts  mirrors schemas.py 1:1 (snake_case)
  src/api/client.ts fetch wrappers
scripts/make_sample_excel.py      writes sample_data/brand_lift_sample.xlsx
scripts/build_site_data.py        writes site/assets/data/{api,walkthrough}.json for the documentation site
site/                             static documentation site, published to GitHub Pages by .github/workflows/pages.yml
```

## Statistical choices (defaults)

* **Estimand**: ATT by default (effect of exposure on the exposed — standard for brand lift). ATE optional.
* **PS model**: logistic regression (L2, standardized inputs) default; gradient boosting / random forest optional.
  Categorical features one-hot encoded (rare levels < 1% pooled into `__other__`), numeric median-imputed with a
  missing-indicator column added when any value is missing.
* **NN matching**: greedy nearest neighbour on logit(PS), caliper = `caliper × SD(logit PS)`, `match_ratio` controls per
  exposed, with/without replacement, exact matching within strata formed by `matching_features`. Controls tied at the k-th
  nearest distance all share the match equally. Matched control
  weights = (number of times used) / ratio; exposed weight 1 → ATT. (For ATE with matching, match both directions.)
* **IPW**: ATT weights exposed=1, control=e/(1-e); ATE weights 1/e and 1/(1-e). Normalised within group. Optional
  clipping at the `weight_clip` quantile (off by default; IPW warns if clipping moves an estimate by > 0.25 SE).
* **Overlap weights**: exposed 1-e, control e (estimand ATO; reported under `estimand` field as configured but label says ATO).
* **Stratification**: `n_strata` PS quantile strata (by exposed quantiles for ATT), within-stratum weights.
* **AIPW** (doubly robust): mu_a = target-population mean of m_a(X) + IPW-weighted mean over arm a of (Y − m_a(X)),
  lift = mu_1 − mu_0. m_a is a per-arm regression on the PS model features (ridge logistic for binary outcomes, OLS
  otherwise). Target population = analysed exposed (ATT) or all analysed (ATE); for ATT only m_0 is fitted and mu_1 is
  the observed exposed mean. Weights, clipping, balance and ESS are those of IPW. Bootstrap replicates refit the
  outcome models (and the logistic PS model); with `n_bootstrap = 0` the SE is the influence-function SE.
* **Balance**: SMD = (mean_e − mean_c)/sqrt((var_e + var_c)/2) using the *unadjusted* pooled SD as denominator both
  before and after; weighted means/variances after. |SMD| > 0.1 flagged.
* **Contrasts**: weighted difference of means. CI = lift ± z·SE. SE by bootstrap when `n_bootstrap > 0`: respondents
  are resampled within group from the pre-trim sample, the trim rule is re-applied, and for IPW / overlap weights /
  stratification with a logistic PS model the PS model is **re-fitted** in every replicate (so SEs reflect PS
  estimation). Gradient boosting / random forest keep the PS fixed (warned as conservative). NN-matching SEs are the
  naive bootstrap (no Abadie–Imbens correction). With `n_bootstrap = 0`, analytic (weighted variance / ESS) SEs are
  used and a warning notes they ignore PS estimation. Two-sided p-value from
normal approximation of lift/se. Relative lift = lift / adjusted control mean.
* **Overlap/underlap**: common support = [max(min_e,min_c), min(max_e,max_c)] on PS. Regions: control_only (<lower),
  both, exposed_only (>upper) — reported with counts/pct per group. OVL = ∫min(f_e,f_c) via shared-bin histogram
  (40 bins). Trim rules: `common_support` (drop outside support), `crump` (keep 0.1 ≤ e ≤ 0.9).

## HTTP API (all JSON, prefix `/api`)

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/api/health` | | `{"status":"ok","workers":N}` |
| POST | `/api/datasets` | multipart `file` (.xlsx/.xls/.csv), optional query `sheet` | `DatasetProfile` (201) |
| GET | `/api/datasets` | | `DatasetProfile[]` (summaries, may omit columns? NO — full) |
| GET | `/api/datasets/{dataset_id}` | query `sheet` | `DatasetProfile` |
| DELETE | `/api/datasets/{dataset_id}` | | 204 |
| POST | `/api/analyses` | `AnalysisConfig` | `AnalysisSubmitted` (202) — validated synchronously (columns exist, exposed/control both non-empty) → 422 with message otherwise |
| GET | `/api/analyses` | | `JobInfo[]` newest first |
| GET | `/api/analyses/{analysis_id}` | | `JobDetail` (`result` present when completed) |
| DELETE | `/api/analyses/{analysis_id}` | | cancels if queued/running, else deletes; 204 |
| GET | `/api/analyses/{analysis_id}/export` | | `.xlsx` workbook (Summary, Contrasts, Balance, Overlap, FeatureOverlap, Subgroups sheets) |

Concurrency: the event loop never runs analysis code. `POST /api/analyses` schedules
`run_in_executor(ProcessPoolExecutor, worker.run_job, ...)` and returns immediately; many analyses run in parallel
(bounded by `MAX_WORKERS`, default `max(1, cpu_count-1)`). Progress is reported from workers through a
`multiprocessing.Manager().dict()` keyed by analysis_id and merged into `JobInfo` on read.
The frontend polls `GET /api/analyses/{id}` every 1.5s while queued/running.

## Frontend pages

1. **Upload** — drag-and-drop Excel/CSV, sheet picker, list of previously uploaded datasets.
2. **Configure** — column-role grid built for wide surveys (search, filter by kind, multi-select + bulk assign role:
   treatment / outcome / model feature / matching feature / subgroup / ignore; suggested roles prefilled),
   treatment value picker (exposed vs control from `top_values`), outcome top-box recode, method & model options.
3. **Runs** — list of analyses with live status/progress (several can run at once).
4. **Results** (tabs):
   * *Lift* — per-outcome contrast table (exposed vs control raw & adjusted, abs/rel lift, CI, p, significance) and a
     grouped bar/CI chart comparing methods side-by-side.
   * *Overlap* — mirrored PS histogram + density, shaded common support, region table (control_only/both/exposed_only),
     OVL; per-feature over/underlap table with drill-down charts.
   * *Balance* — love plot (|SMD| before vs after per variable, 0.1 threshold) per method + table.
   * *Model* — AUC, feature importance, calibration.
   * *Subgroups* — lift by subgroup level.
   * Export to Excel button.
