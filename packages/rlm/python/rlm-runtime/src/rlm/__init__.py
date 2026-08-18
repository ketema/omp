"""Kernel-side runtime for the omp RLM capability.

SLICE-5 surface:
- Contract constants (independent redeclaration)
- Skill wrapping: wrap_skill_module (POST-RT-1 / FORBIDDEN-RT-2)
- Unavailable skill shim: UnavailableSkill (POST-RT-2 / ERRORS-RT-2)
- Host request wire bridge: host_request (PRE-RT-1 / POST-RT-5 / ERRORS-RT-1)
- Lazy MCP integration: McpIntegration, McpToolError, NotEnabled
  (POST-RT-3 / POST-RT-4 / FORBIDDEN-RT-1)
"""

from __future__ import annotations

import asyncio
import dataclasses
import inspect
import sys
import types
from collections.abc import Callable

__version__ = "0.1.0"

# =============================================================================
# Constants (Redeclared independently; aligned with rlm-runtime.contract.ts)
# =============================================================================

# POST-RT-2 / REQ-RLM-0021 / F-027
UNAVAILABLE_RUN_ERROR = (
    "Python skill %s is unavailable in this IPython kernel. Import error: %s"
)

# POST-RT-2 / F-027
UNAVAILABLE_REPR_PREFIX = "<unavailable Python skill "

# POST-RT-3 / REQ-RLM-0022 / F-080
MCP_LAZY_EXPORTS: tuple[str, ...] = ("McpIntegration", "McpToolError", "NotEnabled")

# POST-RT-5 / REQ-RLM-0006 / F-071
HOST_REPLY_STATUSES: tuple[str, ...] = ("ok", "error", "unexpected")

# Constants redeclared independently; aligned with rlm-recursion.contract.ts
# (SLICE-6, F-250..F-258).
REC_DEPTH_DEFAULT = 0
REC_MAX_DEPTH_DEFAULT = 1
REC_NAME_MAX_CHARS = 64
REC_MODEL_SEARCH_DEFAULT_LIMIT = 8
REC_MODEL_SEARCH_MAX_LIMIT = 20
REC_CHILD_DIR_PREFIX = "sub-"
REC_CHILD_ID_HEX_LEN = 8
REC_TASK_PREFIX = "[task from parent]"
REC_DEFAULT_NAME_FALLBACK = "worker"

# Exact error strings (F-226..F-234)
REC_ERR_DEPTH = "RLM recursion depth limit reached (RLM_DEPTH=%d, RLM_MAX_DEPTH=%d)"
REC_ERR_KWARGS = "Unsupported rlm.run kwargs: %s"
REC_ERR_PROMPT_TYPE = "rlm.run prompt must be a string"
REC_ERR_MODEL_UNAVAILABLE = (
    'Requested subagent model "%s" is unavailable, unauthenticated, or expired'
)
REC_ERR_PREFLIGHT = 'Requested subagent model "%s" failed authentication preflight'
REC_ERR_INVALID_HANDLE = "rlm.run returned an invalid spawn handle"
REC_ERR_UNKNOWN_TARGET = (
    'No direct RLM subagent matches "%s" in the current parent session'
)
REC_ERR_AMBIGUOUS = 'RLM subagent selector "%s" is ambiguous'
REC_ERR_DISPOSED_PARENT = "Cannot spawn a subagent after its parent was disposed"


# =============================================================================
# Skill Wrapping (POST-RT-1 / FORBIDDEN-RT-2)
# =============================================================================


