"""Adversarial tests for the file-handle guard on snapshot write, restore and quarantine inspection.

CONTRACT AUTHORITY RECORD:
- Contracts: contracts/rlm_dill_resilient_restore.contract.py, contracts/quarantine_inspector.contract.py
- Clauses covered: POST-NOHANDLE-1, POST-NOOPEN-1, ERRORS-HANDLECONTAINER-1, FORBIDDEN-HANDLEOPEN-1 (restore, write)
  and POST-QNOOPEN-1, ERRORS-QHANDLECONTAINER-1 (quarantine inspection)

Every fixture is generated here, in a unique temporary directory, from synthetic data: the "sentinel" file is created by
the test, the snapshots are written by the test, and nothing outside that directory is read, opened or written. dill
reopens a file handle's path (truncating a write-mode file) BEFORE it applies the closed flag, so each test that restores
or inspects a handle blob proves the sentinel's bytes are unchanged afterwards. The guard is an accidental-I/O guard under
the runner's existing permissions; no test claims it sandboxes arbitrary pickles.
"""

from __future__ import annotations

import importlib.util
import lzma
import os
import shutil
import sys
import tempfile
import types
import unittest
from pathlib import Path

import dill

_CONTRACTS = Path(__file__).resolve().parent.parent.parent.parent / "contracts"


