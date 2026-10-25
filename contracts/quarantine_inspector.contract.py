"""
Legacy Snapshot Quarantine and Recovery Inspector Contract — Specification Authority for SLICE-3.

Defines the behavioral contract for safely quarantining unpartitioned legacy
kernel-state.dill files, non-destructively cataloguing recoverable vs unpicklable
variables, and extracting recoverable user state into a clean inspectable JSON/dill manifest.

Traceability:
    REQ-RLM-REHYDRATE-004 (Non-Destructive Quarantine: archive and inspect, never destroy)
    IP-4 / IP-6 (Quarantine inspector outputs forensic summary to operator)

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
    "IP-6": Clause(
        id="IP-6",
        method="test",
        description="QuarantineInspector emits QuarantineReport to operator / filesystem",
        requirement_ids=("REQ-RLM-REHYDRATE-004",),
    ),
}
