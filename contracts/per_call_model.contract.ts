/**
 * PER-CALL MODEL UNIFICATION CONTRACT (ketema/omp#72)
 *
 * Implements behavior specifications unifying fork per-call model capabilities
 * (role aliases @smol/@default, explicit model strings, ordered fallback arrays)
 * into upstream task.perCallModel (PR #12229).
 *
 * Authority: CL11 Design by Contract, CL11-C Singular Authority.
 */

export class PerCallModelContractError extends Error {
	readonly clauseId: string;
	constructor(clauseId: string, message: string) {
		super(`${clauseId} violation: ${message}`);
		this.name = "PerCallModelContractError";
		this.clauseId = clauseId;
	}
}

export const PER_CALL_MODEL_CONTRACT = {
	"PRE-PCM-1": {
		verification: "test",
		manifestRefs: ["REQ-PCM-0001"],
		text: "task.perCallModel is enabled for the active invocationKind ('on' or 'task' for task items/subagents, 'on' or 'eval' for eval bridge).",
	},
	"POST-PCM-1": {
		verification: "test",
		manifestRefs: ["REQ-PCM-0002"],
		text: "A role alias (e.g. '@smol', '@default', 'pi/<role>', or configured agent roles in agent/config.yml) resolves deterministically to the concrete model configured for that role, maintaining operator trust boundaries. Specifically, '@default' resolves to the parent session active model pattern if active, or to the configured default role.",
	},
	"POST-PCM-2": {
		verification: "test",
		manifestRefs: ["REQ-PCM-0003"],
		text: "An explicit model string (e.g. 'provider/model-id', 'provider/model-id:level') passed to subagent task items, eval agent(), or workpool() is validated and admitted without whitelist rejection.",
	},
	"POST-PCM-3": {
		verification: "test",
		manifestRefs: ["REQ-PCM-0004"],
		text: "A candidate array of model selectors (e.g. ['@smol', 'provider/model-id']) resolves to the first available approved model in the sequence, preserving fallback cascade order.",
	},
	"SEQ-PCM-1": {
		verification: "test",
		manifestRefs: ["REQ-PCM-0003"],
		text: "When a subagent task dispatch carries a perCallModel selector, runStructuredSubagent resolves and passes the approved model override into the spawned child session executor options.",
	},
	"INV-PCM-1": {
		verification: "test",
		manifestRefs: ["REQ-PCM-0005"],
		text: "Operator allowlists (task.perCallModelAllow) and trust boundaries remain binding: project settings can narrow but never broaden per-call model approvals.",
	},
	"ERRORS-PCM-1": {
		verification: "test",
		manifestRefs: ["REQ-PCM-0006"],
		text: "When task.perCallModel is disabled, any per-call model selector is rejected with an actionable diagnostic identifying the disabled setting.",
	},
} as const;

export type PerCallModelClauseId = keyof typeof PER_CALL_MODEL_CONTRACT;