def _load_contract(file_name: str, module_name: str) -> types.ModuleType:
    spec = importlib.util.spec_from_file_location(module_name, _CONTRACTS / file_name)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load contract from {_CONTRACTS / file_name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


_restore_contract = _load_contract("rlm_dill_resilient_restore.contract.py", "rlm_dill_handle_guard_restore_contract")
_quarantine_contract = _load_contract("quarantine_inspector.contract.py", "rlm_dill_handle_guard_quarantine_contract")

import quarantine_inspector
import rlm_kernel_runner
from rlm_kernel_runner import CorruptSnapshotError

SENTINEL_BYTES = b"S" * 48


def _closed_handle_blob(path: str) -> bytes:
    """dill's serialization of a CLOSED write-mode handle on `path` (own fixture; the path is truncated by open())."""
    handle = open(path, "w")  # noqa: SIM115 - the handle IS the fixture
    handle.close()
    blob = dill.dumps(handle)
    assert b"_create_filehandle" in blob, "fixture precondition: the blob must reconstruct a file handle"
    return blob


def _closed_handle(path: str):
    handle = open(path, "w")  # noqa: SIM115
    handle.close()
    return handle


class _GuardCase(unittest.TestCase):
    def setUp(self) -> None:
        self.test_dir = tempfile.mkdtemp(prefix="rlm_handle_guard_")
        self.sentinel = os.path.join(self.test_dir, "sentinel.txt")
        self.snapshot_path = os.path.join(self.test_dir, "kernel-state.dill")
        self.manifest_path = os.path.join(self.test_dir, "kernel-state.json")
        self.ns = rlm_kernel_runner._get_ns()
        self.ns.clear()

    def tearDown(self) -> None:
        self.ns.clear()
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def arm_sentinel(self) -> bytes:
        """Fill the sentinel AFTER any fixture handle was opened on it, so a later open('w') would visibly truncate it."""
        with open(self.sentinel, "wb") as fh:
            fh.write(SENTINEL_BYTES)
        return SENTINEL_BYTES

    def sentinel_bytes(self) -> bytes:
        with open(self.sentinel, "rb") as fh:
            return fh.read()

    def write_snapshot(self, container: dict, *, codec: str = "lzma") -> None:
        if codec == "lzma":
            with lzma.open(self.snapshot_path, "wb") as fh:
                dill.dump(container, fh)
        else:
            with open(self.snapshot_path, "wb") as fh:
                dill.dump(container, fh)


class TestRestoreRefusesHandleBlobs(_GuardCase):
    def test_post_noopen_1_legacy_handle_variable_is_skipped_and_the_file_it_named_is_untouched(self) -> None:
        """
        FOUR-CRITERIA TEST VALIDITY GATE:
          [x] C1 VALID: cites POST-NOOPEN-1 and FORBIDDEN-HANDLEOPEN-1
          [x] C2 VALUABLE: a restore that dill.loads the handle blob truncates the sentinel (48 -> 0) and fails this test
          [x] C3 NON-DUPLICATIVE: no other test restores a handle blob; POST-RESTORE-SKIP-1 tests use unpicklable values
          [x] C4 NOT FUTURE-EDIT: bounds the restore the runner performs today
        Risk tier: High - this is the destructive recipe seen in incidents.
        """
        handle_blob = _closed_handle_blob(self.sentinel)
        before = self.arm_sentinel()
        self.write_snapshot({"healthy": dill.dumps(41), "fh": handle_blob})

        result = rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)

        after = self.sentinel_bytes()
        try:
            _restore_contract.validate_no_open_effect(before, after)
        except _restore_contract.UnsafeReconstructionContractError as exc:
            raise AssertionError(
                "FORBIDDEN-HANDLEOPEN-1 violation: restoring a handle blob changed the file it named\n"
                f"EXPECTED: {len(before)} unchanged bytes\nACTUAL: {exc}\n"
                "GUIDANCE: a file-handle reconstruction is refused before any path is opened"
            ) from exc
        skipped = tuple(
            _restore_contract.SkippedVariableRecord(name=s["name"], reason=s["reason"], error_type=s["error_type"])
            for s in result["skipped"]
        )
        try:
            _restore_contract.validate_handle_refusal(skipped, "fh")
        except _restore_contract.UnsafeReconstructionContractError as exc:
            raise AssertionError(
                "POST-NOOPEN-1 violation: the refused handle is not reported as required\n"
                f"EXPECTED: one skipped record for 'fh' naming a file handle as UnsafeReconstructionError\nACTUAL: {exc}\n"
                f"RAW SKIPPED: {result['skipped']}"
            ) from exc
        assert result["restoredNames"] == ["healthy"], (
            "POST-NOOPEN-1 violation: the healthy sibling must still be restored\n"
            f"EXPECTED: ['healthy']\nACTUAL: {result['restoredNames']}"
        )
        assert self.ns.get("healthy") == 41 and "fh" not in self.ns, (
            "POST-NOOPEN-1 violation: namespace holds the wrong variables\n"
            f"EXPECTED: healthy=41 and no 'fh'\nACTUAL: {sorted(self.ns)}"
        )

    def test_post_noopen_1_nested_handles_in_containers_and_objects_are_refused(self) -> None:
        """
        FOUR-CRITERIA TEST VALIDITY GATE:
          [x] C1 VALID: cites POST-NOOPEN-1 (nested handles) and FORBIDDEN-HANDLEOPEN-1
          [x] C2 VALUABLE: a guard that inspects only top-level handle objects misses these and truncates the sentinel
          [x] C3 NON-DUPLICATIVE: the direct-handle test cannot see a nested one
          [x] C4 NOT FUTURE-EDIT: bounds the restore the runner performs today
        Risk tier: High - a handle held by a dict, list, tuple or object attribute is the common real shape.
        """
        handle = _closed_handle(self.sentinel)
        values = {
            "in_list": [handle],
            "in_dict": {"k": {"deeper": [handle, 1]}},
            "in_tuple": (1, (handle,)),
            "in_attr": types.SimpleNamespace(f=handle, n=2),
            # the constructor's name was already pushed as text, so the global reads it back through the pickle memo
            "after_same_text": ["_create_filehandle", "dill._dill", handle],
        }
        blobs = {name: dill.dumps(value) for name, value in values.items()}
        for name, blob in blobs.items():
            assert b"_create_filehandle" in blob, f"fixture precondition: {name} must reconstruct a file handle"
        before = self.arm_sentinel()
        self.write_snapshot({**blobs, "healthy": dill.dumps("ok")})

        result = rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)

        assert self.sentinel_bytes() == before, (
            "FORBIDDEN-HANDLEOPEN-1 violation: a nested handle was reopened\n"
            f"EXPECTED: {len(before)} unchanged bytes\nACTUAL: {len(self.sentinel_bytes())} bytes\n"
            "GUIDANCE: nested handles are refused the same way as direct ones"
        )
        skipped = tuple(
            _restore_contract.SkippedVariableRecord(name=s["name"], reason=s["reason"], error_type=s["error_type"])
            for s in result["skipped"]
        )
        for name in blobs:
            _restore_contract.validate_handle_refusal(skipped, name)
        assert result["restoredNames"] == ["healthy"], (
            f"POST-NOOPEN-1 violation: expected only the healthy sibling restored, got {result['restoredNames']}"
        )

    def test_post_noopen_1_a_string_that_merely_mentions_the_reconstructor_is_still_restored(self) -> None:
        """
        FOUR-CRITERIA TEST VALIDITY GATE:
          [x] C1 VALID: cites POST-NOOPEN-1 (refusal is for a reconstructor reference, not a substring)
          [x] C2 VALUABLE: a byte-substring guard refuses user text that names the function and fails this test
          [x] C3 NON-DUPLICATIVE: the refusal tests only prove what is refused
          [x] C4 NOT FUTURE-EDIT: bounds the guard's precision today
        Risk tier: Medium - a false refusal silently drops user data.
        """
        text = "notes: dill._dill._create_filehandle reopens a path"
        self.write_snapshot({"note": dill.dumps(text), "also": dill.dumps(["_create_filehandle"])})

        result = rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)

        assert result["skipped"] == [], f"POST-NOOPEN-1 violation: plain text was refused: {result['skipped']}"
        assert self.ns.get("note") == text and self.ns.get("also") == ["_create_filehandle"], (
            f"POST-NOOPEN-1 violation: text variables were not restored: {sorted(self.ns)}"
        )

    def test_errors_handlecontainer_1_a_handle_in_the_container_rejects_the_snapshot_before_anything_opens(self) -> None:
        """
        FOUR-CRITERIA TEST VALIDITY GATE:
          [x] C1 VALID: cites ERRORS-HANDLECONTAINER-1 and FORBIDDEN-HANDLEOPEN-1
          [x] C2 VALUABLE: loading the container reconstructs the handle and truncates the sentinel; fails this test
          [x] C3 NON-DUPLICATIVE: the per-variable tests cannot reach a container-level reference
          [x] C4 NOT FUTURE-EDIT: bounds the restore the runner performs today
        Risk tier: High - there is no per-variable boundary to skip at.
        """
        handle = _closed_handle(self.sentinel)
        before = self.arm_sentinel()
        self.write_snapshot({"healthy": dill.dumps(1), "fh_at_top": handle})

        with self.assertRaises(CorruptSnapshotError) as raised:
            rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)

        assert "file handle" in str(raised.exception), (
            "ERRORS-HANDLECONTAINER-1 violation: the rejection does not name a file handle\n"
            f"EXPECTED: message containing 'file handle'\nACTUAL: {raised.exception}"
        )
        assert self.sentinel_bytes() == before, (
            "FORBIDDEN-HANDLEOPEN-1 violation: the container's handle was reopened before rejection\n"
            f"EXPECTED: {len(before)} unchanged bytes\nACTUAL: {len(self.sentinel_bytes())} bytes"
        )
        assert self.ns == {}, f"ERRORS-HANDLECONTAINER-1 violation: namespace was mutated: {sorted(self.ns)}"


