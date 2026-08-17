"""RED PHASE — rlm-runtime behavior tests (SLICE-5, RT-* clauses).

Targets the IMPLEMENTATION artifact packages/rlm/python/rlm-runtime/src/rlm/
(the `rlm` module), NOT the contract. At RED time the module is a hollow shell
(__version__ only), so these tests fail with ImportError/AttributeError — the
canonical implementation-missing RED state.

CONTRACT AUTHORITY RECORD:
- File: requirements/contracts/rlm-runtime.contract.ts
- Authority: "AUTHORITATIVE for the kernel-side rlm runtime"
- PRE: 1 (PRE-RT-1)  POST: 5 (POST-RT-1..5)  INV-LIFETIME: 1
- ERRORS: 2 (ERRORS-RT-1/2)  FORBIDDEN: 2 (FORBIDDEN-RT-1/2)

Assumed public surface of the `rlm` module (the contract governs the BEHAVIOR;
GREEN fixes exact names if they differ — tests are blind to implementation):
- rlm.wrap_skill_module(module)      -> wrapped callable module (F-026)
- rlm.UnavailableSkill(name, error)  -> unavailable-skill shim (F-027)
- rlm.McpIntegration                 -> in-kernel MCP client (F-080/F-164)
- rlm.host_request(type, payload)    -> async typed host bridge (F-071)
- rlm.MCP_LAZY_EXPORTS / HOST_REPLY_STATUSES / UNAVAILABLE_RUN_ERROR /
  UNAVAILABLE_REPR_PREFIX constants (alignment-tested separately)

SEAM for host_request resolution tests: the runtime settles host_request via a
module-level bridge the transport drives. Tests inject a fake bridge
(rlm._host_bridge) with an async request(type, payload) -> reply method. If
GREEN exposes the seam differently, only the injection point changes, not the
asserted behavior.
"""

import asyncio
import inspect
import sys
import types

import pytest

import rlm  # RED: hollow shell until GREEN


# ---------------------------------------------------------------------------
# Object Mothers / fakes
# ---------------------------------------------------------------------------

def make_skill_module(name="demo_skill", run=None, doc="demo skill doc"):
    """A fresh module standing in for an installed Python skill."""
    mod = types.ModuleType(name)
    if run is not None:
        mod.run = run
    if doc is not None:
        mod.run.__doc__ = doc if run is not None else None
    return mod


def sync_run(x):
    """A synchronous skill entrypoint with a real signature to copy."""
    return x * 2


async def async_run(x):
    """An async skill entrypoint."""
    return x + 1


class _FakeBridge:
    """Records host-bridge calls and returns a scripted reply."""

    def __init__(self, reply):
        self.reply = reply
        self.calls = []

    async def request(self, request_type, payload):
        self.calls.append((request_type, payload))
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply


# ---------------------------------------------------------------------------
# POST-RT-1 / FORBIDDEN-RT-2 — skill wrapping (F-026)
# ---------------------------------------------------------------------------

def test_post_rt_1_wraps_skill_with_callable_run_as_callable_module():
    """
    CONTRACT TRACEABILITY:
    - Enforces: POST-RT-1 (skill with callable run wrapped into a callable
      module whose __call__ awaits run, copies __signature__/__doc__, cached
      in sys.modules)
    - Category: positive
    - Risk tier: HIGH — skill invocation is the model's primary in-kernel
      capability; a broken wrapper silently breaks every skill call.
    - Adversarial: implementation-blind
    """
    mod = make_skill_module("wrap_sync_skill", run=sync_run)
    wrapped = rlm.wrap_skill_module(mod)

    assert callable(wrapped), (
        "POST-RT-1 violation: wrapped skill is not callable\n"
        "EXPECTED: a callable module (module with __call__)\n"
        f"ACTUAL: callable={callable(wrapped)}\n"
        "GUIDANCE: wrapping must produce a module whose __call__ invokes run"
    )
    assert inspect.signature(wrapped) == inspect.signature(sync_run), (
        "POST-RT-1 violation: __signature__ not copied from run\n"
        f"EXPECTED: {inspect.signature(sync_run)}\n"
        f"ACTUAL: {inspect.signature(wrapped) if callable(wrapped) else 'n/a'}\n"
        "GUIDANCE: the wrapped module must expose run's signature for introspection"
    )
    assert sys.modules.get("wrap_sync_skill") is wrapped, (
        "POST-RT-1 violation: wrapped module not cached in sys.modules\n"
        "EXPECTED: sys.modules['wrap_sync_skill'] is the wrapped module\n"
        f"ACTUAL: {sys.modules.get('wrap_sync_skill')!r}\n"
        "GUIDANCE: cache the wrapped module so re-import returns the callable form"
    )


