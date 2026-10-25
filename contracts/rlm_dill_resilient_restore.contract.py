"""
RLM Dill Resilient Restore Contract — Specification Authority for SLICE-1.

Defines the behavioral contract for resilient, per-variable snapshot restoration
and builtin/primitive namespace hygiene in rlm_kernel_runner.py.

Traceability:
    REQ-RLM-REHYDRATE-001 (Resilience: no abort on single variable failure)
    REQ-RLM-REHYDRATE-002 (Namespace Purity: validate before user_ns injection)
    REQ-RLM-REHYDRATE-005 (Environment Independence: no ephemeral path reliance)
    REQ-RLM-REHYDRATE-006 (Telemetry: skipped unpicklable variable reporting)
    REQ-RLM-REHYDRATE-007 (Builtin Exclusion: filter shell wrappers from snapshot)
    REQ-RLM-REHYDRATE-008 (Base Primitives: pre-load standard interactive primitives)

The implementation does NOT import from this file; tests import both.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final, Literal

# =============================================================================
# Artifact 1: Importable Constants
# =============================================================================

# Shell builtins and interactive wrappers that SHALL NOT be serialized into user state
EXCLUDED_BUILTIN_NAMES: Final[frozenset[str]] = frozenset({
    "In",
    "Out",
    "get_ipython",
    "exit",
    "quit",
    "open",  # IPython _modified_open wrapper
})

# Standard modules/primitives guaranteed to be pre-loaded at bootstrap
BASE_BOOTSTRAP_MODULES: Final[frozenset[str]] = frozenset({
    "dill",
    "rlm",
    "json",
    "pathlib",
    "IPython",
    "IPython.display",
})

# THE single authority (CL11-C) for the file-handle guard's values, shared with contracts/quarantine_inspector.contract.py
# (which references this file through DEPENDS_ON and CROSS_INV-1 and declares no set of its own).
# Names that reconstruct a file handle (and so open a path) when a serialized variable is rebuilt
FILE_HANDLE_RECONSTRUCTORS: Final[frozenset[str]] = frozenset({
    "_create_filehandle",
})

# Reason text and error type a refused variable carries in the skipped telemetry
HANDLE_REASON_MARKER: Final[str] = "file handle"
UNSAFE_RECONSTRUCTION_ERROR_TYPE: Final[str] = "UnsafeReconstructionError"

# =============================================================================
# Artifact 2: Domain Exception Classes
# =============================================================================

class ResilientRestoreContractError(Exception):
    """Base domain exception for resilient restore contract violations."""


class NamespacePurityViolationError(ResilientRestoreContractError):
    """Raised when user_ns is polluted with partial state before validation completes."""


class BuiltinLeakageError(ResilientRestoreContractError):
    """Raised when an interactive shell builtin is serialized into user snapshot variables."""


class UnsafeReconstructionContractError(ResilientRestoreContractError):
    """Raised when a restore or snapshot lets a file-handle reconstruction reach an open."""


# =============================================================================
# Artifact 3: Immutable Typed Records
# =============================================================================

@dataclass(frozen=True)
class SkippedVariableRecord:
    """Record of an individual variable that failed unpickling and was skipped."""
    name: str
    reason: str
    error_type: str


@dataclass(frozen=True)
class RestoreOutcome:
    """Result of a resilient snapshot restore operation."""
    restored_names: tuple[str, ...]
    skipped: tuple[SkippedVariableRecord, ...]
    corrupt_fatal: bool = False
    fatal_reason: str | None = None


# =============================================================================
# Artifact 4: Pure Callable Validators
# =============================================================================

def validate_names_for_snapshot(names: set[str]) -> bool:
    """Validate that no excluded shell builtins are present in the snapshot candidate list.
    
    POST-NAME-FILTER-1: Excluded names (such as 'open') MUST NOT be present.
    """
    leaked = names.intersection(EXCLUDED_BUILTIN_NAMES)
    if leaked:
        raise BuiltinLeakageError(
            f"POST-NAME-FILTER-1 violation: snapshot candidates contain excluded builtins: {sorted(leaked)}"
        )
    return True


def validate_restore_outcome(
    outcome: RestoreOutcome,
    total_container_keys: int,
) -> bool:
    """Validate that every variable in the container is accounted for (restored or skipped).
    
    POST-RESTORE-SKIP-1: len(restored) + len(skipped) == total_keys.
    """
    if outcome.corrupt_fatal:
        return True
    accounted = len(outcome.restored_names) + len(outcome.skipped)
    if accounted != total_container_keys:
        raise NamespacePurityViolationError(
            f"POST-RESTORE-SKIP-1 violation: unaccounted variables during restore: "
            f"{accounted} accounted vs {total_container_keys} total container keys"
        )
    return True


def validate_bootstrap_environment(sys_modules: Mapping[str, Any]) -> bool:
    """Validate that all required base bootstrap modules are loaded in sys.modules.
    
    POST-BOOTSTRAP-PRIMITIVES-1: All BASE_BOOTSTRAP_MODULES present.
    """
    missing = [m for m in BASE_BOOTSTRAP_MODULES if m not in sys_modules]
    if missing:
        raise ResilientRestoreContractError(
            f"POST-BOOTSTRAP-PRIMITIVES-1 violation: base bootstrap modules missing from sys.modules: {missing}"
        )
    return True


# Validators for the file-handle guard (POST-NOHANDLE-1, POST-NOOPEN-1, FORBIDDEN-HANDLEOPEN-1)


def validate_handle_refusal(skipped: tuple[SkippedVariableRecord, ...], name: str) -> bool:
    """POST-NOOPEN-1 / POST-NOHANDLE-1: `name` is skipped, for a reason naming a file handle, as UnsafeReconstructionError."""
    matching = [record for record in skipped if record.name == name]
    if len(matching) != 1:
        raise UnsafeReconstructionContractError(
            f"POST-NOOPEN-1 violation: expected exactly one skipped record for {name!r}, got {len(matching)}"
        )
    record = matching[0]
    if HANDLE_REASON_MARKER not in record.reason or record.error_type != UNSAFE_RECONSTRUCTION_ERROR_TYPE:
        raise UnsafeReconstructionContractError(
            f"POST-NOOPEN-1 violation: skipped record for {name!r} must name a {HANDLE_REASON_MARKER} "
            f"as {UNSAFE_RECONSTRUCTION_ERROR_TYPE}, got reason={record.reason!r} error_type={record.error_type!r}"
        )
    return True


def validate_no_open_effect(before: bytes, after: bytes) -> bool:
    """FORBIDDEN-HANDLEOPEN-1: the file a snapshot named is byte-identical after a restore attempt."""
    if before != after:
        raise UnsafeReconstructionContractError(
            f"FORBIDDEN-HANDLEOPEN-1 violation: a path named in the snapshot changed ({len(before)} -> {len(after)} bytes)"
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


CONTRACT_RLM_DILL_RESILIENT_RESTORE: Final[dict[str, Clause]] = {
    "POST-RESTORE-SKIP-1": Clause(
        id="POST-RESTORE-SKIP-1",
        method="test",
        description="When individual variable blobs fail dill.loads, KernelRunner skips them without raising CorruptSnapshotError and restores all valid variables into user_ns",
        requirement_ids=("REQ-RLM-REHYDRATE-001", "REQ-RLM-REHYDRATE-002"),
    ),
    "POST-RESTORE-TELEMETRY-1": Clause(
        id="POST-RESTORE-TELEMETRY-1",
        method="test",
        description="KernelRunner reports skipped unpicklable variable names and error details in the snapshot_restore result frame",
        requirement_ids=("REQ-RLM-REHYDRATE-006",),
    ),
    "POST-NAME-FILTER-1": Clause(
        id="POST-NAME-FILTER-1",
        method="test",
        description="KernelRunner._snapshot_names filters out interactive shell builtins and wrappers including 'open' from snapshot candidates",
        requirement_ids=("REQ-RLM-REHYDRATE-007",),
    ),
    "POST-BOOTSTRAP-PRIMITIVES-1": Clause(
        id="POST-BOOTSTRAP-PRIMITIVES-1",
        method="test",
        description="KernelRunner._bootstrap pre-loads standard interactive and standard library primitives into sys.modules",
        requirement_ids=("REQ-RLM-REHYDRATE-008",),
    ),
    "POST-BOOTSTRAP-RLM-REQUIRED-1": Clause(
        id="POST-BOOTSTRAP-RLM-REQUIRED-1",
        method="test",
        description="KernelRunner._bootstrap fails fast when the rlm runtime package cannot be imported: it raises an ImportError naming 'rlm-runtime' (never reports readiness without it). rlm is a required member of BASE_BOOTSTRAP_MODULES, so an explicit interpreter override that lacks the runtime is a readiness failure, not a silently degraded kernel",
        requirement_ids=("REQ-RLM-REHYDRATE-008",),
    ),
    "POST-BOOTSTRAP-IPYTHON-1": Clause(
        id="POST-BOOTSTRAP-IPYTHON-1",
        method="test",
        description="KernelRunner._bootstrap fails fast when IPython or its display module cannot be imported: it raises an ImportError naming 'ipykernel' (never reports readiness without them, never skips the preload silently). The promised runtime is an IPython kernel (rlm-runtime depends on ipykernel) and requirement 008 promises interactive display primitives at bootstrap, so IPython and IPython.display are required members of BASE_BOOTSTRAP_MODULES; an explicit interpreter override that lacks them is a readiness failure, not a silently degraded kernel",
        requirement_ids=("REQ-RLM-REHYDRATE-008",),
    ),
    "INV-RESTORE-PURITY-1": Clause(
        id="INV-RESTORE-PURITY-1",
        method="test",
        description="KernelRunner user_ns is mutated only after all container variables have been evaluated and staged",
        requirement_ids=("REQ-RLM-REHYDRATE-002",),
    ),
    "FORBIDDEN-RESTORE-ABORT-1": Clause(
        id="FORBIDDEN-RESTORE-ABORT-1",
        method="test",
        description="KernelRunner SHALL NOT raise CorruptSnapshotError for individual unpickling failures when the container dict and compression headers are valid",
        requirement_ids=("REQ-RLM-REHYDRATE-001",),
    ),
    "POST-NOHANDLE-1": Clause(
        id="POST-NOHANDLE-1",
        method="test",
        description="KernelRunner._snapshot_write never serializes a live or closed file handle, including one nested inside a container or object attribute: a variable whose serialized form would reconstruct a file handle is skipped, reported in the skipped telemetry with a reason that names a file handle, and every other variable is still written. A handle cannot be rebuilt without reopening its path, so it is not state a snapshot may carry",
        requirement_ids=("REQ-RLM-REHYDRATE-001", "REQ-RLM-REHYDRATE-006"),
    ),
    "POST-NOOPEN-1": Clause(
        id="POST-NOOPEN-1",
        method="test",
        description="KernelRunner._snapshot_restore refuses, BEFORE any deserialization that could open a path, a per-variable blob whose serialized form references a file-handle reconstructor (a legacy snapshot written by an older runner, including a handle nested inside a container or object): the variable is skipped with a reason that names a file handle and error_type UnsafeReconstructionError, every other variable is restored, and the file the handle named is byte-identical afterwards. This is an accidental-I/O guard under the runner's existing permissions, not a sandbox for arbitrary pickles",
        requirement_ids=("REQ-RLM-REHYDRATE-001", "REQ-RLM-REHYDRATE-002"),
    ),
    "ERRORS-HANDLECONTAINER-1": Clause(
        id="ERRORS-HANDLECONTAINER-1",
        method="test",
        description="When the snapshot's CONTAINER itself (not a per-variable blob) references a file-handle reconstructor, KernelRunner._snapshot_restore raises CorruptSnapshotError naming a file handle before deserializing anything, mutates no namespace, and opens no path; per-variable skipping does not apply because no per-variable boundary exists",
        requirement_ids=("REQ-RLM-REHYDRATE-002",),
    ),
    "FORBIDDEN-HANDLEOPEN-1": Clause(
        id="FORBIDDEN-HANDLEOPEN-1",
        method="test",
        description="Restoring a snapshot SHALL NOT create, open, truncate or write any path named inside the snapshot",
        requirement_ids=("REQ-RLM-REHYDRATE-002",),
    ),
    "CROSS_INV-1": Clause(
        id="CROSS_INV-1",
        method="test",
        description="The runner's restore and the quarantine inspector refuse exactly the same file-handle reconstructors: the set FILE_HANDLE_RECONSTRUCTORS declared in contracts/rlm_dill_resilient_restore.contract.py is the single authority, and a reconstructor added to it is refused by both consumers or the cross-invariant is violated. Participants: contracts/rlm_dill_resilient_restore.contract.py, contracts/quarantine_inspector.contract.py. The same CROSS_INV-1 appears in both",
        requirement_ids=("REQ-RLM-REHYDRATE-002", "REQ-RLM-REHYDRATE-004"),
    ),
    "IP-1": Clause(
        id="IP-1",
        method="test",
        description="KernelRunner._snapshot_restore injects unpickled variables into user_ns",
        requirement_ids=("REQ-RLM-REHYDRATE-001", "REQ-RLM-REHYDRATE-002"),
    ),
    "IP-2": Clause(
        id="IP-2",
        method="test",
        description="KernelRunner._snapshot_restore delivers restored names and skipped metadata to host via JSON-RPC result frame",
        requirement_ids=("REQ-RLM-REHYDRATE-006",),
    ),
    "IP-3": Clause(
        id="IP-3",
        method="test",
        description="KernelRunner._snapshot_names supplies filtered candidate names to _snapshot_write",
        requirement_ids=("REQ-RLM-REHYDRATE-007",),
    ),
    "IP-4": Clause(
        id="IP-4",
        method="test",
        description="KernelRunner._bootstrap populates sys.modules before cell execution or snapshot restore",
        requirement_ids=("REQ-RLM-REHYDRATE-008",),
    ),
}