class TestWriteNeverSerializesHandles(_GuardCase):
    def test_post_nohandle_1_live_closed_and_nested_handles_are_skipped_at_write_with_a_named_reason(self) -> None:
        """
        FOUR-CRITERIA TEST VALIDITY GATE:
          [x] C1 VALID: cites POST-NOHANDLE-1
          [x] C2 VALUABLE: a producer that serializes handles writes them into the payload and fails this test
          [x] C3 NON-DUPLICATIVE: restore-side tests cannot show what the producer wrote
          [x] C4 NOT FUTURE-EDIT: bounds the write the runner performs today
        Risk tier: High - the producer is how the destructive recipe is created.
        """
        with open(self.sentinel, "wb") as fh:
            fh.write(SENTINEL_BYTES)
        live = open(self.sentinel, "rb")  # noqa: SIM115 - a live handle is the fixture
        self.addCleanup(live.close)
        self.ns["live"] = live
        self.ns["closed"] = _closed_handle(os.path.join(self.test_dir, "other.txt"))
        self.ns["nested"] = {"inner": [live]}
        self.ns["healthy"] = 41

        rlm_kernel_runner._snapshot_write(self.snapshot_path, self.manifest_path, 100 * 1024 * 1024, force_codec="raw")

        with open(self.snapshot_path, "rb") as fh:
            written = dill.load(fh)
        assert sorted(written) == ["healthy"], (
            "POST-NOHANDLE-1 violation: handles were written into the payload\n"
            f"EXPECTED: ['healthy']\nACTUAL: {sorted(written)}"
        )
        import json

        with open(self.manifest_path, encoding="utf-8") as fh:
            manifest = json.load(fh)
        skipped = tuple(
            _restore_contract.SkippedVariableRecord(name=s["name"], reason=s["reason"], error_type="UnsafeReconstructionError")
            for s in manifest["skipped"]
        )
        for name in ("live", "closed", "nested"):
            try:
                _restore_contract.validate_handle_refusal(skipped, name)
            except _restore_contract.UnsafeReconstructionContractError as exc:
                raise AssertionError(
                    f"POST-NOHANDLE-1 violation: {name!r} is not reported as skipped for a file handle\n"
                    f"EXPECTED: a skipped record whose reason names a file handle\nACTUAL: {exc}\n"
                    f"MANIFEST SKIPPED: {manifest['skipped']}"
                ) from exc
        assert manifest["savedNames"] == ["healthy"], f"POST-NOHANDLE-1 violation: savedNames={manifest['savedNames']}"

    def test_post_nohandle_1_the_snapshot_round_trips_the_healthy_variable_without_touching_the_handle_path(self) -> None:
        """
        FOUR-CRITERIA TEST VALIDITY GATE:
          [x] C1 VALID: cites POST-NOHANDLE-1 and FORBIDDEN-HANDLEOPEN-1 end to end
          [x] C2 VALUABLE: a producer/restore pair that carries the handle truncates the sentinel on the round trip
          [x] C3 NON-DUPLICATIVE: composes the producer with the real restore
          [x] C4 NOT FUTURE-EDIT: bounds the round trip the runner performs today
        Risk tier: High
        """
        handle = _closed_handle(self.sentinel)
        before = self.arm_sentinel()
        self.ns["fh"] = handle
        self.ns["healthy"] = {"a": 1}
        rlm_kernel_runner._snapshot_write(self.snapshot_path, self.manifest_path, 100 * 1024 * 1024)
        self.ns.clear()

        result = rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)

        assert self.sentinel_bytes() == before, (
            "FORBIDDEN-HANDLEOPEN-1 violation: a write/restore round trip changed the file a handle named\n"
            f"EXPECTED: {len(before)} unchanged bytes\nACTUAL: {len(self.sentinel_bytes())} bytes"
        )
        assert result["restoredNames"] == ["healthy"] and self.ns["healthy"] == {"a": 1}, (
            f"POST-NOHANDLE-1 violation: healthy variable did not round-trip: {result['restoredNames']}"
        )