def test_post_rt_1_wrapped_call_awaits_async_run():
    """
    CONTRACT TRACEABILITY:
    - Enforces: POST-RT-1 (__call__ awaits run — async result returned)
    - Category: positive (async branch of "awaitable or not")
    - Risk tier: HIGH — async skills must resolve to their return value.
    """
    mod = make_skill_module("wrap_async_skill", run=async_run)
    wrapped = rlm.wrap_skill_module(mod)
    result = asyncio.run(wrapped(41))
    assert result == 42, (
        "POST-RT-1 violation: __call__ did not await async run to its value\n"
        "EXPECTED: 42\n"
        f"ACTUAL: {result!r}\n"
        "GUIDANCE: __call__ must await an awaitable run and return its result"
    )


def test_post_rt_1_wrapped_call_returns_sync_run_value():
    """
    CONTRACT TRACEABILITY:
    - Enforces: POST-RT-1 (__call__ handles a non-awaitable run)
    - Category: positive (sync branch)
    - Risk tier: MEDIUM — sync skills must return their value directly.
    """
    mod = make_skill_module("wrap_sync_call", run=sync_run)
    wrapped = rlm.wrap_skill_module(mod)
    result = wrapped(21)
    assert result == 42, (
        "POST-RT-1 violation: __call__ did not return sync run's value\n"
        "EXPECTED: 42\n"
        f"ACTUAL: {result!r}\n"
        "GUIDANCE: __call__ must return a non-awaitable run's result directly"
    )


def test_forbidden_rt_2_module_without_run_returned_unchanged():
    """
    CONTRACT TRACEABILITY:
    - Enforces: FORBIDDEN-RT-2 (a module with no callable run is not altered)
    - Category: negative-space
    - Risk tier: MEDIUM — wrapping must not corrupt non-skill modules.
    """
    mod = make_skill_module("no_run_module", run=None)
    result = rlm.wrap_skill_module(mod)
    assert result is mod, (
        "FORBIDDEN-RT-2 violation: module without callable run was altered\n"
        "EXPECTED: the same module object returned unchanged\n"
        f"ACTUAL: {result!r} (is mod: {result is mod})\n"
        "GUIDANCE: only modules with a callable run may be wrapped"
    )


def test_forbidden_rt_2_wrapping_is_idempotent():
    """
    CONTRACT TRACEABILITY:
    - Enforces: FORBIDDEN-RT-2 (an already-wrapped module is not re-wrapped)
    - Category: negative-space
    - Risk tier: MEDIUM — double-wrapping would nest __call__ and break calls.
    """
    mod = make_skill_module("idempotent_skill", run=sync_run)
    once = rlm.wrap_skill_module(mod)
    twice = rlm.wrap_skill_module(once)
    assert twice is once, (
        "FORBIDDEN-RT-2 violation: re-wrapping an already-wrapped module\n"
        "EXPECTED: the same wrapped object returned (idempotent)\n"
        f"ACTUAL: twice is once = {twice is once}\n"
        "GUIDANCE: detect an already-wrapped module and return it unchanged"
    )


# ---------------------------------------------------------------------------
# POST-RT-2 / ERRORS-RT-2 — unavailable-skill shim (F-027)
# ---------------------------------------------------------------------------

def test_post_rt_2_unavailable_shim_repr_identifies_unavailable():
    """
    CONTRACT TRACEABILITY:
    - Enforces: POST-RT-2 (shim repr identifies it as unavailable, carries
      name and import error)
    - Category: positive
    - Risk tier: MEDIUM — the repr is how the model learns a skill is missing.
    """
    shim = rlm.UnavailableSkill("broken_skill", "No module named 'broken_skill'")
    rendered = repr(shim)
    assert rendered.startswith(rlm.UNAVAILABLE_REPR_PREFIX), (
        "POST-RT-2 violation: shim repr does not identify as unavailable\n"
        f"EXPECTED: starts with {rlm.UNAVAILABLE_REPR_PREFIX!r}\n"
        f"ACTUAL: {rendered!r}\n"
        "GUIDANCE: repr must start with the unavailable-skill prefix"
    )
    assert "broken_skill" in rendered and "No module named 'broken_skill'" in rendered, (
        "POST-RT-2 violation: shim repr missing name or import error\n"
        "EXPECTED: repr contains the skill name and the import error\n"
        f"ACTUAL: {rendered!r}\n"
        "GUIDANCE: repr must carry both the name and the recorded import error"
    )


