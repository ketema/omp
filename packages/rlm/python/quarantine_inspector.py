"""
Legacy Snapshot Quarantine and Forensic Recovery Inspector (SLICE-3).

Safely archives legacy unpartitioned kernel-state.dill snapshots to a dedicated
quarantine directory, non-destructively inspects their binary payload, and emits
a JSON manifest detailing recoverable vs unpicklable variables.

Contract Authority: contracts/quarantine_inspector.contract.py
Compliance: CL11-F (does not import from contract module; redeclares independent types).
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import shutil
import time
from dataclasses import asdict, dataclass
from typing import Any, Literal

import dill

# Default constants redeclared independently per CL11-F
DEFAULT_QUARANTINE_DIRNAME = ".omp/quarantine"
REPORT_FILENAME = "quarantine_manifest.json"

# Names that reconstruct a file handle (and so open a path) when a serialized variable is rebuilt. dill's
# _create_filehandle opens the path (truncating a write-mode file) BEFORE it applies the closed flag. Redeclared
# independently of the runner and of the contract (CL11-F); a test aligns the three declarations.
FILE_HANDLE_RECONSTRUCTORS = frozenset({"_create_filehandle"})

_NO_PUSH_OPCODES = frozenset({"PROTO", "FRAME", "MEMOIZE", "PUT", "BINPUT", "LONG_BINPUT"})
_MEMO_GET_OPCODES = frozenset({"GET", "BINGET", "LONG_BINGET"})
_STRING_PUSH_OPCODES = frozenset(
    {"SHORT_BINUNICODE", "BINUNICODE", "BINUNICODE8", "UNICODE", "STRING", "BINSTRING", "SHORT_BINSTRING"}
)


class UnsafeReconstructionError(Exception):
    """A serialized variable or container would reconstruct a file handle (POST-QNOOPEN-1, ERRORS-QHANDLECONTAINER-1)."""


def _references_file_handle_reconstructor(data: Any) -> bool:
    """True when the pickle stream `data` (bytes or a binary file object) references a file-handle reconstructor.

    Reads opcodes only and never unpickles. Looks only at how a global is named: GLOBAL's operand, or the two strings
    pushed immediately before STACK_GLOBAL (read through the memo). Plain text that merely mentions a name is not a
    reference. A stream that cannot be parsed further is judged on the opcodes read before the break.
    """
    import pickletools

    recent: list[Any] = []
    memo: dict[Any, Any] = {}
    memo_index = 0
    try:
        for opcode, arg, _position in pickletools.genops(data):
            name = opcode.name
            if name in _NO_PUSH_OPCODES:
                top = recent[-1] if recent else None
                if name == "MEMOIZE":
                    memo[memo_index] = top
                    memo_index += 1
                else:
                    memo[arg] = top
                continue
            value = None
            if name == "GLOBAL":
                if str(arg).rsplit(" ", 1)[-1] in FILE_HANDLE_RECONSTRUCTORS:
                    return True
            elif name == "STACK_GLOBAL":
                if len(recent) == 2 and recent[1] in FILE_HANDLE_RECONSTRUCTORS:
                    return True
            elif name in _STRING_PUSH_OPCODES:
                value = arg if isinstance(arg, str) else None
            elif name in _MEMO_GET_OPCODES:
                value = memo.get(arg)
            recent.append(value)
            del recent[:-2]
    except (ValueError, EOFError):
        return False
    return False


def _refuse_handle_container(path: str, codec: str) -> None:
    """ERRORS-QHANDLECONTAINER-1: reject a container that references a file-handle reconstructor, before loading it."""
    if codec == "lzma":
        import lzma

        with lzma.open(path, "rb") as fh:
            found = _references_file_handle_reconstructor(fh)
    elif codec == "gzip":
        with gzip.open(path, "rb") as fh:
            found = _references_file_handle_reconstructor(fh)
    else:
        with open(path, "rb") as fh:
            found = _references_file_handle_reconstructor(fh)
    if found:
        raise UnsafeReconstructionError(
            "snapshot container references a file handle; refused before any path was opened "
            "(a file handle cannot be restored without reopening its path)"
        )


@dataclass(frozen=True)
class VariableStatusRecord:
    """Record of an individual variable inspected in a legacy snapshot."""
    name: str
    status: Literal["recoverable", "unpicklable"]
    type_name: str
    error: str | None = None


@dataclass(frozen=True)
class QuarantineReport:
    """Forensic report of a quarantined legacy snapshot."""
    source_path: str
    quarantine_path: str
    total_variables: int
    recoverable_count: int
    unpicklable_count: int
    variables: tuple[VariableStatusRecord, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "source_path": self.source_path,
            "quarantine_path": self.quarantine_path,
            "total_variables": self.total_variables,
            "recoverable_count": self.recoverable_count,
            "unpicklable_count": self.unpicklable_count,
            "variables": [asdict(v) for v in self.variables],
        }


def _detect_and_load(path: str) -> dict[str, Any]:
    """Detect compression (LZMA, Gzip, or Raw) and load the snapshot payload dict (F4).

    Follows rlm_kernel_runner lazy codec import policy: lzma is imported on demand
    so environments lacking _lzma can still recover gzip and raw snapshots.
    """
    with open(path, "rb") as fh:
        header = fh.read(6)

    # Check for LZMA magic bytes 0xfd 7zXZ \x00
    if len(header) >= 6 and header[:6] == bytes([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]):
        try:
            import lzma
        except ImportError as exc:
            raise RuntimeError(f"LZMA decompression unsupported on this Python build (missing _lzma): {exc}") from exc
        _refuse_handle_container(path, "lzma")
        with lzma.open(path, "rb") as comp_fh:
            payload = dill.load(comp_fh)
    # Check for Gzip magic bytes 0x1f 0x8b (F4 fix)
    elif len(header) >= 2 and header[:2] == bytes([0x1f, 0x8b]):
        _refuse_handle_container(path, "gzip")
        with gzip.open(path, "rb") as comp_fh:
            payload = dill.load(comp_fh)
    else:
        _refuse_handle_container(path, "raw")
        with open(path, "rb") as raw_fh:
            payload = dill.load(raw_fh)

    if not isinstance(payload, dict):
        raise TypeError(f"Expected dict payload in snapshot, got {type(payload).__name__}")
    return payload


def quarantine_and_inspect(
    source_path: str,
    quarantine_root: str = DEFAULT_QUARANTINE_DIRNAME,
) -> QuarantineReport:
    """
    Safely archive a legacy snapshot and inspect its variables non-destructively.

    POST-QUARANTINE-INSPECT-1:
      Copies source_path to a dedicated unique subfolder under quarantine_root (F1 fix),
      inspects all variables (supporting LZMA, Gzip, Raw - F4 fix),
      and writes REPORT_FILENAME into that unique quarantine subfolder.
    FORBIDDEN-UNARCHIVED-DELETE-1:
      Source is never removed unless verified copy exists in quarantine.
    """
    if not os.path.exists(source_path):
        raise FileNotFoundError(f"Source snapshot not found: {source_path}")

    with open(source_path, "rb") as f:
        source_bytes = f.read()

    file_hash = hashlib.sha256(source_bytes).hexdigest()[:12]
    timestamp_ns = time.time_ns()
    unique_subfolder_name = f"{timestamp_ns}_{file_hash}"

    # F1 fix: Allocate an isolated per-snapshot quarantine directory
    quarantine_subfolder = os.path.join(quarantine_root, unique_subfolder_name)
    os.makedirs(quarantine_subfolder, exist_ok=True)
    quarantine_target = os.path.join(quarantine_subfolder, os.path.basename(source_path))

    # FORBIDDEN-UNARCHIVED-DELETE-1: Archive copy first before any inspection
    shutil.copy2(source_path, quarantine_target)

    # Inspect variables from the quarantined copy
    payload = _detect_and_load(quarantine_target)

    status_records: list[VariableStatusRecord] = []
    recoverable_count = 0
    unpicklable_count = 0

    for name in sorted(payload.keys()):
        blob = payload[name]
        try:
            if _references_file_handle_reconstructor(blob):
                # POST-QNOOPEN-1: refused BEFORE deserialization, so no path is opened (dill reopens a handle's path,
                # truncating a write-mode file, before it applies the closed flag). Siblings are still inspected.
                raise UnsafeReconstructionError(
                    "the serialized variable reconstructs a file handle; refused before any path was opened"
                )
            val = dill.loads(blob)
            type_name = type(val).__name__
            status_records.append(
                VariableStatusRecord(
                    name=name,
                    status="recoverable",
                    type_name=type_name,
                )
            )
            recoverable_count += 1
        except Exception as exc:  # noqa: BLE001
            status_records.append(
                VariableStatusRecord(
                    name=name,
                    status="unpicklable",
                    type_name="unknown",
                    error=f"{type(exc).__name__}: {exc}",
                )
            )
            unpicklable_count += 1

    report = QuarantineReport(
        source_path=os.path.abspath(source_path),
        quarantine_path=os.path.abspath(quarantine_target),
        total_variables=len(payload),
        recoverable_count=recoverable_count,
        unpicklable_count=unpicklable_count,
        variables=tuple(status_records),
    )

    # Write manifest report beside the archived file in the unique subfolder (F1 fix)
    manifest_path = os.path.join(quarantine_subfolder, REPORT_FILENAME)
    with open(manifest_path, "w", encoding="utf-8") as mfh:
        json.dump(report.to_dict(), mfh, indent=2)

    return report