class TestQuarantineRefusesHandleBlobs(_GuardCase):
    def test_post_qnoopen_1_inspection_reports_a_handle_unpicklable_and_leaves_the_file_untouched(self) -> None:
        """
        FOUR-CRITERIA TEST VALIDITY GATE:
          [x] C1 VALID: cites POST-QNOOPEN-1 and the contract's own report validator
          [x] C2 VALUABLE: an inspector that dill.loads every blob truncates the sentinel and fails this test
          [x] C3 NON-DUPLICATIVE: the SyntaxError test only proves sibling continuation
          [x] C4 NOT FUTURE-EDIT: bounds the inspection the inspector performs today
        Risk tier: High - inspection that destroys a file is the opposite of forensics.
        """
        blobs = {
            "fh": _closed_handle_blob(self.sentinel),
            "nested": dill.dumps({"x": [_closed_handle(self.sentinel)]}),
            "healthy": dill.dumps(41),
        }
        before = self.arm_sentinel()
        self.write_snapshot(blobs)
        quarantine_root = os.path.join(self.test_dir, ".omp", "quarantine")

        report = quarantine_inspector.quarantine_and_inspect(self.snapshot_path, quarantine_root)

        assert self.sentinel_bytes() == before, (
            "POST-QNOOPEN-1 violation: inspection changed the file a handle named\n"
            f"EXPECTED: {len(before)} unchanged bytes\nACTUAL: {len(self.sentinel_bytes())} bytes\n"
            "GUIDANCE: a file-handle reconstruction is refused before any path is opened"
        )
        status = {v.name: v for v in report.variables}
        for name in ("fh", "nested"):
            assert status[name].status == "unpicklable" and _restore_contract.HANDLE_REASON_MARKER in (
                status[name].error or ""
            ), (
                f"POST-QNOOPEN-1 violation: {name!r} must be unpicklable with an error naming a file handle\n"
                f"ACTUAL: status={status[name].status!r} error={status[name].error!r}"
            )
        assert status["healthy"].status == "recoverable", "POST-QNOOPEN-1 violation: healthy sibling must stay recoverable"
        report_for_contract = _quarantine_contract.QuarantineReport(
            source_path=report.source_path,
            quarantine_path=report.quarantine_path,
            total_variables=report.total_variables,
            recoverable_count=report.recoverable_count,
            unpicklable_count=report.unpicklable_count,
            variables=tuple(
                _quarantine_contract.VariableStatusRecord(name=v.name, status=v.status, type_name=v.type_name, error=v.error)
                for v in report.variables
            ),
        )
        _quarantine_contract.validate_quarantine_report(report_for_contract)
        assert (report.recoverable_count, report.unpicklable_count) == (1, 2), (
            f"POST-QNOOPEN-1 violation: expected 1 recoverable and 2 unpicklable, got {report.recoverable_count}/{report.unpicklable_count}"
        )

    def test_errors_qhandlecontainer_1_a_handle_in_the_container_raises_before_anything_opens(self) -> None:
        """
        FOUR-CRITERIA TEST VALIDITY GATE:
          [x] C1 VALID: cites ERRORS-QHANDLECONTAINER-1
          [x] C2 VALUABLE: loading the container reopens the handle's path; fails this test
          [x] C3 NON-DUPLICATIVE: per-variable inspection cannot reach a container-level reference
          [x] C4 NOT FUTURE-EDIT: bounds the inspection the inspector performs today
        Risk tier: High
        """
        handle = _closed_handle(self.sentinel)
        before = self.arm_sentinel()
        self.write_snapshot({"healthy": dill.dumps(1), "fh_at_top": handle}, codec="raw")
        quarantine_root = os.path.join(self.test_dir, ".omp", "quarantine")

        with self.assertRaises(quarantine_inspector.UnsafeReconstructionError) as raised:
            quarantine_inspector.quarantine_and_inspect(self.snapshot_path, quarantine_root)

        assert "file handle" in str(raised.exception), (
            f"ERRORS-QHANDLECONTAINER-1 violation: error must name a file handle, got {raised.exception}"
        )
        assert self.sentinel_bytes() == before, (
            "ERRORS-QHANDLECONTAINER-1 violation: the container's handle was reopened\n"
            f"EXPECTED: {len(before)} unchanged bytes\nACTUAL: {len(self.sentinel_bytes())} bytes"
        )
        archived = [p for p in Path(quarantine_root).rglob("kernel-state.dill")]
        assert len(archived) == 1, (
            "ERRORS-QHANDLECONTAINER-1 violation: the source must be archived before the refusal\n"
            f"EXPECTED: one archived copy\nACTUAL: {archived}"
        )


