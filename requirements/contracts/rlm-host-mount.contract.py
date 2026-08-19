"""
RLM Host Mount Contract — specification authority (Python surface).

WHAT the host session must guarantee: the model-facing tool inventory
includes ``ipython`` after unrestricted session construction.

HOW the host achieves that is implementation. This file does not name it.

The implementation does NOT import from this file; tests import both.

Traceability: REQ-RLM-0002; SEQ-TOOL-1; DISCONNECT B01.
IKG: Concept "Design by Contract" — specification authority, not implementation.
IKG: ArchitecturalPrinciple "Contract-Implementation Independence".
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Literal, Mapping

# =============================================================================
# 1. Importable constants
# =============================================================================

HOST_MOUNT_TOOL_NAME: Final[str] = "ipython"

# =============================================================================
# 2. Exception classes
# =============================================================================


class RlmHostMountContractError(Exception):
    """Host-mount contract violation. Messages cite clause IDs."""

    def __init__(self, message: str, *, clause: str = "") -> None:
        self.clause = clause
        super().__init__(f"{clause} violation: {message}" if clause else message)


# =============================================================================
# 3. Dataclasses / value carriers
# =============================================================================


@dataclass(frozen=True)
class Clause:
    verification: Literal["test", "execution", "tool"]
    text: str


@dataclass(frozen=True)
class MountedToolSurface:
    """Contract-level view of the model-facing tool inventory."""

    tool_names: tuple[str, ...]


# =============================================================================
# 4. Callable validators (pure; no I/O)
# =============================================================================


def validate_mounted_ipython(surface: object) -> MountedToolSurface:
    """POST-MOUNT-1: registered tool names include ``ipython``."""
    if not isinstance(surface, Mapping):
        raise RlmHostMountContractError(
            "mount surface is not a mapping",
            clause="POST-MOUNT-1",
        )
    names = surface.get("tool_names", surface.get("toolNames"))
    if not isinstance(names, (list, tuple)) or any(
        not isinstance(name, str) for name in names
    ):
        raise RlmHostMountContractError(
            "tool_names must be a sequence of strings",
            clause="POST-MOUNT-1",
        )
    if HOST_MOUNT_TOOL_NAME not in names:
        raise RlmHostMountContractError(
            f"registered tools {list(names)!r} do not include {HOST_MOUNT_TOOL_NAME}",
            clause="POST-MOUNT-1",
        )
    return MountedToolSurface(tool_names=tuple(names))


# =============================================================================
# 5. Traceability
# =============================================================================

RLM_HOST_MOUNT_CONTRACT: Final[dict[str, Clause]] = {
    "PRE-MOUNT-1": Clause(
        "test",
        "Session tool assembly is unrestricted (restrictToolNames is false).",
    ),
    "POST-MOUNT-1": Clause(
        "test",
        "After unrestricted session construction, the model-facing tool inventory "
        "includes a tool named ipython (REQ-RLM-0002).",
    ),
    "SEQ-MOUNT-1": Clause(
        "test",
        "TypeScript host MUST register the ipython tool on the session ExtensionAPI "
        "BEFORE the first model turn. Source: REQ-RLM-0002, DISCONNECT B01, IP-1.",
    ),
    "INV-MOUNT-1": Clause(
        "test",
        "From unrestricted session construction through session dispose, the "
        "model-facing tool inventory continues to include ipython.",
    ),
    "FORBIDDEN-MOUNT-1": Clause(
        "test",
        "An unrestricted session SHALL NOT omit ipython from the model-facing "
        "tool inventory.",
    ),
}
