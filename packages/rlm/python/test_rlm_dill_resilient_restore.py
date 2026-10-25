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


def _a_var_visible_during_restore():
    """Unpickled by the runner while it restores: reports whether `a_var` is already bound in user_ns (INV-RESTORE-PURITY-1)."""
    return 1 if "a_var" in rlm_kernel_runner._get_ns() else 0


class _NamespaceProbe:
    """A variable whose reconstruction observes the live namespace at the moment the runner rebuilds it."""

    def __reduce__(self):
        return (_a_var_visible_during_restore, ())


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
        try:
            result = rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)
        except CorruptSnapshotError as exc:
            raise AssertionError(
                "FORBIDDEN-RESTORE-ABORT-1 violation: an individual unpickling failure aborted the restore\n"
                "EXPECTED: the broken variable is skipped and the container still restores\n"
                f"ACTUAL: CorruptSnapshotError: {exc}"
            ) from exc

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

    def test_post_bootstrap_ipython_1_missing_ipython_fails_fast(self):
        """
        POST-BOOTSTRAP-IPYTHON-1: bootstrap must not report readiness, and must not skip the preload silently, when
        IPython or its display module cannot be imported; the failure names ipykernel.

        FOUR-CRITERIA TEST VALIDITY GATE:
          [x] C1 VALID: cites POST-BOOTSTRAP-IPYTHON-1 (contracts/rlm_dill_resilient_restore.contract.py)
          [x] C2 VALUABLE: a bootstrap that swallows the ImportError reports success and fails this test
          [x] C3 NON-DUPLICATIVE: the rlm-required test covers a different module
          [x] C4 NOT FUTURE-EDIT: bounds a path bootstrap performs today
        Risk tier: Medium - a silently degraded kernel lacks the display primitives the requirement promises.
        """
        names = ("IPython", "IPython.display")
        saved = {name: sys.modules.get(name, _MISSING) for name in names}
        for name in names:
            sys.modules[name] = None  # makes `import <name>` raise ImportError
        try:
            raised = None
            try:
                rlm_kernel_runner._bootstrap()
            except ImportError as exc:
                raised = exc
        finally:
            for name, module in saved.items():
                if module is _MISSING:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = module
        assert raised is not None, (
            "POST-BOOTSTRAP-IPYTHON-1 violation: _bootstrap reported success although IPython is not importable\n"
            "EXPECTED: an ImportError (bootstrap fails fast)\n"
            "ACTUAL: no exception raised\n"
            "GUIDANCE: a required base module that is absent is a readiness failure, never a silent skip"
        )
        assert "ipykernel" in str(raised), (
            "POST-BOOTSTRAP-IPYTHON-1 violation: the readiness failure does not name ipykernel\n"
            f"ACTUAL message: {str(raised)[:200]}"
        )

    def test_post_name_filter_1_ip3_snapshot_write_excludes_every_shell_builtin_end_to_end(self):
        """
        FOUR-CRITERIA TEST VALIDITY GATE:
          [x] C1 VALID: cites POST-NAME-FILTER-1 and IP-3 (contracts/rlm_dill_resilient_restore.contract.py)
          [x] C2 VALUABLE: a _snapshot_write that does not apply the name filter writes the builtins and fails this test
          [x] C3 NON-DUPLICATIVE: test_post_name_filter_1_excludes_shell_open_builtin calls _snapshot_names() directly; this one
              observes the written payload (the IP-3 handoff names -> write)
          [x] C4 NOT FUTURE-EDIT: bounds the write path the runner performs today

        CONTRACT TRACEABILITY:
        - Enforces: POST-NAME-FILTER-1, IP-3 (the contract's own validator judges the written names)
        - Category: integration (handoff)
        - Risk tier: High - a serialized IPython wrapper breaks every later restore
        """
        for name in EXCLUDED_BUILTIN_NAMES:
            self.ns[name] = object()
        self.ns["valid_user_var"] = 42

        rlm_kernel_runner._snapshot_write(self.snapshot_path, self.manifest_path, 100 * 1024 * 1024, force_codec="raw")
        with open(self.snapshot_path, "rb") as fh:
            written = set(dill.load(fh))

        try:
            _contract_mod.validate_names_for_snapshot(written)
        except _contract_mod.BuiltinLeakageError as exc:
            raise AssertionError(
                "IP-3 / POST-NAME-FILTER-1 violation: the written snapshot carries shell builtins\n"
                f"EXPECTED: none of {sorted(EXCLUDED_BUILTIN_NAMES)} in the payload\n"
                f"ACTUAL: {exc}\n"
                "GUIDANCE: names handed to the snapshot write exclude interactive shell wrappers"
            ) from exc
        assert written == {"valid_user_var"}, (
            "IP-3 violation: the payload is not exactly the user's variables\n"
            f"EXPECTED: {{'valid_user_var'}}\nACTUAL: {sorted(written)}"
        )

    def test_post_bootstrap_primitives_1_ip4_bootstrap_preloads_the_base_modules(self):
        """
        FOUR-CRITERIA TEST VALIDITY GATE:
          [x] C1 VALID: cites POST-BOOTSTRAP-PRIMITIVES-1 and IP-4
          [x] C2 VALUABLE: a _bootstrap that preloads nothing leaves json/pathlib out of sys.modules and fails this test
          [x] C3 NON-DUPLICATIVE: no other test observes the preloaded primitives
          [x] C4 NOT FUTURE-EDIT: bounds what _bootstrap does today (the contract's BASE_BOOTSTRAP_MODULES)

        CONTRACT TRACEABILITY:
        - Enforces: POST-BOOTSTRAP-PRIMITIVES-1, IP-4 (the contract's validate_bootstrap_environment judges sys.modules)
        - Risk tier: Medium
        """
        saved = {name: sys.modules.pop(name) for name in ("json", "pathlib") if name in sys.modules}
        try:
            rlm_kernel_runner._bootstrap()
            try:
                _contract_mod.validate_bootstrap_environment(sys.modules)
            except _contract_mod.ResilientRestoreContractError as exc:
                raise AssertionError(
                    "IP-4 / POST-BOOTSTRAP-PRIMITIVES-1 violation: bootstrap did not load the base primitives before restore\n"
                    f"EXPECTED: {sorted(BASE_BOOTSTRAP_MODULES)} present after _bootstrap()\n"
                    f"ACTUAL: {exc}\n"
                    "GUIDANCE: every base module the contract names is loaded before any cell or restore runs"
                ) from exc
        finally:
            for name in saved:
                sys.modules.pop(name, None)
            sys.modules.update(saved)

    def test_inv_restore_purity_1_user_ns_is_not_mutated_while_variables_are_still_being_rebuilt(self):
        """
        FOUR-CRITERIA TEST VALIDITY GATE:
          [x] C1 VALID: cites INV-RESTORE-PURITY-1 and POST-RESTORE-SKIP-1
          [x] C2 VALUABLE: a restore that binds each variable immediately makes the probe see a_var and fails this test
          [x] C3 NON-DUPLICATIVE: the skip test only observes the END state, which an unstaged restore also satisfies
          [x] C4 NOT FUTURE-EDIT: bounds the staging the runner performs today

        CONTRACT TRACEABILITY:
        - Enforces: INV-RESTORE-PURITY-1 (observed during restore), POST-RESTORE-SKIP-1 (the contract's validate_restore_outcome
          accounts for every container key)
        - Risk tier: High - a half-restored namespace after a later failure is silent corruption
        """
        container = {"a_var": dill.dumps(1), "b_var": dill.dumps(_NamespaceProbe())}
        with open(self.snapshot_path, "wb") as fh:
            dill.dump(container, fh)

        result = rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)

        assert self.ns.get("a_var") == 1 and "b_var" in self.ns, "restore did not bind both variables"
        assert self.ns["b_var"] == 0, (
            "INV-RESTORE-PURITY-1 violation: user_ns already held a_var while b_var was still being rebuilt\n"
            "EXPECTED: user_ns mutated only after every container variable has been evaluated and staged\n"
            f"ACTUAL: b_var observed a_var bound during restore (probe={self.ns['b_var']})\n"
            "GUIDANCE: the namespace is untouched until the whole container has been rebuilt"
        )
        outcome = RestoreOutcome(
            restored_names=tuple(result["restoredNames"]),
            skipped=tuple(
                SkippedVariableRecord(name=s["name"], reason=s["reason"], error_type=s["error_type"])
                for s in result["skipped"]
            ),
        )
        assert validate_restore_outcome(outcome, total_container_keys=2) is True

    def test_contract_alignment_runner_constants_and_validator_falsifiability(self):
        """
        CL11-F bridge (tests are the only link between contract and implementation): the runner redeclares its excluded
        names independently and must equal the contract's set; the contract's accounting predicate must reject an
        outcome that loses a variable (so the predicate used above is itself falsifiable).

        CONTRACT TRACEABILITY:
        - Enforces: POST-NAME-FILTER-1 (value alignment), POST-RESTORE-SKIP-1 (predicate falsifiability)
        - Category: contract/implementation alignment, supporting (not RED)
        """
        assert rlm_kernel_runner._EXCLUDED_SNAPSHOT_NAMES == EXCLUDED_BUILTIN_NAMES, (
            "POST-NAME-FILTER-1 violation: the runner's excluded names diverge from the contract\n"
            f"EXPECTED: {sorted(EXCLUDED_BUILTIN_NAMES)}\nACTUAL: {sorted(rlm_kernel_runner._EXCLUDED_SNAPSHOT_NAMES)}"
        )
        try:
            validate_restore_outcome(RestoreOutcome(restored_names=(), skipped=()), total_container_keys=2)
        except _contract_mod.NamespacePurityViolationError:
            return
        raise AssertionError("POST-RESTORE-SKIP-1 violation: the contract predicate accepted an outcome that lost two variables")


if __name__ == "__main__":
    unittest.main()
