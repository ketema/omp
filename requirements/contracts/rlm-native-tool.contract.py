"""
RLM Native Tool Contract — companion schema for Python audit tooling.

CL12-C SINGULAR AUTHORITY:
The authoritative specification is `requirements/contracts/rlm-native-tool.contract.ts`.
This Python file is a companion schema for Python meta-checkers and cross-surface audit tooling.

WHAT the host session must guarantee: the ``ipython`` tool is exposed
directly in the top-level native active tools array (``getActiveToolNames()``)
with ``essential`` load mode, never demoted to discoverable-only.

Traceability: REQ-RLM-0002; DISCONNECT_MATRIX_TOPLEVEL_IPYTHON;
User directive 2026-08-20: "i want iPython to be as high priority as possible. essential... inside the native tool array".
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Literal, Mapping

# =============================================================================
# 1. Importable constants
# =============================================================================

NATIVE_TOOL_NAME: Final[str] = "ipython"
NATIVE_TOOL_LOAD_MODE: Final[str] = "essential"

# =============================================================================
# 2. Exception classes
# =============================================================================


class RlmNativeToolContractError(Exception):
    """Native tool contract violation. Messages cite clause IDs."""

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
class ActiveToolSurface:
    """Contract-level view of top-level active tools."""

    active_tool_names: tuple[str, ...]
    load_mode: str


# =============================================================================
# 4. Callable validators (pure; no I/O)
# =============================================================================


def validate_active_ipython(surface: object) -> ActiveToolSurface:
    """POST-NATIVE-1: active tool names include ``ipython``."""
    if not isinstance(surface, Mapping):
        raise RlmNativeToolContractError(
            "active tool surface is not a mapping",
            clause="POST-NATIVE-1",
        )
    names = surface.get("active_tool_names", surface.get("activeToolNames"))
    if not isinstance(names, (list, tuple)) or any(
        not isinstance(name, str) for name in names
    ):
        raise RlmNativeToolContractError(
            "active_tool_names must be a sequence of strings",
            clause="POST-NATIVE-1",
        )
    if NATIVE_TOOL_NAME not in names:
        raise RlmNativeToolContractError(
            f"active tools {list(names)!r} do not include {NATIVE_TOOL_NAME}",
            clause="POST-NATIVE-1",
        )
    mode = str(surface.get("load_mode", surface.get("loadMode", "")))
    if mode != NATIVE_TOOL_LOAD_MODE:
        raise RlmNativeToolContractError(
            f"expected load_mode to be {NATIVE_TOOL_LOAD_MODE}, got {mode!r}",
            clause="POST-NATIVE-2",
        )
    return ActiveToolSurface(tool_names=tuple(names), load_mode=mode)


# =============================================================================
# 5. Traceability
# =============================================================================

RLM_NATIVE_TOOL_CONTRACT: Final[dict[str, Clause]] = {
    "PRE-NATIVE-1": Clause(
        "test",
        "Session tool assembly is unrestricted (restrictToolNames is false).",
    ),
    "POST-NATIVE-1": Clause(
        "test",
        "After unrestricted session initialization, ipython is present in the "
        "top-level active tools array getActiveToolNames() (REQ-RLM-0002).",
    ),
    "POST-NATIVE-2": Clause(
        "test",
        "defaultLoadModeForToolName('ipython') evaluates to 'essential'.",
    ),
    "INV-NATIVE-1": Clause(
        "test",
        "From unrestricted session initialization through session disposal, "
        "ipython remains in the top-level active tools array.",
    ),
    "FORBIDDEN-NATIVE-1": Clause(
        "test",
        "An unrestricted session SHALL NOT unmount ipython from the top-level "
        "active tool array or demote ipython to discoverable-only status.",
    ),
}
