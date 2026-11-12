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

- [ ] T1 (S9, S11) inline — `scripts/build_site_data.py` writes `site/assets/data/api.json` and `walkthrough.json`; Makefile targets. Commit: pending
- [ ] T2 (S5, S6, S7, S8) inline — design system, navbar, search, page transitions, simulation and chart libraries. Commit: pending
- [ ] T3 (S2, S3, S4, S6, S7) inline — overview, framing, identification and methods pages. Commit: pending
- [ ] T4 (S10, S11) inline — walkthrough and use-cases pages. Commit: pending
- [ ] T5 (S9) inline — API reference page. Commit: pending
- [ ] T6 (S1) inline — Pages deploy workflow, README and docs pointers. Risk item 5 (CI/deploy). Commit: pending

Route evidence: no Writer trigger reason holds. The pages share one stylesheet, one chart library and one voice, so the units are not independent; the parent writes inline. One read-only explorer mapped the second-brain notes (Mapping trigger: more than 5 sequential fetches).

## Log

- L1 (2026-11-11, user request, verbatim): "add a github pages site, describe propensity modeling and how to use this package, it should be informational with a focus on an audience of analysts how are used to building propensity models but may not understand the identification requirements or the improtance of framing the problem before running the propensity model, use https://redam94.github.io/second-brain/ as an information resource. I like apple.com's website design for product showcases, make use of interactive graphs, plots, and diagrams, there should be motion graphics and transitions between parts with a navbar with search. there should be a complete api reference and a common usecases and full end to end walk through"
- L2 (2026-11-11): Forecast is roughly 5,000 authored lines, far over the 400-line heuristic. Chose `single-pr`: the change is purely additive (new `site/`, one script, one workflow) and splitting it would produce slices that cannot be previewed on their own.
- L3 (2026-11-11): Pages is not enabled on the repository (`gh api repos/.../pages` returned 404). Enabling it is a repository setting and stays with the user.
