"""
Context Efficiency Enforcement Contract (Python verification twin for ketema/omp#27).

Authoritative contract for SLICE-1 (REQ-CTX27-01..REQ-CTX27-14, INV-CTX27-01..INV-CTX27-07).
The TypeScript contract in contracts/context_efficiency_enforcement.contract.ts
mirrors every constant, exception, record, validator, and clause ID.
The implementation MUST NOT import from either contract file (CL11-F).
"""

from dataclasses import dataclass
from typing import Final, Literal

# ==============================================================================
# Artifact 1: Exported Constants
# ==============================================================================

RESULT_TOKEN_THRESHOLD: Final[int] = 1500
TURN_INLINE_TOKEN_BUDGET: Final[int] = 1500
SESSION_INLINE_TOKEN_BUDGET: Final[int] = 6000
DESCRIPTOR_MAX_TOKENS: Final[int] = 400
SCHEMA_NAME_MAX_CHARS: Final[int] = 31
TEXT_HEAD_LINES: Final[int] = 5
TEXT_TAIL_LINES: Final[int] = 5
TEXT_LINE_MAX_CHARS: Final[int] = 40
SAMPLE_STRING_MAX_CHARS: Final[int] = 40
DISPLAY_MAX_LINES: Final[int] = 60
DISPLAY_MAX_BYTES: Final[int] = 2048

CARD_MAX_TOKENS: Final[int] = 80
CARD_NAME_MAX_CHARS: Final[int] = 16
CARD_SIGNATURE_MAX_CHARS: Final[int] = 24
CARD_SUMMARY_MAX_CHARS: Final[int] = 32
CARD_SNAPSHOT_MAX_CHARS: Final[int] = 24

PAYLOAD_SLICE_BYTES: Final[int] = 32
FIXTURE_TRANSCRIPT_MAX_TOKENS: Final[int] = 700
COMPACTION_CANCELLED_TEXT: Final[str] = "Compaction cancelled"

# ==============================================================================
# Artifact 2: Exception Hierarchy
# ==============================================================================


class ContextEfficiencyContractError(Exception):
    """Base contract error for context efficiency enforcement."""


class PreconditionViolationError(ContextEfficiencyContractError):
    """Raised when PRE-CTX27-1 is violated."""


class BudgetInvariantViolationError(ContextEfficiencyContractError):
    """Raised when INV-CTX27-1 is violated."""


class DescriptorSchemaViolationError(ContextEfficiencyContractError):
    """Raised when a Universal Data Topology descriptor violates POST-CTX27-2."""


class CardSchemaViolationError(ContextEfficiencyContractError):
    """Raised when a helper catalog card violates POST-CTX27-4."""


class PayloadLeakViolationError(ContextEfficiencyContractError):
    """Raised when a 32-byte payload value slice leaks into a prompt (FORBIDDEN-CTX27-1)."""


# ==============================================================================
# Artifact 3: Immutable Typed Records
# ==============================================================================


@dataclass(frozen=True)
class Clause:
    verification: Literal["test", "execution", "tool"]
    text: str


@dataclass(frozen=True)
class HelperCatalogCardRecord:
    name: str
    signature: str
    summary: str
    snapshot: str


# ==============================================================================
# Artifact 4: Pure Callable Validators
# ==============================================================================


def validate_helper_catalog_card(card: HelperCatalogCardRecord, token_count: int) -> bool:
    if not (1 <= len(card.name) <= CARD_NAME_MAX_CHARS):
        raise CardSchemaViolationError(f"POST-CTX27-4 violation: name length {len(card.name)}")
    if not (1 <= len(card.signature) <= CARD_SIGNATURE_MAX_CHARS):
        raise CardSchemaViolationError(f"POST-CTX27-4 violation: signature length {len(card.signature)}")
    if not (1 <= len(card.summary) <= CARD_SUMMARY_MAX_CHARS):
        raise CardSchemaViolationError(f"POST-CTX27-4 violation: summary length {len(card.summary)}")
    if not (1 <= len(card.snapshot) <= CARD_SNAPSHOT_MAX_CHARS) or "/" in card.snapshot or "\\" in card.snapshot:
        raise CardSchemaViolationError("POST-CTX27-4 violation: snapshot must be basename <= 24 chars")
    if token_count > CARD_MAX_TOKENS:
        raise CardSchemaViolationError(f"POST-CTX27-4 violation: card token count {token_count} > {CARD_MAX_TOKENS}")
    return True


# ==============================================================================
# Artifact 5: Method-Aware Clause Map
# ==============================================================================