def test_errors_rt_2_unavailable_shim_run_raises_with_import_error():
    """
    CONTRACT TRACEABILITY:
    - Enforces: ERRORS-RT-2 (calling an unavailable skill run raises
      RuntimeError carrying the recorded import error)
    - Category: error
    - Risk tier: MEDIUM — a missing skill must fail loud with the cause.
    """
    shim = rlm.UnavailableSkill("broken_skill", "No module named 'broken_skill'")
    with pytest.raises(RuntimeError) as excinfo:
        asyncio.run(shim.run())
    message = str(excinfo.value)
    expected = rlm.UNAVAILABLE_RUN_ERROR.replace("%s", "broken_skill").replace(
        "%s", "No module named 'broken_skill'"
    )
    assert message == expected, (
        "ERRORS-RT-2 violation: unavailable-skill run error mismatch\n"
        f"EXPECTED: {expected!r}\n"
        f"ACTUAL: {message!r}\n"
        "GUIDANCE: run must raise RuntimeError with the exact template"
    )


def test_post_rt_2_unavailable_shim_call_raises_like_run():
    """
    CONTRACT TRACEABILITY:
    - Enforces: POST-RT-2 (shim __call__ raises carrying the import error)
    - Category: positive (__call__ delegates to run)
    - Risk tier: MEDIUM — calling the shim directly must fail loud too.
    """
    shim = rlm.UnavailableSkill("broken_skill", "import boom")
    with pytest.raises(RuntimeError) as excinfo:
        asyncio.run(shim())
    assert "import boom" in str(excinfo.value), (
        "POST-RT-2 violation: shim __call__ did not carry the import error\n"
        "EXPECTED: RuntimeError message contains the import error\n"
        f"ACTUAL: {str(excinfo.value)!r}\n"
        "GUIDANCE: __call__ must await run and surface the same error"
    )


# ---------------------------------------------------------------------------
# POST-RT-3 — lazy MCP exports (F-080)
# ---------------------------------------------------------------------------

def test_post_rt_3_mcp_names_resolve_lazily():
    """
    CONTRACT TRACEABILITY:
    - Enforces: POST-RT-3 (rlm exposes McpIntegration/McpToolError/NotEnabled
      via __getattr__)
    - Category: positive
    - Risk tier: MEDIUM — the MCP surface must be importable from rlm.
    """
    for name in rlm.MCP_LAZY_EXPORTS:
        assert hasattr(rlm, name), (
            f"POST-RT-3 violation: rlm does not expose {name}\n"
            f"EXPECTED: rlm.{name} resolvable (lazy export)\n"
            "ACTUAL: attribute absent\n"
            "GUIDANCE: expose the MCP names through module __getattr__"
        )


def test_post_rt_3_importing_rlm_does_not_require_mcp_sdk():
    """
    CONTRACT TRACEABILITY:
    - Enforces: POST-RT-3 (importing rlm never requires the optional mcp SDK)
    - Category: negative-space
    - Risk tier: MEDIUM — a hard mcp dependency at import breaks kernels
      without the SDK.

    The `mcp` SDK is NOT installed in this environment. If rlm imported it at
    module-import time, the top-level `import rlm` above would have raised
    ImportError and this test module would not have been collected. Assert both
    that rlm imported and that it did not pull mcp into sys.modules.
    """
    assert "rlm" in sys.modules, (
        "POST-RT-3 violation: rlm not importable without the mcp SDK\n"
        "EXPECTED: import rlm succeeds regardless of mcp availability\n"
        "ACTUAL: rlm absent from sys.modules\n"
        "GUIDANCE: keep mcp imports lazy (inside __getattr__), never at module import"
    )
    assert "mcp" not in sys.modules, (
        "POST-RT-3 violation: importing rlm eagerly loaded the mcp SDK\n"
        "EXPECTED: 'mcp' absent from sys.modules after `import rlm`\n"
        "ACTUAL: 'mcp' present in sys.modules\n"
        "GUIDANCE: keep mcp imports lazy (inside __getattr__/methods), not at import"
    )


# ---------------------------------------------------------------------------
# PRE-RT-1 / ERRORS-RT-1 — host_request argument validation (F-071)
# ---------------------------------------------------------------------------

