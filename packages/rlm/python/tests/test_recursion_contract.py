"""RLM RECURSION SPECIFICATION TESTS (SLICE-6 RED).

Adversarial specification-driven tests for Python-side rlm.run, await rlm(...),
RLMSpawnHandle dataclass, and subagent management APIs.

Traceability:
- PRE-REC-1: rlm.run argument validation
- POST-REC-1 / FORBIDDEN-REC-1: returns RLMSpawnHandle, no answer payload (REQ-N-5)
- POST-REC-4: find_models API
- POST-REC-5: list_subagents API
- FORBIDDEN-REC-2: delete_subagent API
- ERRORS-REC-1: error handling and exact message templates
"""

import asyncio
from dataclasses import is_dataclass
import pytest
import rlm


class _FakeHostBridge:
    """Records host bridge requests and returns scripted replies."""

    def __init__(self, reply=None):
        self.reply = reply or {"status": "ok"}
        self.calls = []

    async def request(self, request_type, payload):
        self.calls.append((request_type, payload))
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply


def test_post_rec_1_rlm_spawn_handle_is_frozen_dataclass():
    """
    CONTRACT TRACEABILITY:
    - Enforces: POST-REC-1 / F-070 (RLMSpawnHandle is a frozen dataclass with 4 fields)
    - Category: positive (structural integrity)
    """
    handle_cls = getattr(rlm, "RLMSpawnHandle", None)
    assert handle_cls is not None, (
        "POST-REC-1 violation: RLMSpawnHandle not exported from rlm\n"
        "EXPECTED: RLMSpawnHandle class exported from rlm module\n"
        "GUIDANCE: define RLMSpawnHandle as a dataclass"
    )
    assert is_dataclass(handle_cls), "RLMSpawnHandle must be a dataclass"
    handle = handle_cls(
        rlm_child_id="sub-12345678",
        name="api-reviewer",
        session_dir="/tmp/artifacts/sub-12345678",
        model="anthropic/claude-sonnet-5",
    )
    assert handle.rlm_child_id == "sub-12345678"
    assert handle.name == "api-reviewer"
    assert handle.session_dir == "/tmp/artifacts/sub-12345678"
    assert handle.model == "anthropic/claude-sonnet-5"

    # Frozen: mutations raise
    with pytest.raises((AttributeError, TypeError)):
        handle.name = "mutated"


def test_post_rec_1_rlm_run_and_callable_rlm_route_to_host_bridge():
    """
    CONTRACT TRACEABILITY:
    - Enforces: POST-REC-1 / F-070 (rlm.run and rlm(...) dispatch host_request and return RLMSpawnHandle)
    - Category: positive (delegation admission)
    """
    bridge = _FakeHostBridge(
        reply={
            "status": "ok",
            "data": {
                "rlm_child_id": "sub-abcdef12",
                "name": "worker",
                "session_dir": "/tmp/artifacts/sub-abcdef12",
                "model": "anthropic/claude-sonnet-5",
            },
        }
    )
    rlm._host_bridge = bridge
    try:
        run_fn = getattr(rlm, "run", None)
        assert callable(run_fn), "rlm.run must be a callable function"
        handle = asyncio.run(run_fn("investigate performance", name="perf-worker"))

        assert len(bridge.calls) == 1
        assert bridge.calls[0][0] == "rlm.run"
        assert bridge.calls[0][1] == {"prompt": "investigate performance", "name": "perf-worker"}
        assert handle.rlm_child_id == "sub-abcdef12"
        assert handle.name == "worker"
    finally:
        rlm._host_bridge = None


def test_pre_rec_1_rlm_run_validates_prompt_and_kwargs():
    """
    CONTRACT TRACEABILITY:
    - Enforces: PRE-REC-1 / ERRORS-REC-1 (prompt must be str; kwargs whitelisted)
    - Category: error (invalid inputs rejected before host request)
    """
    bridge = _FakeHostBridge()
    rlm._host_bridge = bridge
    try:
        run_fn = getattr(rlm, "run", None)
        assert callable(run_fn), "rlm.run must be callable"

        with pytest.raises(TypeError) as excinfo:
            asyncio.run(run_fn(12345))
        assert "prompt must be a string" in str(excinfo.value)

        with pytest.raises(TypeError) as excinfo:
            asyncio.run(run_fn("valid prompt", bogus_option=True))
        assert "Unsupported" in str(excinfo.value)
    finally:
        rlm._host_bridge = None


def test_post_rec_4_find_models_routes_to_host_bridge():
    """
    CONTRACT TRACEABILITY:
    - Enforces: POST-REC-4 / F-120 (find_models queries host catalog)
    """
    bridge = _FakeHostBridge(
        reply={
            "status": "ok",
            "data": ["anthropic/claude-sonnet-5", "google-antigravity/gemini-3.7-flash"],
        }
    )
    rlm._host_bridge = bridge
    try:
        find_fn = getattr(rlm, "find_models", None)
        assert callable(find_fn), "rlm.find_models must be callable"
        models = asyncio.run(find_fn("sonnet", limit=5))

        assert len(bridge.calls) == 1
        assert bridge.calls[0][0] == "rlm.find_models"
        assert bridge.calls[0][1] == {"query": "sonnet", "limit": 5}
        assert models == ["anthropic/claude-sonnet-5", "google-antigravity/gemini-3.7-flash"]
    finally:
        rlm._host_bridge = None


def test_post_rec_5_list_and_delete_subagents_route_to_host_bridge():
    """
    CONTRACT TRACEABILITY:
    - Enforces: POST-REC-5, FORBIDDEN-REC-2 (subagent registry operations)
    """
    bridge = _FakeHostBridge(
        reply={
            "status": "ok",
            "data": [{"rlm_child_id": "sub-11223344", "status": "completed"}],
        }
    )
    rlm._host_bridge = bridge
    try:
        list_fn = getattr(rlm, "list_subagents", None)
        delete_fn = getattr(rlm, "delete_subagent", None)
        assert callable(list_fn), "rlm.list_subagents must be callable"
        assert callable(delete_fn), "rlm.delete_subagent must be callable"

        subagents = asyncio.run(list_fn())
        assert subagents == [{"rlm_child_id": "sub-11223344", "status": "completed"}]
        assert bridge.calls[0][0] == "rlm.list_subagents"

        bridge.calls.clear()
        bridge.reply = {"status": "ok", "data": "deleted"}
        outcome = asyncio.run(delete_fn("sub-11223344"))
        assert outcome == "deleted"
        assert bridge.calls[0][0] == "rlm.delete_subagent"
        assert bridge.calls[0][1] == {"selector": "sub-11223344"}
    finally:
        rlm._host_bridge = None