class TestBothConsumersRefuseTheWholeAuthoritySet(_GuardCase):
    def test_cross_inv_1_every_declared_reconstructor_is_refused_by_the_runner_and_by_the_inspector(self) -> None:
        """
        FOUR-CRITERIA TEST VALIDITY GATE:
          [x] C1 VALID: cites CROSS_INV-1 (both contracts) and POST-NOOPEN-1 / POST-QNOOPEN-1
          [x] C2 VALUABLE: a consumer that refuses only a subset of the authority's set fails for the missing name
          [x] C3 NON-DUPLICATIVE: the handle-blob tests exercise dill's real handle blob; this one iterates the AUTHORITY's
              set, so a reconstructor added to it is covered without editing a test
          [x] C4 NOT FUTURE-EDIT: it fails only when a declared name is not refused
        """
        for name in sorted(_restore_contract.FILE_HANDLE_RECONSTRUCTORS):
            # A protocol-0 GLOBAL reference to the reconstructor: scanned, never loaded
            stream = b"cdill._dill\n" + name.encode() + b"\n."
            self.write_snapshot({"refused": stream, "kept": dill.dumps(7)})

            restored = rlm_kernel_runner._snapshot_restore(self.snapshot_path, self.manifest_path)
            skipped = tuple(
                _restore_contract.SkippedVariableRecord(name=s["name"], reason=s["reason"], error_type=s["error_type"])
                for s in restored["skipped"]
            )
            try:
                _restore_contract.validate_handle_refusal(skipped, "refused")
            except _restore_contract.UnsafeReconstructionContractError as exc:
                raise AssertionError(f"CROSS_INV-1 violation: the runner did not refuse {name!r}: {exc}") from exc
            assert restored["restoredNames"] == ["kept"], f"CROSS_INV-1 violation: runner restored {restored['restoredNames']}"
            self.ns.clear()

            report = quarantine_inspector.quarantine_and_inspect(
                self.snapshot_path, os.path.join(self.test_dir, "quarantine", name)
            )
            status = {v.name: v for v in report.variables}
            assert status["refused"].status == "unpicklable" and _restore_contract.HANDLE_REASON_MARKER in (
                status["refused"].error or ""
            ), f"CROSS_INV-1 violation: the inspector did not refuse {name!r}: {status['refused']}"
            assert status["kept"].status == "recoverable", "CROSS_INV-1 violation: the inspector lost the healthy sibling"