def test_pre_rt_1_host_request_rejects_non_string_type():
    """
    CONTRACT TRACEABILITY:
    - Enforces: PRE-RT-1 / ERRORS-RT-1 (non-str type raises TypeError before
      any frame is sent)
    - Category: negative
    - Risk tier: HIGH — a malformed host_request must fail fast, not send garbage.
    """
    for bad_type in (123, None, "", ["mcp.call"]):
        with pytest.raises(TypeError):
            asyncio.run(rlm.host_request(bad_type))


def test_pre_rt_1_host_request_rejects_non_dict_payload():
    """
    CONTRACT TRACEABILITY:
    - Enforces: PRE-RT-1 / ERRORS-RT-1 (non-dict payload raises TypeError)
    - Category: negative
    - Risk tier: HIGH — payload must be a dict or None.
    """
    for bad_payload in ("not-a-dict", ["list"], 42):
        with pytest.raises(TypeError):
            asyncio.run(
                rlm.host_request("mcp.call", bad_payload)
            )


def test_pre_rt_1_host_request_accepts_valid_args():
    """
    CONTRACT TRACEABILITY:
    - Enforces: PRE-RT-1 (valid type + dict/None payload passes validation and
      reaches the bridge)
    - Category: positive
    - Risk tier: HIGH — valid requests must proceed to the bridge.
    """
    bridge = _FakeBridge(reply={"status": "ok", "result": "done"})
    rlm._host_bridge = bridge
    try:
        result = asyncio.run(
            rlm.host_request("mcp.call", {"server": "linear"})
        )
    finally:
        rlm._host_bridge = None
    assert bridge.calls == [("mcp.call", {"server": "linear"})], (
        "PRE-RT-1 violation: valid host_request did not reach the bridge intact\n"
        "EXPECTED: [('mcp.call', {'server': 'linear'})]\n"
        f"ACTUAL: {bridge.calls!r}\n"
        "GUIDANCE: pass type and payload through to the bridge unchanged"
    )


# ---------------------------------------------------------------------------
# POST-RT-5 / INV-RT-LIFETIME-1 / ERRORS-RT-1 — host_request settlement
# ---------------------------------------------------------------------------

def test_post_rt_5_host_request_ok_reply_resolves_without_status_key():
    """
    CONTRACT TRACEABILITY:
    - Enforces: POST-RT-5 (an ok reply resolves the future with the payload
      minus the status key)
    - Category: positive
    - Risk tier: HIGH — the model awaits host_request; it must resolve to the
      reply data.
    """
    bridge = _FakeBridge(reply={"status": "ok", "value": 7, "extra": "x"})
    rlm._host_bridge = bridge
    try:
        result = asyncio.run(rlm.host_request("goal.create"))
    finally:
        rlm._host_bridge = None
    assert result == {"value": 7, "extra": "x"}, (
        "POST-RT-5 violation: ok reply not resolved to payload-minus-status\n"
        "EXPECTED: {'value': 7, 'extra': 'x'}\n"
        f"ACTUAL: {result!r}\n"
        "GUIDANCE: strip the status key and resolve with the remaining payload"
    )


def test_errors_rt_1_host_request_error_reply_raises_runtimeerror():
    """
    CONTRACT TRACEABILITY:
    - Enforces: ERRORS-RT-1 (an error reply raises RuntimeError with the
      host's error message)
    - Category: error
    - Risk tier: HIGH — a host-reported error must surface, not resolve ok.
    """
    bridge = _FakeBridge(reply={"status": "error", "error": "capability disabled"})
    rlm._host_bridge = bridge
    try:
        with pytest.raises(RuntimeError) as excinfo:
            asyncio.run(rlm.host_request("refine.run"))
    finally:
        rlm._host_bridge = None
    assert "capability disabled" in str(excinfo.value), (
        "ERRORS-RT-1 violation: error reply did not raise with the host message\n"
        "EXPECTED: RuntimeError containing 'capability disabled'\n"
        f"ACTUAL: {str(excinfo.value)!r}\n"
        "GUIDANCE: an error-status reply must raise RuntimeError with the message"
    )


def test_post_rt_5_host_request_unexpected_status_raises():
    """
    CONTRACT TRACEABILITY:
    - Enforces: POST-RT-5 / ERRORS-RT-1 (an unexpected status settles as an
      error, never silently as ok)
    - Category: boundary
    - Risk tier: HIGH — an unknown status must fail loud (CL15-B).
    """
    bridge = _FakeBridge(reply={"status": "weird-status"})
    rlm._host_bridge = bridge
    try:
        with pytest.raises(RuntimeError):
            asyncio.run(rlm.host_request("mcp.config"))
    finally:
        rlm._host_bridge = None


