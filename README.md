# Propensity Modeling & Brand Lift Analyzer

Upload an Excel (or CSV) file with one row per survey respondent, coded as **exposed** or **control**. The tool
fits a propensity-score model and adjusts the control group with matching or weighting. It then reports, for each
brand KPI, how exposed respondents compare with comparable controls. It also shows where the two groups overlap
or fail to overlap (**over/underlap**), both on the propensity score and feature by feature.

The repository has three parts:

| Part | Path | What it is |
|---|---|---|
| `propensity_lift` | `packages/propensity_lift` | A Python library that holds all the statistics: profiling, encoding, PS models, matching, weighting, balance, overlap, lift and the bootstrap. It works on its own and includes a CLI. |
| `lift-api` | `backend` | A FastAPI service. Analyses run in a process pool, so several can run at once and the API stays responsive. |
| frontend | `frontend` | React 18 + TypeScript + Vite + recharts. It covers upload, column-role setup for wide surveys, the runs list and the results dashboard. |

The binding data contract is `packages/propensity_lift/src/propensity_lift/schemas.py`, and
`frontend/src/api/types.ts` mirrors it 1:1. Design details are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Architecture

```
 Browser (React SPA)                         FastAPI process (event loop never runs analysis code)
 ┌──────────────────────────┐   /api/*     ┌──────────────────────────────────────────────────────┐
 │ Upload → Configure       │ ───────────▶ │ routes/datasets.py   storage.py                       │
 │ Runs (polls every 1.5 s) │ ◀─────────── │   upload → DATA_DIR/datasets/{id}/ (+ parquet cache)  │
 │ Results: Lift | Overlap  │   JSON/xlsx  │   profile_dataframe() → DatasetProfile                │
 │  Balance | Model |       │              │ routes/analyses.py  validation.py  jobs.py            │
 │  Subgroups | Config      │              │   POST → validate → JobManager.submit → 202           │
 └──────────────────────────┘              │   status/progress ← Manager().dict()                  │
                                           │   export.py → .xlsx                                   │
                                           └──────────────┬───────────────────────────────────────┘
                                                          │ run_in_executor(ProcessPoolExecutor, MAX_WORKERS)
                                           ┌──────────────▼───────────────────────────────────────┐
                                           │ worker.py  (one process per running analysis)        │
                                           │   propensity_lift.run_analysis(df, config, progress) │
                                           │     preprocess → models → overlap → matching /       │
                                           │     weighting → diagnostics → lift (+bootstrap)      │
                                           │   → AnalysisResult JSON in DATA_DIR/analyses/{id}.json│
                                           └──────────────────────────────────────────────────────┘
```

## Quick start

