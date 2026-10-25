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
        with lzma.open(path, "rb") as comp_fh:
            payload = dill.load(comp_fh)
    # Check for Gzip magic bytes 0x1f 0x8b (F4 fix)
    elif len(header) >= 2 and header[:2] == bytes([0x1f, 0x8b]):
        with gzip.open(path, "rb") as comp_fh:
            payload = dill.load(comp_fh)
    else:
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
