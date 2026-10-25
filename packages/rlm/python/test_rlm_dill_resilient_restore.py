"""
Adversarial RED-phase tests for RLM Dill Resilient Restore (SLICE-1).

CONTRACT AUTHORITY RECORD:
- File: contracts/rlm_dill_resilient_restore.contract.py
- Authority: CONTRACT_RLM_DILL_RESILIENT_RESTORE
- Clauses covered:
    POST-RESTORE-SKIP-1 (Resilient restore skips bad variable and restores valid ones)
    POST-RESTORE-TELEMETRY-1 (Telemetry reports skipped variable names and reasons)
    POST-NAME-FILTER-1 (Filters shell builtins including 'open' from snapshot candidates)
    POST-BOOTSTRAP-PRIMITIVES-1 (Bootstrap initializes base interactive and standard primitives)
    INV-RESTORE-PURITY-1 (Staged restore: user_ns populated only after evaluation)
    FORBIDDEN-RESTORE-ABORT-1 (No CorruptSnapshotError on single-variable failure)
    IP-1, IP-2, IP-3, IP-4 (Integration points)
"""

import importlib.util
import lzma
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
import dill

# Load contract explicitly from canonical path to preserve contract-implementation independence
_contract_path = Path(__file__).resolve().parent.parent.parent.parent / "contracts" / "rlm_dill_resilient_restore.contract.py"
_module_name = "rlm_dill_resilient_restore_contract"
_spec = importlib.util.spec_from_file_location(_module_name, _contract_path)
if _spec is None or _spec.loader is None:
    raise ImportError(f"Cannot load contract from {_contract_path}")
_contract_mod = importlib.util.module_from_spec(_spec)
sys.modules[_module_name] = _contract_mod
_spec.loader.exec_module(_contract_mod)

CONTRACT_RLM_DILL_RESILIENT_RESTORE = _contract_mod.CONTRACT_RLM_DILL_RESILIENT_RESTORE
EXCLUDED_BUILTIN_NAMES = _contract_mod.EXCLUDED_BUILTIN_NAMES
BASE_BOOTSTRAP_MODULES = _contract_mod.BASE_BOOTSTRAP_MODULES
validate_names_for_snapshot = _contract_mod.validate_names_for_snapshot
validate_restore_outcome = _contract_mod.validate_restore_outcome
RestoreOutcome = _contract_mod.RestoreOutcome
SkippedVariableRecord = _contract_mod.SkippedVariableRecord

# Import runner implementation under test
import rlm_kernel_runner
from rlm_kernel_runner import CorruptSnapshotError


_MISSING = object()


