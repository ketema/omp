"""CONTRACT-IMPLEMENTATION ALIGNMENT (supporting test, dual-stack rule).

Per the plan's pivot guidance, every slice runs alignment tests importing
BOTH the contract authority (requirements/contracts/rlm-ledger.contract.ts,
read as text — the TS contract cannot be imported from the Python lane) and
the implementation (rlm_ledger), asserting value equality.

This is NOT RED-phase testing of behavior (that is test_ledger_contract.py);
it is the contract-implementation independence bridge: the implementation
redeclares its values, and these tests fail if the two sides drift.
"""

import re
from pathlib import Path

import rlm_ledger  # RED: ModuleNotFoundError expected until GREEN

REPO_ROOT = Path(__file__).resolve().parents[4]
CONTRACT_TS = REPO_ROOT / "requirements" / "contracts" / "rlm-ledger.contract.ts"


def _ts_const(name: str) -> str:
    """Extract a literal from the TS contract (string, number, or tuple).

    Parses both single-line and multi-line declarations: the match runs to
    the statement terminator (optional `as const` at a line end), not to the
    end of the first line — so contract formatting cannot break alignment.
    """
    text = CONTRACT_TS.read_text()
    m = re.search(
        rf"export const {name}\b[^=\n]*="
        rf"\s*(?:\s*(\[[^\]]*\])\s*as const|([^[\n]+?)\s*(?:as const)?\s*$)",
        text,
        re.M,
    )
    if m is None:
        raise AssertionError(
            f"ALIGNMENT FAILED\n"
            f"WHY: constant {name} missing from TS contract authority\n"
            f"EXPECTED: export const {name} in rlm-ledger.contract.ts\n"
            f"ACTUAL: not found\n"
            f"GUIDANCE: the contract is the authority; align the implementation to it"
        )
    return (m.group(1) if m.group(1) is not None else m.group(2)).strip()


def test_alignment_kinds_and_scopes():
    """
    CONTRACT TRACEABILITY: REQ-RLM-0007 — impl constants match contract.
    """
    kinds_ts = re.findall(r"'([a-z]+)'", _ts_const("LED_KINDS"))
    assert tuple(rlm_ledger.KINDS) == tuple(kinds_ts), (
        f"ALIGNMENT FAILED: KINDS\n"
        f"EXPECTED (contract): {kinds_ts}\n"
        f"ACTUAL (impl): {list(rlm_ledger.KINDS)}\n"
        f"GUIDANCE: redeclare impl constants to match the contract authority"
    )
    scopes_ts = re.findall(r"'([a-z]+)'", _ts_const("LED_SCOPES"))
    assert tuple(rlm_ledger.SCOPES) == tuple(scopes_ts), (
        f"ALIGNMENT FAILED: SCOPES\nEXPECTED: {scopes_ts}\nACTUAL: {list(rlm_ledger.SCOPES)}\n"
        f"GUIDANCE: redeclare impl constants to match the contract authority"
    )


def test_alignment_numeric_and_file_constants():
    """
    CONTRACT TRACEABILITY: REQ-RLM-0007 — impl constants match contract.
    """
    pairs = [
        ("SCHEMA_VERSION", rlm_ledger.SCHEMA_VERSION, int(_ts_const("LED_SCHEMA_VERSION"))),
        ("ID_MAX_CHARS", rlm_ledger.ID_MAX_CHARS, int(_ts_const("LED_ID_MAX_CHARS"))),
        ("OVERVIEW_PER_KIND", rlm_ledger.OVERVIEW_PER_KIND, int(_ts_const("LED_OVERVIEW_PER_KIND"))),
        ("OVERVIEW_TRUNCATE_CHARS", rlm_ledger.OVERVIEW_TRUNCATE_CHARS, int(_ts_const("LED_OVERVIEW_TRUNCATE_CHARS"))),
        ("OVERVIEW_REFINEMENTS", rlm_ledger.OVERVIEW_REFINEMENTS, int(_ts_const("LED_OVERVIEW_REFINEMENTS"))),
        ("ENTRY_VERSION_DEFAULT", rlm_ledger.ENTRY_VERSION_DEFAULT, int(_ts_const("LED_ENTRY_VERSION_DEFAULT"))),
        ("LOCAL_FILE", rlm_ledger.LOCAL_FILE, _ts_const("LED_LOCAL_FILE").strip("'\"")),
        ("GLOBAL_FILE", rlm_ledger.GLOBAL_FILE, _ts_const("LED_GLOBAL_FILE").strip("'\"")),
        ("REFINEMENT_PREFIX", rlm_ledger.REFINEMENT_PREFIX, _ts_const("LED_REFINEMENT_PREFIX").strip("'\"")),
    ]
    for name, impl_val, contract_val in pairs:
        assert impl_val == contract_val, (
            f"ALIGNMENT FAILED: {name}\n"
            f"EXPECTED (contract): {contract_val!r}\n"
            f"ACTUAL (impl): {impl_val!r}\n"
            f"GUIDANCE: the implementation redeclares contract values independently; "
            f"drift means one side changed without the other"
        )
