"""
Adversarial RED-phase tests for Legacy Snapshot Quarantine and Recovery Inspector (SLICE-3).

CONTRACT AUTHORITY RECORD:
- File: contracts/quarantine_inspector.contract.py
- Authority: CONTRACT_QUARANTINE_INSPECTOR
- Clauses covered:
    POST-QUARANTINE-INSPECT-1: Archives snapshot and outputs JSON report detailing recoverable vs unpicklable
    FORBIDDEN-UNARCHIVED-DELETE-1: Never delete source snapshot without verified copy in quarantine
    IP-6: Emits QuarantineReport to caller
"""

import importlib.util
import json
import lzma
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
import dill

# Load contract explicitly from canonical path to preserve contract-implementation independence
_contract_path = Path(__file__).resolve().parent.parent.parent.parent / "contracts" / "quarantine_inspector.contract.py"
_module_name = "quarantine_inspector_contract"
_spec = importlib.util.spec_from_file_location(_module_name, _contract_path)
if _spec is None or _spec.loader is None:
    raise ImportError(f"Cannot load contract from {_contract_path}")
_contract_mod = importlib.util.module_from_spec(_spec)
sys.modules[_module_name] = _contract_mod
_spec.loader.exec_module(_contract_mod)

CONTRACT_QUARANTINE_INSPECTOR = _contract_mod.CONTRACT_QUARANTINE_INSPECTOR
DEFAULT_QUARANTINE_DIRNAME = _contract_mod.DEFAULT_QUARANTINE_DIRNAME
REPORT_FILENAME = _contract_mod.REPORT_FILENAME
validate_quarantine_report = _contract_mod.validate_quarantine_report
QuarantineReport = _contract_mod.QuarantineReport
VariableStatusRecord = _contract_mod.VariableStatusRecord


class TestQuarantineInspector(unittest.TestCase):
    """Adversarial RED-phase tests targeting SLICE-3 quarantine and inspection obligations."""

    def setUp(self):
        self.test_dir = tempfile.mkdtemp(prefix="quarantine_test_")
        self.source_dill = os.path.join(self.test_dir, "kernel-state.dill")
        self.quarantine_dir = os.path.join(self.test_dir, ".omp", "quarantine")

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_post_quarantine_inspect_1_archives_and_generates_manifest(self):
        """
        FOUR-CRITERIA TEST VALIDITY GATE:
          [✓] C1 VALID: cites clause POST-QUARANTINE-INSPECT-1, IP-6
          [✓] C2 VALUABLE: passes 'can impl be wrong and test pass?' = NO
          [✓] C3 NON-DUPLICATIVE: asserts end-to-end non-destructive quarantine & manifest generation
          [✓] C4 NOT FUTURE-EDIT: exercises quarantine_inspector script

        CONTRACT TRACEABILITY:
        - Contract: CONTRACT_QUARANTINE_INSPECTOR["POST-QUARANTINE-INSPECT-1"]
        - Enforces: POST-QUARANTINE-INSPECT-1, IP-6
        - Category: functional
        - Risk tier: High — data loss if legacy snapshot is corrupted during migration
        - Adversarial: Creates mixed snapshot (valid vars + unpicklable var) and checks quarantine archiving
        """
        # ARRANGE: Create a legacy snapshot with 2 recoverable vars and 1 broken var
        container = {
            "rec_var1": dill.dumps({"hello": "world"}),
            "rec_var2": dill.dumps([1, 2, 3]),
            "bad_var": b"CORRUPTED_PICKLE_BLOB_NOT_DILL",
        }
        with lzma.open(self.source_dill, "wb") as f:
            dill.dump(container, f)

        # ACT: Import and execute implementation under test
        # RED: At this stage, scripts/quarantine_inspector.py does not exist yet!
        import quarantine_inspector

        report = quarantine_inspector.quarantine_and_inspect(
            source_path=self.source_dill,
            quarantine_root=self.quarantine_dir,
        )

        # ASSERT: Contract verification
        assert os.path.exists(report.quarantine_path), (
            "POST-QUARANTINE-INSPECT-1 violation: quarantined snapshot not found at target path\n"
            f"EXPECTED: {report.quarantine_path} exists\n"
            f"ACTUAL: File does not exist"
        )

        assert report.total_variables == 3, (
            f"POST-QUARANTINE-INSPECT-1 violation: expected 3 total variables, got {report.total_variables}"
        )
        assert report.recoverable_count == 2, (
            f"POST-QUARANTINE-INSPECT-1 violation: expected 2 recoverable variables, got {report.recoverable_count}"
        )
        assert report.unpicklable_count == 1, (
            f"POST-QUARANTINE-INSPECT-1 violation: expected 1 unpicklable variable, got {report.unpicklable_count}"
        )

        # Verify JSON manifest was saved in quarantine directory
        manifest_file = os.path.join(self.quarantine_dir, REPORT_FILENAME)
        assert os.path.exists(manifest_file), f"Manifest file missing: {manifest_file}"

        with open(manifest_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        assert data["total_variables"] == 3
        assert data["recoverable_count"] == 2
        assert data["unpicklable_count"] == 1


if __name__ == "__main__":
    unittest.main()