Prerequisites: [uv](https://docs.astral.sh/uv/) (it provides Python 3.10+) and Node 18+.

```bash
# one-time setup
uv sync                       # Python workspace: propensity_lift + lift-api + dev tools
cd frontend && npm install && cd ..
# or: make install
```

### Development (two terminals)

```bash
make dev-backend    # = uv run python backend/run.py           → http://localhost:8000  (API docs at /docs)
make dev-frontend   # = cd frontend && npm run dev             → http://localhost:5173  (proxies /api → :8000)
```

Open http://localhost:5173. To try the app without your own data, upload `sample_data/brand_lift_sample.xlsx`.
It is a synthetic survey of 3,000 respondents and 51 columns with known true effects. `make sample` regenerates it.

### Single-process production

```bash
make serve          # = (cd frontend && npm run build) && uv run uvicorn app.main:app --app-dir backend --port 8000
```

When `frontend/dist/index.html` exists, the backend serves the built UI at `/`, and unknown non-API paths fall back
to the SPA. Everything then runs on http://localhost:8000. Add `--host 0.0.0.0` (or `make serve HOST=0.0.0.0`) to
expose it on the network.

### Tests

```bash
make test           # uv run pytest packages backend -q  &&  cd frontend && tsc --noEmit && vitest run
```

### Configuration (backend)

Settings are read from environment variables or `backend/.env`:

| Variable | Default | Meaning |
|---|---|---|
| `DATA_DIR` | `backend/data` | Where uploads, parquet caches and results are stored |
| `MAX_WORKERS` | `cpu_count - 1` | Number of analyses that run in parallel |
| `MAX_UPLOAD_MB` | `100` | Upload size limit |
| `CORS_ORIGINS` | `["http://localhost:5173"]` | JSON list |
| `FRONTEND_DIST` | `frontend/dist` | Built UI to serve at `/` |
| `SHUTDOWN_GRACE_SECONDS` | `5` | How long shutdown waits for workers |

## Preparing your Excel file

Use one sheet with **one row per respondent** and **one column per variable**. Put the header in row 1, with no
merged cells or multi-row headers. Other sheets are allowed, and you pick the sheet after uploading.

| Column type | Example | Notes |
|---|---|---|
| **Exposed/control flag** (required) | `group` = `Exposed` / `Control`, or `1`/`0` | Any values work. In Configure you choose which ones mean *exposed* and which mean *control*, and by default every other non-missing value counts as control. Rows with a missing or unused value are dropped and counted. |
| **Model features** | `age`, `income_band`, `tv_hours_week`, `prior_brand_usage`, attitude scales | These are covariates for the propensity model. Numeric and categorical columns both work: categoricals are one-hot encoded, levels below 1% are pooled, numeric gaps are median-imputed and get a missing-indicator column. |
| **Matching features** | `age_band`, `gender`, `region` | These are the variables the sample was matched or quota'd on. NN matching uses them as **exact-match strata**, and they always appear in the balance and overlap reports. Numeric matching features with more than 10 values are split into quintiles. By default they are also included in the model (`include_matching_in_model`). |
| **Outcomes / KPIs** | `aided_awareness` (Yes/No), `favorability` (1–5), `purchase_intent` (text scale) | 0/1, Yes/No and True/False columns are reported as **proportions** (lift in percentage points). Numeric scales are reported as **means**. For a text scale, choose its top-box levels (e.g. "Definitely will" + "Probably will"), and it is recoded to 1/0. |
| **Subgroups** (optional) | `gender`, `age_band` | Lift is broken out by level. Numeric columns with more than 10 values are split into quintiles. |
| Anything else | IDs, zip codes, timestamps, open text | IDs are detected automatically. Mark the rest **Ignore**: the profiler suggests a role for every column, and you can bulk-assign roles in the grid. |

Missing values are allowed. With `missing_strategy="impute"` (the default), features are imputed. Respondents with
a missing outcome are dropped for that outcome only.

## Methodology

### Estimands
* **ATT** (default) is the effect of exposure on the people who were exposed: *"How much higher is awareness among
  exposed respondents than it would have been without exposure?"* This is the standard brand-lift question. Controls are
  reweighted or matched to look like the exposed group.
* **ATE** is the effect averaged over everyone, exposed and control.
* **Overlap weights** target the **ATO**, the population where the two groups overlap most. Results are reported
  under the configured estimand, and a warning says that the target is the ATO.

### Propensity score
The propensity score is P(exposed | features). It is estimated with L2-regularised **logistic regression** on
standardised inputs (the default), **gradient boosting**, or **random forest**. Tree models use out-of-sample scores:
5-fold cross-fitting for boosting and out-of-bag predictions for the forest. In-sample tree scores are over-confident
and make the groups look more separated than they are. The Model tab shows the AUC, aggregated feature importance and a
decile calibration plot. A high AUC (> 0.8) means the groups differ a lot, so check the overlap carefully.

### Adjustment methods (any combination can be run side by side)
| Method | How it works |
|---|---|
| `nn_matching` | Greedy nearest-neighbour matching on logit(PS), with a caliper of `caliper × SD(logit PS)` (default 0.2) and `match_ratio` controls per exposed respondent, with or without replacement. Matching is exact within the strata formed by the matching features. Exposed respondents with no control inside the caliper are excluded, and a warning reports how many. For ATE it matches in both directions. |
| `ipw` | Inverse probability weights. ATT: exposed = 1, control = e/(1−e). ATE: 1/e and 1/(1−e). Weights are normalised within each group and optionally clipped at the `weight_clip` quantile. |
| `overlap_weights` | Exposed = 1−e, control = e. These weights are bounded and automatically down-weight respondents in the regions where the groups do not overlap. |
| `stratification` | `n_strata` PS-quantile strata, using the exposed group's quantiles for ATT, with weights within each stratum. |
| `aipw` | Doubly robust augmented IPW. An outcome model is fitted per group on the model features (logistic for binary outcomes, linear otherwise), and the IPW weights (same weights, clipping and estimand as `ipw`) correct its residuals. The estimate stays consistent if either the propensity model or the outcome model is right, and is usually more precise than `ipw`. The outcome models are always these regressions, whatever `model_type` is used for the propensity score. |

**Trimming** can be applied before adjustment: `common_support` drops respondents outside the PS range shared by both
groups, and `crump` keeps only 0.1 ≤ PS ≤ 0.9.

### Contrasts (the Lift tab)
For each outcome and method:
* `exposed_mean` and `control_mean_adjusted` are the (weighted) group means. The adjusted control mean is the
  counterfactual: what exposed respondents would have scored without exposure.
* **Absolute lift** = exposed − adjusted control. It is in percentage points (pp) for proportions and in scale units
  for means. **Relative lift** = absolute lift ÷ adjusted control × 100.
* `raw_diff` = unadjusted exposed mean − unadjusted control mean. The gap between the raw difference and the adjusted
  lift is the part of the naive difference explained by confounding.
* **CI / p-value**: when `n_bootstrap > 0`, respondents are resampled within each group 200 times by default, and the
  matching or weighting step is redone on each resample, holding the PS model fixed. The CI is lift ± z·SE_bootstrap
  and the p-value comes from a normal approximation, so the CI, the p-value and the significance flag always agree.
  With `n_bootstrap = 0`, analytic standard errors (weighted variance and effective sample size) are used.
* **Effective N** (Kish ESS) shows how much information is left after weighting. A small ESS means a few respondents
  carry most of the weight.

### Balance (the Balance tab)
The standardised mean difference is SMD = (mean_exposed − mean_control) / √((var_e + var_c)/2). The pooled SD before
adjustment is used as the denominator both before and after, so the two values are comparable. **|SMD| > 0.1** counts
as imbalanced. In the **love plot**, a hollow dot is the SMD before adjustment and a filled dot is the SMD after. Good
adjustment moves every filled dot to the left of the dashed 0.1 line. Variance ratios are shown for numeric
variables, and a ratio between 0.5 and 2 is acceptable.

### Over/underlap (the Overlap tab)
Overlap is checked on the propensity score and feature by feature.

* **Common support** = [max(min PS exposed, min PS control), min(max PS exposed, max PS control)].
* **Regions** (counts and percentage of each group):
  * `control_only` (below support): controls with lower scores than any exposed respondent. They are unlike every
    exposed respondent and contribute little or nothing to an ATT.
  * `both` (overlap): the region where a comparison can be made.
  * `exposed_only` (above support): exposed respondents with no comparable controls (**underlap**). Their lift is
    extrapolated, so consider trimming, or read the result as applying to the overlapping population.
* **OVL** (overlap coefficient) = ∫ min(f_exposed, f_control). It is computed from a 40-bin shared histogram. A value
  of 1 means the distributions are identical and 0 means they do not overlap at all. As a rough guide, OVL > 0.8 is
  good overlap, 0.5–0.8 is moderate and below 0.5 is poor.
* **Mirrored histogram**: exposed bars point up and control bars point down, with KDE curves overlaid and common
  support shaded. Wherever one side has mass and the other has none, that group has no comparable counterparts.
* **Feature over/underlap**: shows the OVL of the raw distributions for every model and matching feature. It reports
  the percentage of each group whose value is unsupported, meaning it falls outside the other group's range for numeric
  features or is a level the other group never has for categorical ones. It also lists *exposed-only* and
  *control-only* levels. Click a row to see the distributions side by side.
* The Balance tab's **before/after PS histogram** shows the distributions coinciding once matching or weighting is
  applied.

### Reading the Lift chart
The forest plot shows one row per method within each outcome. A ◇ marks the raw (unadjusted) difference. A dot with
a CI bar marks the adjusted lift: filled means significant at α, hollow means not significant. Methods that agree
are reassuring. A large gap between ◇ and the dots means confounding was present and has been removed.

### Sample data sanity check
`sample_data/brand_lift_sample.xlsx` (seed 0) has confounded exposure: younger respondents, heavy social and
streaming users, and current brand users are more likely to be exposed. It also has known effects, and
`unaided_awareness` has **no** effect. Running all four methods with `sample_analysis_config()` shows unaided
awareness at a raw +3.6 pp and adjusted values between −2.6 and −5.3 pp. The three weighting methods are not
significant; 1:1 NN matching (the noisiest estimator here, with about 690 distinct controls) is borderline at
p ≈ 0.046, a reminder that one of 24 tests at α = 0.05 can be a false positive. The KPIs with real effects shrink
towards their simulated values: for example, consideration goes from a raw +14.0 pp to +8.0 pp adjusted with IPW,
overlap weights or stratification (+5.3 pp, not significant, with NN matching).

## Python package

```python
from propensity_lift import AnalysisConfig, load_table, profile_dataframe, run_analysis

df = load_table("survey.xlsx", sheet="Respondents")
profile = profile_dataframe(df, dataset_id="survey", filename="survey.xlsx")
for col in profile.columns:
    print(col.name, col.kind, col.suggested_role)

cfg = AnalysisConfig(
    dataset_id="survey",
    treatment_column="group", exposed_values=["Exposed"], control_values=["Control"],
    outcome_columns=["aided_awareness", "favorability", "purchase_intent"],
    outcome_positive_values={"aided_awareness": ["Yes"],
                             "purchase_intent": ["Definitely will", "Probably will"]},   # top-2-box
    model_features=["age", "income_band", "tv_hours_week", "social_media_hours_day", "prior_brand_usage"],
    matching_features=["age_band", "gender", "region"],
    subgroup_columns=["gender"],
    methods=["nn_matching", "ipw", "overlap_weights", "stratification"],
    estimand="ATT", model_type="logistic", n_bootstrap=200,
)
result = run_analysis(df, cfg, progress=lambda frac, stage: print(f"{frac:4.0%} {stage}"))

print("OVL", result.overlap.overlap_coefficient, [r.model_dump() for r in result.overlap.regions])
for m in result.methods:
    print(m.label, "max|SMD|", m.balance_summary.max_abs_smd_before, "->", m.balance_summary.max_abs_smd_after)
    for c in m.contrasts:
        print(f"  {c.outcome}: raw {c.raw_diff:+.3f}  lift {c.lift:+.3f}  [{c.ci_low:+.3f}, {c.ci_high:+.3f}]  p={c.p_value:.3g}")

result.model_dump_json()   # the same JSON the API returns
```

`propensity_lift.sample_data` provides `make_brand_lift_sample(n, seed)`, which returns a synthetic DataFrame, and
`sample_analysis_config(**overrides)`, which returns a ready-made config for that data.

## CLI

```bash
uv run propensity-lift profile sample_data/brand_lift_sample.xlsx [--sheet Respondents]     # DatasetProfile JSON
uv run propensity-lift run survey.xlsx --config cfg.json [--sheet S] [--out result.json] [--quiet]
```

`cfg.json` is an `AnalysisConfig`. Its `dataset_id` can be any string and defaults to the file name.

## HTTP API (prefix `/api`; interactive docs at `/docs`)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/api/health` | | `{"status":"ok","workers":N}` |
| POST | `/api/datasets` | multipart `file` (.xlsx/.xls/.csv), optional `?sheet=` | `DatasetProfile` (201) |
| GET | `/api/datasets` | | `DatasetProfile[]` |
| GET | `/api/datasets/{dataset_id}` | `?sheet=` | `DatasetProfile` for that sheet |
| DELETE | `/api/datasets/{dataset_id}` | | 204 |
| POST | `/api/analyses` | `AnalysisConfig` JSON | `AnalysisSubmitted` (202). The config is validated synchronously (columns exist, both groups non-empty, recodes valid); otherwise 422 |
| GET | `/api/analyses` | | `JobInfo[]`, newest first |
| GET | `/api/analyses/{analysis_id}` | | `JobDetail` (`status`, `progress`, `stage`, and `result` once completed) |
| DELETE | `/api/analyses/{analysis_id}` | | 204. Cancels the job if it is queued or running, otherwise deletes it |
| GET | `/api/analyses/{analysis_id}/export` | | `.xlsx` with sheets Summary, Contrasts, Balance, Overlap, FeatureOverlap, Subgroups, Model and Config |

There are two 422 error shapes. Validation errors from this service have `detail` as a string. Malformed request
bodies get FastAPI's standard `detail` list.

```bash
curl -F file=@sample_data/brand_lift_sample.xlsx localhost:8000/api/datasets            # → dataset_id
curl -X POST localhost:8000/api/analyses -H 'content-type: application/json' -d '{
  "dataset_id": "<id>", "treatment_column": "group", "exposed_values": ["Exposed"],
  "outcome_columns": ["ad_recall"], "model_features": ["age", "tv_hours_week"], "methods": ["ipw"]}'
curl localhost:8000/api/analyses/<analysis_id>                                           # poll
curl -OJ localhost:8000/api/analyses/<analysis_id>/export                                # Excel
```

## Repository layout

```
packages/propensity_lift/   library + tests (pytest)
backend/                    FastAPI app (app/), tests, run.py
frontend/                   React app (src/pages, src/components, src/api), vitest tests
scripts/make_sample_excel.py
sample_data/brand_lift_sample.xlsx
docs/ARCHITECTURE.md
Makefile
```
