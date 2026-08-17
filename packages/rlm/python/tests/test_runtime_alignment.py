"""CONTRACT-IMPLEMENTATION ALIGNMENT (supporting test, dual-stack rule).

Per the plan's pivot guidance, every slice runs alignment tests importing BOTH
the contract authority (requirements/contracts/rlm-runtime.contract.ts, read as
text — the TS contract cannot be imported from the Python lane) and the
implementation (the `rlm` module), asserting value equality.

This is NOT RED-phase testing of behavior (that is test_runtime_contract.py);
it is the contract-implementation independence bridge: the implementation
redeclares its values, and these tests fail if the two sides drift.

RED state: `import rlm` resolves the hollow runtime shell, so these tests fail
with AttributeError (contracted constants absent) until GREEN redeclares them.
"""

import re
from pathlib import Path

import rlm  # RED: hollow shell — contracted constants absent until GREEN

REPO_ROOT = Path(__file__).resolve().parents[4]
CONTRACT_TS = REPO_ROOT / "requirements" / "contracts" / "rlm-runtime.contract.ts"


def _ts_value_strings(name: str) -> list:
    """Extract the single-quoted string value(s) of a TS const declaration.

    Captures everything after the assignment `=` up to the next blank-line
    comment/export, so a `readonly [...]` type annotation (which repeats the
    literals before the `=`) is excluded and multi-line arrays parse cleanly.
    """
    text = CONTRACT_TS.read_text()
    m = re.search(
        rf"export const {name}\b[^=]*=(.*?)(?=\n\n/\*\*|\n\nexport |\nexport |\Z)",
        text,
        re.S,
    )
    if m is None:
        raise AssertionError(
            f"ALIGNMENT FAILED\n"
            f"WHY: constant {name} missing from TS contract authority\n"
            f"EXPECTED: export const {name} in rlm-runtime.contract.ts\n"
            f"ACTUAL: not found\n"
            f"GUIDANCE: the contract is the authority; align the implementation to it"
        )
    return re.findall(r"'([^']*)'", m.group(1))


def test_alignment_unavailable_skill_templates():
    """
    CONTRACT TRACEABILITY: POST-RT-2 / REQ-RLM-0021 — impl templates match contract.
    """
    run_error_ts = _ts_value_strings("RT_UNAVAILABLE_RUN_ERROR")
    assert len(run_error_ts) == 1, f"EXPECTED exactly 1 RT_UNAVAILABLE_RUN_ERROR string, got {run_error_ts}"
    assert rlm.UNAVAILABLE_RUN_ERROR == run_error_ts[0], (
        f"ALIGNMENT FAILED: UNAVAILABLE_RUN_ERROR\n"
        f"EXPECTED (contract): {run_error_ts[0]!r}\n"
        f"ACTUAL (impl): {getattr(rlm, 'UNAVAILABLE_RUN_ERROR', None)!r}\n"
        f"GUIDANCE: redeclare the impl template to match the contract authority"
    )
    repr_prefix_ts = _ts_value_strings("RT_UNAVAILABLE_REPR_PREFIX")
    assert len(repr_prefix_ts) == 1, f"EXPECTED exactly 1 RT_UNAVAILABLE_REPR_PREFIX string, got {repr_prefix_ts}"
    assert rlm.UNAVAILABLE_REPR_PREFIX == repr_prefix_ts[0], (
        f"ALIGNMENT FAILED: UNAVAILABLE_REPR_PREFIX\n"
        f"EXPECTED (contract): {repr_prefix_ts[0]!r}\n"
        f"ACTUAL (impl): {getattr(rlm, 'UNAVAILABLE_REPR_PREFIX', None)!r}\n"
        f"GUIDANCE: redeclare the impl template to match the contract authority"
    )


def test_alignment_mcp_lazy_exports():
    """
    CONTRACT TRACEABILITY: POST-RT-3 / REQ-RLM-0022 — impl lazy-export list matches contract.
    """
    exports_ts = tuple(_ts_value_strings("RT_MCP_LAZY_EXPORTS"))
    assert tuple(rlm.MCP_LAZY_EXPORTS) == exports_ts, (
        f"ALIGNMENT FAILED: MCP_LAZY_EXPORTS\n"
        f"EXPECTED (contract): {list(exports_ts)}\n"
        f"ACTUAL (impl): {list(getattr(rlm, 'MCP_LAZY_EXPORTS', ()))}\n"
        f"GUIDANCE: redeclare the impl lazy-export tuple to match the contract authority"
    )


def test_alignment_host_reply_statuses():
    """
    CONTRACT TRACEABILITY: POST-RT-5 / REQ-RLM-0006 — impl host-reply statuses match contract.
    """
    statuses_ts = tuple(_ts_value_strings("RT_HOST_REPLY_STATUSES"))
    assert tuple(rlm.HOST_REPLY_STATUSES) == statuses_ts, (
        f"ALIGNMENT FAILED: HOST_REPLY_STATUSES\n"
        f"EXPECTED (contract): {list(statuses_ts)}\n"
        f"ACTUAL (impl): {list(getattr(rlm, 'HOST_REPLY_STATUSES', ()))}\n"
        f"GUIDANCE: redeclare the impl status tuple to match the contract authority"
    )
