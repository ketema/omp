"""sys.path bootstrap for the rlm_ledger RED suite.

Adds packages/rlm/python to sys.path so `import rlm_ledger` resolves the
implementation-under-test. The module does not exist at RED time; that
ModuleNotFoundError IS the RED failure mode (adversarial-test-writer skill:
implementation-missing errors are the canonical RED state).
"""

import sys
from pathlib import Path

PYTHON_ROOT = Path(__file__).resolve().parents[1]
if str(PYTHON_ROOT) not in sys.path:
    sys.path.insert(0, str(PYTHON_ROOT))
