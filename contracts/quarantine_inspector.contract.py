"""
Legacy Snapshot Quarantine and Recovery Inspector Contract — Specification Authority for SLICE-3.

Defines the behavioral contract for safely quarantining unpartitioned legacy
kernel-state.dill files, non-destructively cataloguing recoverable vs unpicklable
variables, and extracting recoverable user state into a clean inspectable JSON/dill manifest.

Traceability:
    REQ-RLM-REHYDRATE-004 (Non-Destructive Quarantine: archive and inspect, never destroy)
    IP-6 (Quarantine inspector outputs forensic summary to operator)

The implementation does NOT import from this file; tests import both.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Literal

# =============================================================================
# Artifact 1: Importable Constants
# =============================================================================

DEFAULT_QUARANTINE_DIRNAME: Final[str] = ".omp/quarantine"
REPORT_FILENAME: Final[str] = "quarantine_manifest.json"

# Linkage to the single authority for the file-handle guard (CL11-C). This contract declares NO reconstructor set and
# no reason marker of its own: POST-QNOOPEN-1, ERRORS-QHANDLECONTAINER-1 and CROSS_INV-1 are stated against
# FILE_HANDLE_RECONSTRUCTORS and HANDLE_REASON_MARKER in contracts/rlm_dill_resilient_restore.contract.py.
# DEPENDS_ON is a reference map, not a clause: it declares no verification method.
DEPENDS_ON: Final[dict[str, str]] = {
    "file_handle_guard": "contracts/rlm_dill_resilient_restore.contract.py::POST-NOOPEN-1",
    "cross_invariant": "contracts/rlm_dill_resilient_restore.contract.py::CROSS_INV-1",
}

# =============================================================================
# Artifact 2: Domain Exception Classes
# =============================================================================

class QuarantineContractError(Exception):
    """Base domain exception for quarantine contract violations."""


class DestructiveOperationError(QuarantineContractError):
    """Raised when an unquarantined deletion is attempted on a legacy snapshot."""


# =============================================================================
# Artifact 3: Immutable Typed Records
# =============================================================================

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


# =============================================================================
# Artifact 4: Pure Callable Validators
# =============================================================================

def validate_quarantine_report(report: QuarantineReport) -> bool:
    """Validate that the quarantine report accounts for every single variable in the snapshot.
    
    POST-QUARANTINE-INSPECT-1:
        total_variables == recoverable_count + unpicklable_count == len(variables).
    """
    if report.total_variables != (report.recoverable_count + report.unpicklable_count):
        raise QuarantineContractError(
            f"POST-QUARANTINE-INSPECT-1 violation: counts mismatch in report: "
            f"total {report.total_variables} != {report.recoverable_count} recoverable + {report.unpicklable_count} unpicklable"
        )
    if len(report.variables) != report.total_variables:
        raise QuarantineContractError(
            f"POST-QUARANTINE-INSPECT-1 violation: variable list length {len(report.variables)} != total {report.total_variables}"
        )
    return True


# =============================================================================
# Artifact 5: Clause Contract Map
# =============================================================================

@dataclass(frozen=True)
class Clause:
    id: str
    method: Literal["test", "execution", "tool"]
    description: str
    requirement_ids: tuple[str, ...]


CONTRACT_QUARANTINE_INSPECTOR: Final[dict[str, Clause]] = {
    "POST-QUARANTINE-INSPECT-1": Clause(
        id="POST-QUARANTINE-INSPECT-1",
        method="test",
        description="QuarantineInspector archives legacy snapshot to quarantine directory and outputs a JSON manifest detailing recoverable vs unpicklable variables without data loss, continuing past per-variable exceptions (including SyntaxError and other deserialization exceptions) without aborting sibling inspection",
        requirement_ids=("REQ-RLM-REHYDRATE-004",),
    ),
    "FORBIDDEN-UNARCHIVED-DELETE-1": Clause(
        id="FORBIDDEN-UNARCHIVED-DELETE-1",
        method="test",
        description="QuarantineInspector SHALL NOT remove or truncate a legacy snapshot without first creating a verified copy in the quarantine archive",
        requirement_ids=("REQ-RLM-REHYDRATE-004",),
    ),
    "POST-QNOOPEN-1": Clause(
        id="POST-QNOOPEN-1",
        method="test",
        description="QuarantineInspector refuses, BEFORE any deserialization that could open a path, a per-variable blob whose serialized form references a file-handle reconstructor (including a handle nested inside a container or object): the variable is reported unpicklable with an error that names a file handle, every other variable is still inspected and reported recoverable, and the file the handle named is byte-identical afterwards. Inspection that truncates a file is destruction, not forensics. This is an accidental-I/O guard, not a sandbox for arbitrary pickles",
        requirement_ids=("REQ-RLM-REHYDRATE-004",),
    ),
    "ERRORS-QHANDLECONTAINER-1": Clause(
        id="ERRORS-QHANDLECONTAINER-1",
        method="test",
        description="When the snapshot's CONTAINER itself references a file-handle reconstructor, QuarantineInspector raises UnsafeReconstructionError naming a file handle after archiving the source copy and before deserializing anything; it opens no path named inside the snapshot",
        requirement_ids=("REQ-RLM-REHYDRATE-004",),
    ),
    "CROSS_INV-1": Clause(
        id="CROSS_INV-1",
        method="test",
        description="The runner's restore and the quarantine inspector refuse exactly the same file-handle reconstructors: the set FILE_HANDLE_RECONSTRUCTORS declared in contracts/rlm_dill_resilient_restore.contract.py is the single authority, and a reconstructor added to it is refused by both consumers or the cross-invariant is violated. Participants: contracts/rlm_dill_resilient_restore.contract.py, contracts/quarantine_inspector.contract.py. The same CROSS_INV-1 appears in both",
        requirement_ids=("REQ-RLM-REHYDRATE-002", "REQ-RLM-REHYDRATE-004"),
    ),
    "IP-6": Clause(
        id="IP-6",
        method="test",
        description="QuarantineInspector emits QuarantineReport to operator / filesystem",
        requirement_ids=("REQ-RLM-REHYDRATE-004",),
    ),
}