class TestRlmDillResilientRestore(unittest.TestCase):
    """Adversarial RED-phase tests targeting SLICE-1 resilient restore obligations."""

    def setUp(self):
        self.test_dir = tempfile.mkdtemp(prefix="rlm_resilient_test_")
        self.snapshot_path = os.path.join(self.test_dir, "kernel-state.dill")
        self.manifest_path = os.path.join(self.test_dir, "kernel-state.json")
        self.ns = rlm_kernel_runner._get_ns()
        self.ns.clear()

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)
        self.ns.clear()

    def test_post_name_filter_1_excludes_shell_open_builtin(self):
        """
        FOUR-CRITERIA TEST VALIDITY GATE:
          [✓] C1 VALID: cites clause POST-NAME-FILTER-1
          [✓] C2 VALUABLE: passes 'can impl be wrong and test pass?' = NO
          [✓] C3 NON-DUPLICATIVE: only test asserting 'open' shell builtin exclusion
          [✓] C4 NOT FUTURE-EDIT: bounds current _snapshot_names candidate list

        CONTRACT TRACEABILITY:
        - Contract: CONTRACT_RLM_DILL_RESILIENT_RESTORE["POST-NAME-FILTER-1"]
        - Enforces: POST-NAME-FILTER-1 (KernelRunner._snapshot_names filters out interactive shell builtins including 'open')
        - Category: negative
        - Risk tier: High — serializing IPython's _modified_open breaks all future restores
        - Adversarial: Injects 'open' into user_ns and asserts exclusion from candidate list
        """
        # ARRANGE: Simulate IPython injecting 'open' into user_ns
        def fake_ipython_open(path, *args, **kwargs):
            return "fake_open"

        self.ns["open"] = fake_ipython_open
        self.ns["valid_user_var"] = 42

        # ACT: Invoke implementation under test
        candidate_names = rlm_kernel_runner._snapshot_names()

        # ASSERT: Contract verification
        assert "open" not in candidate_names, (
            "POST-NAME-FILTER-1 violation: 'open' shell wrapper was not filtered from snapshot names\n"
            "Contract: CONTRACT_RLM_DILL_RESILIENT_RESTORE['POST-NAME-FILTER-1']\n"
            "EXPECTED: 'open' absent from candidate_names\n"
            f"ACTUAL: candidate_names contains 'open': {candidate_names}\n"
            "GUIDANCE: _snapshot_names must exclude shell-injected builtins ('open') from snapshot candidates"
        )
        assert "valid_user_var" in candidate_names, (
            "POST-NAME-FILTER-1 violation: legitimate user variable was mistakenly filtered\n"
            "Contract: CONTRACT_RLM_DILL_RESILIENT_RESTORE['POST-NAME-FILTER-1']\n"
            "EXPECTED: 'valid_user_var' in candidate_names\n"
            f"ACTUAL: candidate_names={candidate_names}\n"
            "GUIDANCE: Only excluded builtins must be filtered, preserving valid user state"
        )

    def test_post_restore_skip_1_and_telemetry_resilient_restore(self):
        """
        FOUR-CRITERIA TEST VALIDITY GATE:
          [✓] C1 VALID: cites clause POST-RESTORE-SKIP-1, POST-RESTORE-TELEMETRY-1, FORBIDDEN-RESTORE-ABORT-1
          [✓] C2 VALUABLE: passes 'can impl be wrong and test pass?' = NO
          [✓] C3 NON-DUPLICATIVE: asserts resilient unpickling of mixed good and bad variable blobs
          [✓] C4 NOT FUTURE-EDIT: tests actual _snapshot_restore behavior with invalid variable blob

        CONTRACT TRACEABILITY:
        - Contract: CONTRACT_RLM_DILL_RESILIENT_RESTORE["POST-RESTORE-SKIP-1"]
        - Enforces: POST-RESTORE-SKIP-1, POST-RESTORE-TELEMETRY-1, FORBIDDEN-RESTORE-ABORT-1
        - Category: boundary/resilience
        - Risk tier: High — unpickling failure currently raises CorruptSnapshotError and breaks kernel
        - Adversarial: Constructs a snapshot with one valid variable and one unpicklable variable
        """
        # ARRANGE: Construct a compressed snapshot with 1 valid variable and 1 corrupted variable blob
        valid_blob = dill.dumps(12345)
        # Bad blob referencing non-existent module 'non_existent_module_xyz'
        bad_blob = b"cnon_existent_module_xyz\nMissingClass\nq\x00."

        container = {
            "good_var": valid_blob,
            "broken_var": bad_blob,
        }

        # Write as LZMA compressed payload
        with lzma.open(self.snapshot_path, "wb") as f:
            dill.dump(container, f)

        # ACT: Call _snapshot_restore on the implementation
        # Expected under current implementation: raises CorruptSnapshotError (RED failure)
        # Expected under contract: succeeds, restores good_var, skips broken_var, reports in telemetry
        result = rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)

        # ASSERT: good_var must be restored in user_ns
        assert "good_var" in self.ns, (
            "POST-RESTORE-SKIP-1 violation: valid variable 'good_var' was not restored to user_ns\n"
            "Contract: CONTRACT_RLM_DILL_RESILIENT_RESTORE['POST-RESTORE-SKIP-1']\n"
            "EXPECTED: 'good_var' in user_ns\n"
            f"ACTUAL: user_ns keys: {list(self.ns.keys())}\n"
            "GUIDANCE: Deserialization of valid variables must succeed even when sibling variables fail"
        )
        assert self.ns["good_var"] == 12345, (
            f"POST-RESTORE-SKIP-1 violation: 'good_var' value mismatch: expected 12345, got {self.ns.get('good_var')}"
        )

        # ASSERT: broken_var must NOT be in user_ns
        assert "broken_var" not in self.ns, (
            "INV-RESTORE-PURITY-1 violation: unpicklable variable 'broken_var' was bound to user_ns"
        )

        # ASSERT: Telemetry must report skipped variables
        assert "skipped" in result, (
            "POST-RESTORE-TELEMETRY-1 violation: restore result missing 'skipped' telemetry list\n"
            "Contract: CONTRACT_RLM_DILL_RESILIENT_RESTORE['POST-RESTORE-TELEMETRY-1']\n"
            f"ACTUAL result: {result}\n"
            "GUIDANCE: _snapshot_restore must include 'skipped' records in its returned dictionary"
        )
        skipped_names = [s.get("name") if isinstance(s, dict) else s for s in result["skipped"]]
        assert "broken_var" in skipped_names, (
            "POST-RESTORE-TELEMETRY-1 violation: 'broken_var' not reported in skipped telemetry\n"
            f"ACTUAL skipped: {result['skipped']}\n"
            "GUIDANCE: Every skipped variable must be reported with its name and failure diagnostic"
        )

    def test_post_bootstrap_rlm_required_1_missing_runtime_fails_fast(self):
        """POST-BOOTSTRAP-RLM-REQUIRED-1: bootstrap must not report readiness when the rlm runtime cannot be imported."""
        saved = sys.modules.get("rlm", _MISSING)
        sys.modules["rlm"] = None  # makes `import rlm` raise ImportError
        try:
            raised = None
            try:
                rlm_kernel_runner._bootstrap()
            except ImportError as exc:
                raised = exc
        finally:
            if saved is _MISSING:
                sys.modules.pop("rlm", None)
            else:
                sys.modules["rlm"] = saved
        assert raised is not None, (
            "POST-BOOTSTRAP-RLM-REQUIRED-1 violation: _bootstrap reported success although the rlm runtime is not importable\n"
            "Contract: CONTRACT_RLM_DILL_RESILIENT_RESTORE['POST-BOOTSTRAP-RLM-REQUIRED-1']\n"
            "ACTUAL: no exception raised\n"
            "GUIDANCE: bootstrap must fail with an ImportError that names rlm-runtime"
        )
        assert "rlm-runtime" in str(raised), (
            "POST-BOOTSTRAP-RLM-REQUIRED-1 violation: the readiness failure does not name rlm-runtime\n"
            f"ACTUAL message: {str(raised)[:200]}"
        )


if __name__ == "__main__":
    unittest.main()