class _WrappedSkillModule(types.ModuleType):
    """Callable module wrapper that delegates __call__ to run."""

    def __init__(self, target_module: types.ModuleType, run_fn: Callable[..., object]):
        super().__init__(
            target_module.__name__, getattr(target_module, "__doc__", None)
        )
        self.__dict__.update(target_module.__dict__)
        self._rlm_wrapped_skill = True
        self._target_module = target_module
        self._run_fn = run_fn

        # Copy __doc__ and __signature__ from run
        if hasattr(run_fn, "__doc__") and run_fn.__doc__ is not None:
            self.__doc__ = run_fn.__doc__
        if hasattr(run_fn, "__signature__"):
            self.__signature__ = run_fn.__signature__
        else:
            try:
                self.__signature__ = inspect.signature(run_fn)
            except (ValueError, TypeError):
                pass

    def __call__(self, *args: object, **kwargs: object) -> object:
        # POST-RT-1: __call__ invokes run and awaits if awaitable
        res = self._run_fn(*args, **kwargs)
        if inspect.isawaitable(res) or asyncio.iscoroutine(res):

            async def _await_res() -> object:
                return await res

            return _await_res()
        return res


def wrap_skill_module(mod: types.ModuleType) -> types.ModuleType:
    """Wrap a Python skill module into a callable module if it has a callable run.

    FORBIDDEN-RT-2:
    - If mod has no callable run attribute, returns mod unchanged.
    - If mod is already wrapped, returns mod unchanged (idempotence).
    """
    if getattr(mod, "_rlm_wrapped_skill", False):
        return mod

    run_fn = getattr(mod, "run", None)
    if run_fn is None or not callable(run_fn):
        return mod

    wrapped = _WrappedSkillModule(mod, run_fn)
    sys.modules[mod.__name__] = wrapped
    return wrapped


# =============================================================================
# Unavailable Skill Shim (POST-RT-2 / ERRORS-RT-2)
# =============================================================================


class UnavailableSkill:
    """Shim bound when a skill fails to import."""

    def __init__(self, name: str, import_error: str):
        self._name = str(name)
        self._import_error = str(import_error)

    def __repr__(self) -> str:
        # POST-RT-2: repr starts with UNAVAILABLE_REPR_PREFIX, includes name and error
        return f"{UNAVAILABLE_REPR_PREFIX}{self._name} ({self._import_error})>"

    def run(self, *args: object, **kwargs: object) -> object:
        # ERRORS-RT-2: raises RuntimeError with formatted error
        raise RuntimeError(UNAVAILABLE_RUN_ERROR % (self._name, self._import_error))

    def __call__(self, *args: object, **kwargs: object) -> object:
        return self.run(*args, **kwargs)


# =============================================================================
# Host Request Bridge (PRE-RT-1 / POST-RT-5 / ERRORS-RT-1)
# =============================================================================

_host_bridge: object = None


def set_host_bridge(bridge: object) -> None:
    """Set the host bridge callable for host_request dispatch."""
    global _host_bridge
    _host_bridge = bridge


def get_host_bridge() -> object:
    """Get the current host bridge callable."""
    return _host_bridge


async def host_request(
    request_type: str, payload: dict[str, object] | None = None
) -> object:
    """Send a typed request to the host and await the response.

    PRE-RT-1: rejects non-string/empty type and non-dict payload with TypeError.
    ERRORS-RT-1: invalid args raise TypeError; host errors raise RuntimeError.
    POST-RT-5: settles ok (returning value/payload), error, or unexpected.
    """
    if not isinstance(request_type, str) or len(request_type) == 0:
        raise TypeError("PRE-RT-1: request_type must be a non-empty string")
    if payload is not None and not isinstance(payload, dict):
        raise TypeError("PRE-RT-1: payload must be a dict or None")

    bridge = _host_bridge
    if bridge is None:
        raise RuntimeError("No host bridge registered")

    if callable(bridge):
        reply = bridge(request_type, payload if payload is not None else {})
    elif hasattr(bridge, "request"):
        reply = bridge.request(request_type, payload if payload is not None else {})
    else:
        raise RuntimeError(f"Host bridge is not callable: {type(bridge)}")

    if inspect.isawaitable(reply) or asyncio.iscoroutine(reply):
        reply = await reply

    if not isinstance(reply, dict):
        return reply

    status = reply.get("status")
    # Finding #3: status must be explicit and in HOST_REPLY_STATUSES
    if status not in HOST_REPLY_STATUSES:
        raise RuntimeError(f"POST-RT-5: unexpected host status: {status}")

    if status == "error":
        error_msg = reply.get("error", "Host request failed")
        raise RuntimeError(f"ERRORS-RT-1: host error: {error_msg}")

    if status == "unexpected":
        error_msg = reply.get("error", "Host request encountered unexpected condition")
        raise RuntimeError(f"POST-RT-5: unexpected host status: {error_msg}")

    # status == "ok"
    # Finding #2: unwrap contract-standard data field, or value field if present
    if "data" in reply:
        return reply["data"]
    if "value" in reply and len(reply) <= 2:
        return reply["value"]

    return {k: v for k, v in reply.items() if k != "status"}


