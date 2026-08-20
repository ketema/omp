"""sys.path bootstrap for the rlm_ledger + rlm-runtime RED suites.

Adds packages/rlm/python to sys.path so `import rlm_ledger` resolves the
implementation-under-test, and packages/rlm/python/rlm-runtime/src so
`import rlm` resolves the rlm-runtime implementation-under-test. A module
that does not exist yet at RED time raises ModuleNotFoundError; a module that
exists but lacks the contracted surface raises ImportError/AttributeError.
Both ARE the RED failure mode (adversarial-test-writer skill:
implementation-missing errors are the canonical RED state).
"""

import sys
from pathlib import Path

PYTHON_ROOT = Path(__file__).resolve().parents[1]
if str(PYTHON_ROOT) not in sys.path:
    sys.path.insert(0, str(PYTHON_ROOT))

RLM_RUNTIME_SRC = PYTHON_ROOT / "rlm-runtime" / "src"
if str(RLM_RUNTIME_SRC) not in sys.path:
    sys.path.insert(0, str(RLM_RUNTIME_SRC))
