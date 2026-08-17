"""Kernel-side runtime shim for the omp RLM capability.

SLICE-4 surface: the package exists, installs into the managed kernel venv,
and is importable — the bootstrap admission gate (POST-TRANS-5) verifies
exactly that. The bridge/recursion API (host_request, rlm.run, harness CRUD)
lands in later slices; this module deliberately exposes no placeholders for
it (REQ-N-6).
"""

__version__ = "0.1.0"

__all__ = ["__version__"]