# =============================================================================
# MCP Lazy Integration (POST-RT-3 / POST-RT-4 / FORBIDDEN-RT-1)
# =============================================================================

# Finding #5: Define classes lazily within __getattr__ so top-level __dict__
# remains free of eager exports, fulfilling PEP 562 / F-080.


def __getattr__(name: str) -> object:
    """POST-RT-3: expose McpIntegration, McpToolError, NotEnabled lazily."""
    if name == "McpIntegration":

        class McpIntegration:
            """Discovers and invokes MCP tools through host_request.

            Keeps all credentials and auth stores host-side.
            """

            def __init__(self, server_name: str | None = None, **kwargs: object):
                self.server_name = server_name

            async def list_tools(self, **kwargs: object) -> object:
                return await host_request(
                    "mcp.list_tools", {"server": self.server_name, **kwargs}
                )

            async def call_tool(
                self,
                tool_name: str,
                arguments: dict[str, object] | None = None,
                **kwargs: object,
            ) -> object:
                return await host_request(
                    "mcp.call_tool",
                    {
                        "server": self.server_name,
                        "tool": tool_name,
                        "arguments": arguments if arguments is not None else {},
                        **kwargs,
                    },
                )

            async def config(self, **kwargs: object) -> object:
                return await host_request(
                    "mcp.config", {"server": self.server_name, **kwargs}
                )

            async def resolve_config(self, **kwargs: object) -> object:
                return await self.config(**kwargs)

            async def refresh(self, **kwargs: object) -> object:
                return await host_request(
                    "mcp.refresh", {"server": self.server_name, **kwargs}
                )

        return McpIntegration

    if name == "McpToolError":

        class McpToolError(Exception):
            """Raised when an MCP tool call fails."""

        return McpToolError

    if name == "NotEnabled":

        class NotEnabled(Exception):
            """Raised when MCP integration is not enabled in this session."""

        return NotEnabled

    raise AttributeError(f"module '{__name__}' has no attribute '{name}'")


# =============================================================================
# Recursion — await rlm(prompt, **kwargs) admission (SLICE-6)
# =============================================================================


@dataclasses.dataclass(frozen=True)
class RLMSpawnHandle:
    """F-070: the admission handle returned by a successful spawn."""

    rlm_child_id: str
    name: str
    session_dir: str
    model: str


_RUN_KWARGS_ALLOWED = frozenset({"name", "model"})


def _validate_spawn_handle(candidate: object) -> RLMSpawnHandle:
    """REC-V4 / POST-REC-1: the four handle fields must be non-empty strings."""
    if isinstance(candidate, RLMSpawnHandle):
        return candidate
    if not isinstance(candidate, dict):
        raise RuntimeError(REC_ERR_INVALID_HANDLE)
    fields = ("rlm_child_id", "name", "session_dir", "model")
    if not all(
        isinstance(candidate.get(field), str) and candidate.get(field)
        for field in fields
    ):
        raise RuntimeError(REC_ERR_INVALID_HANDLE)
    return RLMSpawnHandle(**{field: candidate[field] for field in fields})


