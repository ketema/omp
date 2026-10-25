"""CI entry point for the RLM Python recovery/quarantine suites (POST-CI-RLM-EXECUTION-1).

Run it through the pinned uv project so every dependency comes from uv.lock:

    uv run --locked --project packages/rlm/python/rlm-runtime --group test \
        python packages/rlm/python/ci_run_tests.py

Unlike a bare ``unittest discover`` it FAILS (never silently passes) when nothing ran, when any
test was skipped, or when a test module could not be imported.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path


def main() -> int:
    start_dir = Path(__file__).resolve().parent
    suite = unittest.defaultTestLoader.discover(
        str(start_dir), pattern="test_*.py", top_level_dir=str(start_dir)
    )
    result = unittest.TextTestRunner(verbosity=2).run(suite)

    print(
        "RLM-PYTHON-SUMMARY "
        f"ran={result.testsRun} failures={len(result.failures)} errors={len(result.errors)} "
        f"skipped={len(result.skipped)} expected_failures={len(result.expectedFailures)} "
        f"unexpected_successes={len(result.unexpectedSuccesses)}"
    )
    if result.testsRun == 0:
        print("RLM-PYTHON-FAIL: no tests ran", file=sys.stderr)
        return 1
    if result.skipped or result.expectedFailures or result.unexpectedSuccesses:
        print(
            "RLM-PYTHON-FAIL: skipped / expected-failure / unexpected-success cases are not "
            "allowed; a missing prerequisite must fail, not skip",
            file=sys.stderr,
        )
        return 1
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
