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
})

# =============================================================================
# Artifact 2: Domain Exception Classes
# =============================================================================

class ResilientRestoreContractError(Exception):
    """Base domain exception for resilient restore contract violations."""


class NamespacePurityViolationError(ResilientRestoreContractError):
    """Raised when user_ns is polluted with partial state before validation completes."""


class BuiltinLeakageError(ResilientRestoreContractError):
    """Raised when an interactive shell builtin is serialized into user snapshot variables."""


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