async def run(prompt: object, **kwargs: object) -> RLMSpawnHandle:
    """PRE-REC-1: prompt is a string; kwargs are a subset of {name, model}.

    POST-REC-1: delegates admission to the host recursion engine and
    returns only the 4-field handle — the child's answer never appears in
    the return.
    """
    if not isinstance(prompt, str):
        raise TypeError(REC_ERR_PROMPT_TYPE)
    unsupported = sorted(k for k in kwargs if k not in _RUN_KWARGS_ALLOWED)
    if unsupported:
        raise TypeError(REC_ERR_KWARGS % ", ".join(unsupported))
    name = kwargs.get("name")
    if name is not None and (
        not isinstance(name, str)
        or len(name.strip()) == 0
        or len(name) > REC_NAME_MAX_CHARS
    ):
        raise ValueError(
            "REC-V3 violation: rlm.run name must be a non-empty string of at "
            f"most {REC_NAME_MAX_CHARS} characters"
        )
    payload: dict[str, object] = {"prompt": prompt, **kwargs}
    result = await host_request("rlm.run", payload)
    return _validate_spawn_handle(result)


async def find_models(query: str = "", **kwargs: object) -> list[object]:
    """POST-REC-5: ranked model search via the host catalog, capped at
    REC_MODEL_SEARCH_MAX_LIMIT."""
    result = await host_request("rlm.find_models", {"query": query, **kwargs})
    models = result if isinstance(result, list) else []
    return models[:REC_MODEL_SEARCH_MAX_LIMIT]


async def list_subagents(**kwargs: object) -> list[object]:
    """POST-REC-5: this parent's registry entries via the host registry."""
    result = await host_request("rlm.list_subagents", dict(kwargs))
    return result if isinstance(result, list) else []


async def delete_subagent(selector: str, **kwargs: object) -> str:
    """FORBIDDEN-REC-2: tombstones/removes from messaging only; never
    erases transcripts or artifacts."""
    result = await host_request("rlm.delete_subagent", {"selector": selector, **kwargs})
    if isinstance(result, dict) and "outcome" in result:
        return str(result["outcome"])
    return str(result)


__all__ = [
    "__version__",
    "UNAVAILABLE_RUN_ERROR",
    "UNAVAILABLE_REPR_PREFIX",
    "MCP_LAZY_EXPORTS",
    "HOST_REPLY_STATUSES",
    "REC_DEPTH_DEFAULT",
    "REC_MAX_DEPTH_DEFAULT",
    "REC_NAME_MAX_CHARS",
    "REC_MODEL_SEARCH_DEFAULT_LIMIT",
    "REC_MODEL_SEARCH_MAX_LIMIT",
    "REC_CHILD_DIR_PREFIX",
    "REC_CHILD_ID_HEX_LEN",
    "REC_TASK_PREFIX",
    "REC_DEFAULT_NAME_FALLBACK",
    "REC_ERR_DEPTH",
    "REC_ERR_KWARGS",
    "REC_ERR_PROMPT_TYPE",
    "REC_ERR_MODEL_UNAVAILABLE",
    "REC_ERR_PREFLIGHT",
    "REC_ERR_INVALID_HANDLE",
    "REC_ERR_UNKNOWN_TARGET",
    "REC_ERR_AMBIGUOUS",
    "REC_ERR_DISPOSED_PARENT",
    "wrap_skill_module",
    "UnavailableSkill",
    "host_request",
    "set_host_bridge",
    "get_host_bridge",
    "RLMSpawnHandle",
    "run",
    "find_models",
    "list_subagents",
    "delete_subagent",
]


# =============================================================================
# Module callable — `await rlm(prompt, **kwargs)` sugar for `await rlm.run(...)`
# =============================================================================


class _CallableRlmModule(types.ModuleType):
    """POST-REC-1: makes this module itself callable."""

    async def __call__(self, prompt: object, **kwargs: object) -> RLMSpawnHandle:
        return await run(prompt, **kwargs)


sys.modules[__name__].__class__ = _CallableRlmModule