CONTRACT_CONTEXT_EFFICIENCY_ENFORCEMENT: Final[dict[str, Clause]] = {
    "PRE-CTX27-1": Clause(
        verification="test",
        text=(
            "ContextEfficiencyEnforcer requires non-empty agentDir and sessionId strings at "
            "construction, and admitToolResult requires a non-empty toolCallId string; "
            "violating inputs throw PreconditionViolationError citing PRE-CTX27-1. "
            "Source: REQ-CTX27-01, REQ-CTX27-02."
        ),
    ),
    "INV-CTX27-1": Clause(
        verification="test",
        text=(
            "At every public entry and exit of ContextEfficiencyEnforcer, turnInlineTokens "
            "is an integer in [0, 1500] and sessionInlineTokens is an integer in [0, 6000]; "
            "any violation throws BudgetInvariantViolationError citing INV-CTX27-1. "
            "Source: REQ-CTX27-02, REQ-CTX27-03."
        ),
    ),
    "POST-CTX27-1": Clause(
        verification="test",
        text=(
            "The emission gate counts tokens with natives.countTokens(text, Encoding.O200kBase), "
            "admits a result < 1,500 tokens inline only while turn inline tokens <= 1,500 and "
            "session inline tokens <= 6,000, and files any result >= 1,500 tokens or exceeding "
            "the turn or session budget as one UDT descriptor bound in the IPython kernel under "
            "artifact_<id>. Source: REQ-CTX27-01, REQ-CTX27-02, REQ-CTX27-03, REQ-CTX27-14, INV-CTX27-01."
        ),
    ),
    "POST-CTX27-2": Clause(
        verification="test",
        text=(
            "Each filed UDT descriptor is one JSON object of at most 400 o200k tokens with "
            "required class and name (artifact_<id>), schema names cut at 31 characters, text "
            "keeping 5 head and 5 tail lines cut at 40 characters, JSON array sample strings cut "
            "at 40 characters, JSON object descriptors copying no values, and progressive fallback "
            "dropping sample_row_0 then low_cardinality_distributions while preserving class, name, "
            "and cut schema names. Source: REQ-CTX27-04, REQ-CTX27-05, INV-CTX27-02, INV-CTX27-03."
        ),
    ),
    "POST-CTX27-3": Clause(
        verification="test",
        text=(
            "For every filed tool result, the IPython kernel value bound at artifact_<id> hashes "
            "equal (SHA-256) to the original payload, and the kernel display output for that name "
            "is capped at 60 lines and 2,048 bytes. Source: REQ-CTX27-06, REQ-CTX27-07."
        ),
    ),
    "POST-CTX27-4": Clause(
        verification="test",
        text=(
            "Saving F reusable helper functions to trusted helper snapshots under "
            "~/.omp/agent/repl-snapshots/ causes every subsequent assembled prompt to contain "
            "exactly F cards matching the schema (name <= 16, signature <= 24, summary <= 32, "
            "snapshot basename <= 24, each card <= 80 o200k tokens, total <= 80*F tokens) and "
            "zero function bodies. Source: REQ-CTX27-08, REQ-CTX27-09, INV-CTX27-04."
        ),
    ),
    "POST-CTX27-5": Clause(
        verification="test",
        text=(
            "On session_before_compact, unpicklable kernel names are dropped from the snapshot, "
            "listed in open_items, and compaction proceeds; a valid snapshot writes "
            "~/.omp/agent/ipython-compact-<session_id>.pkl as a non-empty xz stream whose "
            "decompressed bytes start with 0x80, writes exactly one "
            "auto-compact-memory-<session_id>-<seq> record with {narrative, descriptors, "
            "kernel_handles, snapshot_path, sha256, files_touched, open_items} and no payload, "
            "and a fresh dill.load_session restores the payload hash. "
            "Source: REQ-CTX27-10, REQ-CTX27-11, REQ-CTX27-12, INV-CTX27-05."
        ),
    ),
    "SEQ-CTX27-1": Clause(
        verification="test",
        text=(
            "ContextEfficiencyEnforcer.admitToolResult evaluates the o200k token count and "
            "turn/session budgets BEFORE returning transcriptText to the tool-result path (IP-1). "
            "Source: REQ-CTX27-01, REQ-CTX27-02, REQ-CTX27-03."
        ),
    ),
    "SEQ-CTX27-2": Clause(
        verification="test",
        text=(
            "When ContextEfficiencyEnforcer.admitToolResult files a tool result, it binds "
            "artifact_<id> in the IPython kernel BEFORE returning the UDT descriptor (IP-2). "
            "Source: REQ-CTX27-03, REQ-CTX27-06."
        ),
    ),
    "SEQ-CTX27-3": Clause(
        verification="test",
        text=(
            "assemblePromptWithCatalogCards reads manifest.json from the snapshots directory "
            "and appends bounded catalog cards BEFORE returning the assembled prompt (IP-3). "
            "Source: REQ-CTX27-08, REQ-CTX27-09."
        ),
    ),
    "SEQ-CTX27-4": Clause(
        verification="test",
        text=(
            "ContextEfficiencyEnforcer.runCompactionWithGate invokes runBeforeCompactHook "
            "BEFORE committing a compaction entry and aborts with CompactionCancelledError "
            "when the hook returns { cancel: true } (IP-4). Source: REQ-CTX27-11, REQ-CTX27-13."
        ),
    ),
    "ERRORS-CTX27-1": Clause(
        verification="test",
        text=(
            "When the compaction snapshot hash does not match the record or the snapshot write "
            "fails, session_before_compact returns { cancel: true }, compact() throws "
            "CompactionCancelledError, the compaction-entry count is unchanged, and the status "
            "text is Compaction cancelled. Source: REQ-CTX27-13."
        ),
    ),
    "FORBIDDEN-CTX27-1": Clause(
        verification="test",
        text=(
            "No 32-byte slice of a filed payload value appears in the assembled prompt outside "
            "a descriptor's cut sample string or cut text line (key names and column names cut "
            "at 31 characters are exempt), and the F-over + three-cards + compaction-status "
            "transcript excluding user prompts, F-inline, F-turn, and F-session is at most 700 "
            "o200k tokens. Source: INV-CTX27-06, INV-CTX27-07."
        ),
    ),
}