# ---------------------------------------------------------------------------
# POST-RT-4 / FORBIDDEN-RT-1 — MCP routes through host bridge, no local creds
# ---------------------------------------------------------------------------

def test_post_rt_4_mcp_integration_routes_through_host_request():
    """
    CONTRACT TRACEABILITY:
    - Enforces: POST-RT-4 (McpIntegration routes requests — including
      credential resolution — through host_request)
    - Category: positive (integration through the host bridge)
    - Risk tier: HIGH — MCP must not bypass the host bridge.
    - Double type: Stub (_FakeBridge — return-value control + call recording;
      derives from the host_request contract POST-RT-5 reply semantics).
    """
    bridge = _FakeBridge(reply={"status": "ok", "url": "https://mcp.example", "headers": {}})
    rlm._host_bridge = bridge
    try:
        integration = rlm.McpIntegration(server="linear")
        asyncio.run(integration.resolve_config())
    finally:
        rlm._host_bridge = None
    assert len(bridge.calls) >= 1, (
        "POST-RT-4 violation: McpIntegration did not route through host_request\n"
        "EXPECTED: at least one host_request call (e.g. mcp.config)\n"
        f"ACTUAL: {bridge.calls!r}\n"
        "GUIDANCE: MCP requests must go through host_request to the host bridge"
    )
    assert all(call[0].startswith("mcp.") for call in bridge.calls), (
        "POST-RT-4 violation: MCP host_request types must be mcp.*\n"
        f"ACTUAL: {[c[0] for c in bridge.calls]!r}\n"
        "GUIDANCE: use mcp.* request types for MCP host calls"
    )


def test_forbidden_rt_1_mcp_integration_does_not_read_local_credentials():
    """
    CONTRACT TRACEABILITY:
    - Enforces: FORBIDDEN-RT-1 (McpIntegration SHALL NOT read credentials from
      the filesystem or environment; credential resolution routes through
      host_request)
    - Category: negative-space (construct the scenario most likely to trigger
      the forbidden behavior: a credential file + env var present)
    - Risk tier: HIGH — credential leak into the kernel process is a REQ-N-3
      breach (security).
    - Double type: Stub (_FakeBridge) + spies on open/os.getenv.
    """
    import os

    opened_paths = []
    real_open = __builtins__["open"] if isinstance(__builtins__, dict) else __builtins__.open
    real_getenv = os.getenv

    def spy_open(path, *a, **k):
        opened_paths.append(str(path))
        return real_open(path, *a, **k)

    def spy_getenv(name, *a, **k):
        opened_paths.append(f"env:{name}")
        return real_getenv(name, *a, **k)

    bridge = _FakeBridge(reply={"status": "ok", "url": "https://mcp.example", "headers": {}})
    rlm._host_bridge = bridge
    open_patched = isinstance(__builtins__, dict)
    try:
        if open_patched:
            __builtins__["open"] = spy_open
        else:
            __builtins__.open = spy_open
        os.getenv = spy_getenv
        integration = rlm.McpIntegration(server="linear")
        asyncio.run(integration.resolve_config())
    finally:
        if open_patched:
            __builtins__["open"] = real_open
        else:
            __builtins__.open = real_open
        os.getenv = real_getenv
        rlm._host_bridge = None

    cred_accesses = [
        p for p in opened_paths
        if "auth" in p.lower() or "credential" in p.lower() or "token" in p.lower()
        or p.startswith("env:") and any(
            k in p.upper() for k in ("TOKEN", "KEY", "SECRET", "PASSWORD")
        )
    ]
    assert cred_accesses == [], (
        "FORBIDDEN-RT-1 violation: McpIntegration read local credentials\n"
        "EXPECTED: no credential file/env access; route through host_request\n"
        f"ACTUAL: credential accesses={cred_accesses!r}\n"
        "GUIDANCE: resolve credentials via host_request, never from fs/env"
    )
    assert len(bridge.calls) >= 1, (
        "FORBIDDEN-RT-1 violation: credential resolution did not use host_request\n"
        "EXPECTED: at least one host_request call for credential/config resolution\n"
        f"ACTUAL: {bridge.calls!r}\n"
        "GUIDANCE: credential resolution must route through host_request"
    )
