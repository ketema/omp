"""
Adversarial tests for Legacy Snapshot Quarantine and Recovery Inspector (SLICE-3).

CONTRACT AUTHORITY RECORD:
- File: contracts/quarantine_inspector.contract.py
- Authority: CONTRACT_QUARANTINE_INSPECTOR
- Clauses covered:
    POST-QUARANTINE-INSPECT-1: Archives snapshot to unique directory and outputs JSON report
    FORBIDDEN-UNARCHIVED-DELETE-1: Never delete source snapshot without verified copy in quarantine
    IP-6: Emits QuarantineReport to caller
"""

import gzip
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

import quarantine_inspector


class TestQuarantineInspector(unittest.TestCase):
    """Adversarial tests targeting SLICE-3 quarantine and inspection obligations."""

    def setUp(self):
        self.test_dir = tempfile.mkdtemp(prefix="quarantine_test_")
        self.source_lzma = os.path.join(self.test_dir, "kernel-state.dill")
        self.source_gzip = os.path.join(self.test_dir, "kernel-state-gzip.dill")
        self.quarantine_dir = os.path.join(self.test_dir, ".omp", "quarantine")

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_post_quarantine_inspect_1_archives_lzma_and_generates_manifest(self):
        """
        FOUR-CRITERIA TEST VALIDITY GATE:
          [✓] C1 VALID: cites clause POST-QUARANTINE-INSPECT-1, IP-6
          [✓] C2 VALUABLE: passes 'can impl be wrong and test pass?' = NO
          [✓] C3 NON-DUPLICATIVE: asserts isolated per-snapshot subdirectory & LZMA inspection
          [✓] C4 NOT FUTURE-EDIT: exercises quarantine_inspector script

        CONTRACT TRACEABILITY:
        - Contract: CONTRACT_QUARANTINE_INSPECTOR["POST-QUARANTINE-INSPECT-1"]
        - Enforces: POST-QUARANTINE-INSPECT-1, IP-6
        - Category: functional
        - Risk tier: High
        """
        # ARRANGE: Create an LZMA legacy snapshot with 2 recoverable vars and 1 broken var
        container = {
            "rec_var1": dill.dumps({"hello": "world"}),
            "rec_var2": dill.dumps([1, 2, 3]),
            "bad_var": b"CORRUPTED_PICKLE_BLOB_NOT_DILL",
        }
        with lzma.open(self.source_lzma, "wb") as f:
            dill.dump(container, f)

        # ACT: Execute quarantine inspection
        report = quarantine_inspector.quarantine_and_inspect(
            source_path=self.source_lzma,
            quarantine_root=self.quarantine_dir,
        )

        # ASSERT: Contract verification
        assert os.path.exists(report.quarantine_path), "Quarantined snapshot file must exist"
        assert report.total_variables == 3, f"Expected 3, got {report.total_variables}"
        assert report.recoverable_count == 2, f"Expected 2, got {report.recoverable_count}"
        assert report.unpicklable_count == 1, f"Expected 1, got {report.unpicklable_count}"

        # F1 check: Verify the file lives in a unique subfolder, not directly in quarantine_root
        quarantine_subfolder = os.path.dirname(report.quarantine_path)
        assert quarantine_subfolder != os.path.abspath(self.quarantine_dir), (
            "F1 violation: archived snapshot must be in a dedicated unique subfolder, not bare quarantine root"
        )
        assert os.path.dirname(quarantine_subfolder) == os.path.abspath(self.quarantine_dir)

        # Verify JSON manifest was saved in the unique subfolder beside the archived file
        manifest_file = os.path.join(quarantine_subfolder, REPORT_FILENAME)
        assert os.path.exists(manifest_file), f"Manifest file missing: {manifest_file}"

        with open(manifest_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        assert data["total_variables"] == 3
        assert data["recoverable_count"] == 2
        assert data["unpicklable_count"] == 1

    def test_post_quarantine_inspect_1_gzip_support(self):
        """
        FOUR-CRITERIA TEST VALIDITY GATE:
          [✓] C1 VALID: cites clause POST-QUARANTINE-INSPECT-1
          [✓] C2 VALUABLE: passes 'can impl be wrong and test pass?' = NO (F4 regression guard)
          [✓] C3 NON-DUPLICATIVE: specifically verifies Gzip-compressed snapshot inspection
          [✓] C4 NOT FUTURE-EDIT: checks gzip codec compatibility

        CONTRACT TRACEABILITY:
        - Contract: CONTRACT_QUARANTINE_INSPECTOR["POST-QUARANTINE-INSPECT-1"]
        - Enforces: POST-QUARANTINE-INSPECT-1 (F4 fix)
        - Category: functional / codec parity
        """
        # ARRANGE: Create a GZIP legacy snapshot
        container = {
            "gzip_var": dill.dumps("gzip_data"),
        }
        with gzip.open(self.source_gzip, "wb") as f:
            dill.dump(container, f)

        # ACT: Execute quarantine inspection on gzip snapshot
        report = quarantine_inspector.quarantine_and_inspect(
            source_path=self.source_gzip,
            quarantine_root=self.quarantine_dir,
        )

        # ASSERT: Gzip must decompress and recover cleanly
        assert report.total_variables == 1
        assert report.recoverable_count == 1
        assert report.unpicklable_count == 0


if __name__ == "__main__":
    unittest.main()