class TestGuardAlignsWithTheContracts(unittest.TestCase):
    def test_one_authority_declares_the_reconstructor_set_and_every_consumer_shares_one_scanner(self) -> None:
        """
        FOUR-CRITERIA TEST VALIDITY GATE (CL11-C single authority, CL11-F alignment; no production import of a contract):
          [x] C1 VALID: cites POST-NOOPEN-1, POST-QNOOPEN-1 and CROSS_INV-1
          [x] C2 VALUABLE: a second declaration of the set, a quarantine contract that stops referencing the authority, a
              non-reciprocal CROSS_INV-1, or a consumer carrying its own scanner copy each fail
          [x] C3 NON-DUPLICATIVE: only test comparing the contracts' linkage with the production declarations
          [x] C4 NOT FUTURE-EDIT: bounds the declarations present today
        """
        import rlm_pickle_guard  # the ONE production declaration the runner and the inspector share

        for name in ("FILE_HANDLE_RECONSTRUCTORS", "HANDLE_REASON_MARKER"):
            assert not hasattr(_quarantine_contract, name), (
                f"CL11-C violation: the quarantine contract redeclares {name}; the restore contract is the single authority"
            )
        for label, reference in _quarantine_contract.DEPENDS_ON.items():
            path, clause = reference.split("::")
            assert path == "contracts/rlm_dill_resilient_restore.contract.py", f"DEPENDS_ON {label} names {path}"
            assert clause in _restore_contract.CONTRACT_RLM_DILL_RESILIENT_RESTORE, (
                f"DEPENDS_ON {label} names {clause}, which the authority does not declare"
            )
        restore_cross = _restore_contract.CONTRACT_RLM_DILL_RESILIENT_RESTORE["CROSS_INV-1"].description
        quarantine_cross = _quarantine_contract.CONTRACT_QUARANTINE_INSPECTOR["CROSS_INV-1"].description
        assert restore_cross == quarantine_cross, "CROSS_INV-1 is not reciprocal: the two contracts word it differently"
        for participant in (
            "contracts/rlm_dill_resilient_restore.contract.py",
            "contracts/quarantine_inspector.contract.py",
        ):
            assert participant in restore_cross, f"CROSS_INV-1 does not name its participant {participant}"

        assert rlm_pickle_guard.FILE_HANDLE_RECONSTRUCTORS == _restore_contract.FILE_HANDLE_RECONSTRUCTORS, (
            "POST-NOOPEN-1 violation: the production reconstructor set differs from the authority\n"
            f"EXPECTED: {sorted(_restore_contract.FILE_HANDLE_RECONSTRUCTORS)}\n"
            f"ACTUAL: {sorted(rlm_pickle_guard.FILE_HANDLE_RECONSTRUCTORS)}"
        )
        for consumer in (rlm_kernel_runner, quarantine_inspector):
            assert consumer.references_file_handle_reconstructor is rlm_pickle_guard.references_file_handle_reconstructor, (
                f"{consumer.__name__} carries its own scanner instead of the shared one"
            )
            assert consumer.FILE_HANDLE_RECONSTRUCTORS is rlm_pickle_guard.FILE_HANDLE_RECONSTRUCTORS, (
                f"{consumer.__name__} redeclares the reconstructor set instead of sharing it"
            )
        assert rlm_kernel_runner.UNSAFE_RECONSTRUCTION_ERROR_TYPE == _restore_contract.UNSAFE_RECONSTRUCTION_ERROR_TYPE, (
            "POST-NOOPEN-1 violation: the error type a refused variable carries differs from the contract\n"
            f"EXPECTED: {_restore_contract.UNSAFE_RECONSTRUCTION_ERROR_TYPE!r}\n"
            f"ACTUAL: {rlm_kernel_runner.UNSAFE_RECONSTRUCTION_ERROR_TYPE!r}"
        )

    def test_every_reconstructor_in_the_pinned_dill_that_opens_a_path_is_declared(self) -> None:
        """
        FOUR-CRITERIA TEST VALIDITY GATE:
          [x] C1 VALID: cites POST-NOOPEN-1 (the declared set must cover dill's path-opening reconstructors)
          [x] C2 VALUABLE: a dill upgrade adding a path-opening reconstructor the guard does not know fails this test
          [x] C3 NON-DUPLICATIVE: the only check of the set against the installed dill
          [x] C4 NOT FUTURE-EDIT: it reads the installed dill, not a copy
        """
        import inspect

        import dill._dill as dill_internals

        opening = set()
        for name, obj in vars(dill_internals).items():
            if name.startswith("_create_") and inspect.isfunction(obj):
                source = inspect.getsource(obj)
                if "open(" in source and "tempfile" not in source.replace("import tempfile", ""):
                    opening.add(name)
        assert opening <= set(_restore_contract.FILE_HANDLE_RECONSTRUCTORS), (
            "POST-NOOPEN-1 violation: the installed dill has path-opening reconstructors the contract does not declare\n"
            f"EXPECTED: {sorted(opening)} within {sorted(_restore_contract.FILE_HANDLE_RECONSTRUCTORS)}\n"
            f"ACTUAL missing: {sorted(opening - set(_restore_contract.FILE_HANDLE_RECONSTRUCTORS))}"
        )


if __name__ == "__main__":
    unittest.main()
