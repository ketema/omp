"""
PER-CALL MODEL UNIFICATION CONTRACT (ketema/omp#72)

Implements behavior specifications unifying fork per-call model capabilities
(role aliases @smol/@default, explicit model strings, ordered fallback arrays)
into upstream task.perCallModel (PR #12229).

Authority: CL11 Design by Contract, CL11-C Singular Authority.
"""

from dataclasses import dataclass
from typing import Final, Literal

VerificationMethod = Literal["test", "execution", "tool"]

@dataclass(frozen=True)
class Clause:
    verification: VerificationMethod
    text: str
    manifest_refs: tuple[str, ...] = ()

class PerCallModelContractError(Exception):
    def __init__(self, clause_id: str, message: str) -> None:
        super().__init__(f"{clause_id} violation: {message}")
        self.clause_id = clause_id

PER_CALL_MODEL_CONTRACT: Final[dict[str, Clause]] = {
    "PRE-PCM-1": Clause(
        "test",
        "task.perCallModel is enabled for the active invocationKind ('on' or 'task' for task items/subagents, 'on' or 'eval' for eval bridge).",
        ("REQ-PCM-0001",),
    ),
    "POST-PCM-ALIAS": Clause(
        "test",
        "A role alias (e.g. '@smol', '@default', 'pi/<role>', or configured agent roles in agent/config.yml) resolves deterministically to the concrete model configured for that role, maintaining operator trust boundaries.",
        ("REQ-PCM-0002",),
    ),
    "POST-PCM-EXPLICIT": Clause(
        "test",
        "An explicit model string (e.g. 'provider/model-id', 'provider/model-id:level') passed to subagent task items, eval agent(), or workpool() is validated and admitted without whitelist rejection.",
        ("REQ-PCM-0003",),
    ),
    "POST-PCM-ARRAY": Clause(
        "test",
        "A candidate array of model selectors (e.g. ['@smol', 'provider/model-id']) resolves to the first available approved model in the sequence, preserving fallback cascade order.",
        ("REQ-PCM-0004",),
    ),
    "INV-PCM-OPERATOR-BOUNDARY": Clause(
        "test",
        "Operator allowlists (task.perCallModelAllow) and trust boundaries remain binding: project settings can narrow but never broaden per-call model approvals.",
        ("REQ-PCM-0005",),
    ),
    "ERRORS-PCM-1": Clause(
        "test",
        "When task.perCallModel is disabled, any per-call model selector is rejected with an actionable diagnostic identifying the disabled setting.",
        ("REQ-PCM-0006",),
    ),
}
