# github-pages-site

Objective: a GitHub Pages documentation and showcase site for `propensity_lift`, aimed at analysts who build propensity models but may not know the identification requirements or why the problem must be framed first.
Branch: `feat/github-pages-site`. Delivery strategy: `single-pr` (a new, self-contained static site; nothing existing is rewritten, so one PR is reviewable despite its size). Push, PR and enabling Pages stay with the user.
Test runner: `uv run pytest packages backend -q`; site checks: `uv run python scripts/build_site_data.py --check` and a browser pass over `site/` served by `make site`.

## Specs

- S1. "add a github pages site"
- S2. "describe propensity modeling and how to use this package"
- S3. "it should be informational with a focus on an audience of analysts how are used to building propensity models but may not understand the identification requirements or the improtance of framing the problem before running the propensity model"
- S4. "use https://redam94.github.io/second-brain/ as an information resource"
- S5. "I like apple.com's website design for product showcases"
- S6. "make use of interactive graphs, plots, and diagrams"
- S7. "there should be motion graphics and transitions between parts"
- S8. "with a navbar with search"
- S9. "there should be a complete api reference"
- S10. "and a common usecases"
- S11. "and full end to end walk through"

Assumptions (not user requirements): the site is static HTML/CSS/JS with no build step, lives in `site/`, and deploys with a GitHub Actions Pages workflow; the API reference is generated from the source so it cannot drift; walkthrough figures come from a real `run_analysis` run on the bundled sample data.

## Tasks

- [x] T1 (S9, S11) inline — `scripts/build_site_data.py` writes `site/assets/data/api.json` and `walkthrough.json`; Makefile targets. Commit: cb06d9b
- [x] T2 (S5, S6, S7, S8) inline — design system, navbar, search, page transitions, simulation and chart libraries. Commit: ecbea7c
- [x] T3 (S2, S3, S4, S6, S7) inline — overview, framing, identification and methods pages. Commit: ecbea7c
- [x] T4 (S10, S11) inline — walkthrough and use-cases pages; `scripts/check_site_snippets.py`. Commit: fb3d961
- [x] T5 (S9) inline — API reference page. Commit: fb3d961
- [x] T6 (S1) inline — Pages deploy workflow, README and docs pointers. Risk item 5 (CI/deploy). Commit: bd75b7c

Route evidence: no Writer trigger reason holds. The pages share one stylesheet, one chart library and one voice, so the units are not independent; the parent writes inline. One read-only explorer mapped the second-brain notes (Mapping trigger: more than 5 sequential fetches).

## Log

- L1 (2026-11-11, user request, verbatim): "add a github pages site, describe propensity modeling and how to use this package, it should be informational with a focus on an audience of analysts how are used to building propensity models but may not understand the identification requirements or the improtance of framing the problem before running the propensity model, use https://redam94.github.io/second-brain/ as an information resource. I like apple.com's website design for product showcases, make use of interactive graphs, plots, and diagrams, there should be motion graphics and transitions between parts with a navbar with search. there should be a complete api reference and a common usecases and full end to end walk through"
- L2 (2026-11-11): Forecast is roughly 5,000 authored lines, far over the 400-line heuristic. Chose `single-pr`: the change is purely additive (new `site/`, one script, one workflow) and splitting it would produce slices that cannot be previewed on their own.
- L3 (2026-11-11): Pages is not enabled on the repository (`gh api repos/.../pages` returned 404). Enabling it is a repository setting and stays with the user.
- L4 (2026-11-11): Evidence for T1-T5. `make site-check`: api.json up to date; 21 of 21 Python examples on the site execute against the package. All 28 external links return 200; 82 internal links and anchors resolve. Browser pass at desktop, 680px and 390px widths in dark and light themes: no console errors, no horizontal overflow. Cited figures spot-checked against the source notes (Lewis, Rao and Reiley 5.4% vs 872%; Gordon et al. seven of 14; Gordon, Moakler and Zettelmeyer 173% vs 29%).
- L5 (2026-11-11): `uv run pytest packages backend -q`: 124 passed, 1 failed. The failure, `backend/tests/test_analyses.py::test_parallel_jobs_keep_event_loop_responsive`, is `datetime.fromisoformat` rejecting a `Z` suffix on Python 3.10. It is not touched by this change (no file under `backend/` or `packages/` changed) and is left for the user.
- L6 (2026-11-11): Found while writing the methods page: README says the bootstrap holds the propensity model fixed, but `pipeline.py` refits a logistic model in every replicate for the weighting methods (fixed only for matching and tree models). The site follows the code. README sentence left unchanged; reported to the user.
- L7 (2026-11-11): 13 public functions have no docstring in the source (for example `suggest_role`, `logit`, `common_support`, `p_value`). The reference lists them with signature and source link only. Adding docstrings is a follow-up in the package, not done here.
- L8 (2026-11-11): Action versions checked against the GitHub API on this date: checkout v7, configure-pages v6, upload-pages-artifact v5, deploy-pages v5, setup-uv v10.3.3 pinned by commit (it publishes no `v10` tag). The workflow cannot be run locally; first real proof is the first push to `main` after Pages is enabled.
- L9 (2026-11-11): Native assess over 42df71b..HEAD: risk high (`shell_process` signals in `scripts/check_site_snippets.py` and `.github/workflows/pages.yml`), `review_due` true.
- L10 (2026-11-11): Engram mirror `odd/github-pages-site/tasks` is PENDING. Both `mem_save` calls were refused by the permission layer (a hook rewrites the call after review); not retried. This file is the only copy until the mirror is written.
- L11 (2026-11-12): Independent verifier (clean clone, workflow steps reproduced under Python 3.10 and 3.12, api.json byte-identical, 21/21 examples, all links, headless render with 0 console errors). S1-S10 pass, S11 partial. One blocker: the walkthrough said `sample_analysis_config()` returns the five-method config; it returns four, without `aipw`. Fixed, together with three advisories it raised (bootstrap wording per method, the placebo sentence, the export count). Advisories left open: `404.html` renders unstyled for nested missing paths; d3 loads from a CDN with no local copy; the deploy workflow does not run `site-check`.
- L12 (2026-11-12): Native review for 42df71b..df0b7a6 (lenses risk, readability): consent relayed; the user chose "Skip this time". Outcome: declined for this candidate; no review record. Delivery follows ordinary repository policy. Next step for the user: push the branch, open a PR, and set Pages source to "GitHub Actions".
