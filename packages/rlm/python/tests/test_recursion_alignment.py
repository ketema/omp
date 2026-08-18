"""CONTRACT-IMPLEMENTATION ALIGNMENT (supporting test, dual-stack rule).

SLICE-6 alignment tests importing BOTH the contract authority
(requirements/contracts/rlm-recursion.contract.ts, read as text) and the
implementation (the `rlm` module), asserting value equality.

RED state: fails with AttributeError (recursion constants/classes absent in `rlm`)
until GREEN redeclares them.
"""

import re
from pathlib import Path

import rlm  # RED: hollow until GREEN

REPO_ROOT = Path(__file__).resolve().parents[4]
CONTRACT_TS = REPO_ROOT / "requirements" / "contracts" / "rlm-recursion.contract.ts"


def _ts_value_string(name: str) -> str:
    """Extract a single string value from a TS const declaration."""
    text = CONTRACT_TS.read_text()
    m = re.search(
        rf"export const {name}\b[^=]*=\s*['\"]([^'\"]*)['\"]",
        text,
    )
    if m is None:
        raise AssertionError(
            f"ALIGNMENT FAILED\n"
            f"WHY: constant {name} missing from TS contract authority\n"
            f"EXPECTED: export const {name} in rlm-recursion.contract.ts\n"
            f"ACTUAL: not found\n"
        )
    return m.group(1)


def _ts_value_number(name: str) -> int:
    """Extract an integer value from a TS const declaration."""
    text = CONTRACT_TS.read_text()
    m = re.search(
        rf"export const {name}\b[^=]*=\s*([0-9]+)",
        text,
    )
    if m is None:
        raise AssertionError(
            f"ALIGNMENT FAILED\n"
            f"WHY: constant {name} missing from TS contract authority\n"
            f"EXPECTED: export const {name} in rlm-recursion.contract.ts\n"
            f"ACTUAL: not found\n"
        )
    return int(m.group(1))


def test_alignment_recursion_constants():
    """
    CONTRACT TRACEABILITY: REQ-RLM-0008 / F-250..F-258 — recursion constants match contract.
    """
    assert rlm.REC_DEPTH_DEFAULT == _ts_value_number("REC_DEPTH_DEFAULT")
    assert rlm.REC_MAX_DEPTH_DEFAULT == _ts_value_number("REC_MAX_DEPTH_DEFAULT")
    assert rlm.REC_NAME_MAX_CHARS == _ts_value_number("REC_NAME_MAX_CHARS")
    assert rlm.REC_MODEL_SEARCH_MAX_LIMIT == _ts_value_number("REC_MODEL_SEARCH_MAX_LIMIT")
    assert rlm.REC_CHILD_DIR_PREFIX == _ts_value_string("REC_CHILD_DIR_PREFIX")
    assert rlm.REC_CHILD_ID_HEX_LEN == _ts_value_number("REC_CHILD_ID_HEX_LEN")
    assert rlm.REC_TASK_PREFIX == _ts_value_string("REC_TASK_PREFIX")
    assert rlm.REC_DEFAULT_NAME_FALLBACK == _ts_value_string("REC_DEFAULT_NAME_FALLBACK")


def test_alignment_recursion_error_strings():
    """
    CONTRACT TRACEABILITY: ERRORS-REC-1 / F-226..F-234 — error template strings match contract.
    """
    assert rlm.REC_ERR_DEPTH == _ts_value_string("REC_ERR_DEPTH")
    assert rlm.REC_ERR_KWARGS == _ts_value_string("REC_ERR_KWARGS")
    assert rlm.REC_ERR_PROMPT_TYPE == _ts_value_string("REC_ERR_PROMPT_TYPE")
    assert rlm.REC_ERR_MODEL_UNAVAILABLE == _ts_value_string("REC_ERR_MODEL_UNAVAILABLE")
    assert rlm.REC_ERR_PREFLIGHT == _ts_value_string("REC_ERR_PREFLIGHT")
    assert rlm.REC_ERR_INVALID_HANDLE == _ts_value_string("REC_ERR_INVALID_HANDLE")
    assert rlm.REC_ERR_UNKNOWN_TARGET == _ts_value_string("REC_ERR_UNKNOWN_TARGET")
    assert rlm.REC_ERR_AMBIGUOUS == _ts_value_string("REC_ERR_AMBIGUOUS")
    assert rlm.REC_ERR_DISPOSED_PARENT == _ts_value_string("REC_ERR_DISPOSED_PARENT")


def test_alignment_spawn_handle_fields():
    """
    CONTRACT TRACEABILITY: POST-REC-1 / F-070 — RLMSpawnHandle dataclass fields match.
    """
    handle_cls = getattr(rlm, "RLMSpawnHandle", None)
    assert handle_cls is not None, "RLMSpawnHandle must be exported by rlm"
    assert hasattr(handle_cls, "__dataclass_fields__"), "RLMSpawnHandle must be a dataclass"
    fields = tuple(handle_cls.__dataclass_fields__.keys())
    assert fields == ("rlm_child_id", "name", "session_dir", "model")
