"""Run every Python code block on the documentation site against the real package.

The site's examples are documentation that can rot. This script extracts each
``<pre data-lang="python">`` block from the pages, in page order, and executes
them in one shared namespace against the bundled sample data, so an example
that no longer runs fails here instead of in a reader's notebook.

Usage (from the repository root)::

    uv run python scripts/check_site_snippets.py

Bootstrap replicates are capped to keep the run short; that changes no code path.
"""

from __future__ import annotations

import contextlib
import html
import io
import os
import re
import shutil
import sys
import tempfile
import traceback
from pathlib import Path

import numpy as np
import propensity_lift
from propensity_lift.sample_data import sample_analysis_config

ROOT = Path(__file__).resolve().parents[1]
# Pages whose examples run on the sample data. The overview's example uses a hypothetical file.
PAGES = ["walkthrough.html", "identification.html", "methods.html", "use-cases.html"]
BLOCK = re.compile(r'<pre data-lang="python"><code>(.*?)</code></pre>', re.DOTALL)
MAX_BOOTSTRAP = 25


def _add_cell_column(df, rng) -> None:
    """The multi-cell recipe uses a ``cell`` column that the sample data does not have."""
    cells = rng.choice(["Video", "Display", "Video + Display"], len(df))
    df["cell"] = np.where(df["group"] == "Control", "Control", cells)


def main() -> int:
    os.chdir(ROOT)
    real_run = propensity_lift.run_analysis

    def capped_run(df, config, *args, **kwargs):
        config = config.model_copy(update={"n_bootstrap": min(config.n_bootstrap, MAX_BOOTSTRAP)})
        return real_run(df, config, *args, **kwargs)

    # Examples import run_analysis from the package root, so patch it there.
    propensity_lift.run_analysis = capped_run
    rng = np.random.default_rng(1)
    namespace = {
        "df": propensity_lift.make_brand_lift_sample(3000, 0),
        "cfg": sample_analysis_config(),
        "AnalysisConfig": propensity_lift.AnalysisConfig,
        "run_analysis": capped_run,
        "load_table": propensity_lift.load_table,
        "profile_dataframe": propensity_lift.profile_dataframe,
    }
    scratch = Path(tempfile.mkdtemp(prefix="site-snippets-"))
    passed = failed = 0
    try:
        for page in PAGES:
            if "cell" not in namespace["df"].columns:  # an earlier example may have reloaded df
                _add_cell_column(namespace["df"], rng)
            for i, block in enumerate(BLOCK.findall((ROOT / "site" / page).read_text(encoding="utf-8"))):
                # Examples that write files write into the scratch directory, not the repository.
                code = re.sub(r'Path\("([\w.]+)"\)', lambda m: f'Path(r"{scratch / m.group(1)}")', html.unescape(block))
                try:
                    with contextlib.redirect_stdout(io.StringIO()):
                        exec(compile(code, f"{page}#{i}", "exec"), namespace)  # noqa: S102 - our own docs
                    passed += 1
                except Exception:
                    failed += 1
                    print(f"FAIL {page}, python block {i}\n{code}\n{traceback.format_exc(limit=3)}", file=sys.stderr)
    finally:
        propensity_lift.run_analysis = real_run
        shutil.rmtree(scratch, ignore_errors=True)
    print(f"site snippets: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
