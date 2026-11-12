/**
 * Spawn-model contract — specification authority for optional per-invocation
 * subagent `model` on `task` and eval `agent()`.
 *
 * STATUS: RETIRED / SUPERSEDED (2026-11-11, ketema/omp#70, PR #74, finding #18).
 * This contract governed the fork's legacy open spawn-model passthrough (PR #45 / row 8).
 * It was superseded by upstream's `task.perCallModel` feature adopted in the v18.18.7
 * reconcile (ketema/omp#70, PR #74). Upstream's model approval gate and settings schema
 * are the active authority, governed by `requirements/FORK_CUSTOMIZATIONS.md` row 8
 * and tracked under ketema/omp#72 and #76. All clauses (PRE-1, PRE-2, POST-1..POST-4,
 * INV-1, FORBIDDEN-1, FORBIDDEN-2, SEQ-1..SEQ-3, ERRORS-1) are RETIRED and no longer
 * bind the implementation.
 *
 * CL11-F: implementation SHALL NOT import this file. Tests import both.
 *
 * Source: requirements/REQ-2026-SPAWN-MODEL.md
 */

// =============================================================================
// Artifact 1: Importable Constants
// =============================================================================

export const MODEL_FIELD = "model" as const;
export const DEFAULT_ROLE_SELECTOR = "default" as const;
export const INVALID_MODEL_MESSAGE =
	"Invalid `model`. Provide a non-empty selector or a non-empty array of non-empty selectors.";

/** Settings keys that SHALL NOT exist (REQ-SM-008 / FORBIDDEN-2). */
export const FORBIDDEN_MODEL_GATE_KEYS = ["task.enableModel"] as const;

// =============================================================================
// Artifact 2: Domain Exception Classes
// =============================================================================

export class SpawnModelContractError extends Error {
	readonly clauseId: string;
	constructor(clauseId: string, message: string) {
		super(`${clauseId} violation: ${message}`);
		this.name = "SpawnModelContractError";
		this.clauseId = clauseId;
	}
}

/** PRE-1 / ERRORS-1: empty or non-selector `model`. */
export class InvalidModelSelectorError extends SpawnModelContractError {
	constructor(message: string = INVALID_MODEL_MESSAGE) {
		super("PRE-1", message);
		this.name = "InvalidModelSelectorError";
	}
}

/** FORBIDDEN-1: declared `model` dropped by unknown-key deletion. */
export class ModelFieldStrippedError extends SpawnModelContractError {
	constructor(message: string = "Declared `model` was stripped by schema parsing.") {
		super("FORBIDDEN-1", message);
		this.name = "ModelFieldStrippedError";
	}
}

// =============================================================================
// Artifact 3: Types
// =============================================================================

export type ModelSelector = string | string[];

export type VerificationMethod = "test" | "execution" | "tool";

export interface Clause {
	readonly id: string;
	readonly description: string;
	readonly method: VerificationMethod;
}

export interface SpawnModelRequest {
	readonly model?: ModelSelector;
}

export interface ResolvedSpawnModel {
	readonly requestModel?: ModelSelector;
	readonly effectiveModel: string;
	readonly inheritsThinkingLevel: boolean;
}

// =============================================================================
// Artifact 4: Pure Callable Validators
// =============================================================================

function isNonEmptySelector(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * PRE-1: a present `model` SHALL be a non-empty string or a non-empty array of
 * non-empty strings.
 */
export function validateModelSelector(model: unknown): ModelSelector {
	if (isNonEmptySelector(model)) {
		return model;
	}
	if (Array.isArray(model) && model.length > 0 && model.every(isNonEmptySelector)) {
		return model;
	}
	throw new InvalidModelSelectorError();
}

/**
 * PRE-2: omitted `model` (undefined) is valid and SHALL NOT be coerced into a
 * selector.
 */
export function validateOptionalModel(model: unknown): ModelSelector | undefined {
	if (model === undefined) {
		return undefined;
	}
	return validateModelSelector(model);
}

/**
 * POST-3: when the caller omits `model`, requestModel SHALL be undefined.
 */
export function validateOmittedRequestModel(request: SpawnModelRequest): void {
	if (request.model !== undefined) {
		throw new SpawnModelContractError(
			"POST-3",
			"Expected omitted `model` request to have undefined requestModel.",
		);
	}
}

/**
 * POST-4 / REQ-SM-005A: selector `default` SHALL NOT be recorded as parent-session inherit.
 */
export function validateDefaultIsNotParentInherit(resolved: ResolvedSpawnModel): void {
	if (resolved.requestModel === DEFAULT_ROLE_SELECTOR && resolved.inheritsThinkingLevel) {
		throw new SpawnModelContractError(
			"POST-4",
			"Selector `default` must resolve from on-disk configuration, not parent-session inherit.",
		);
	}
}

/**
 * FORBIDDEN-2: settings keys that hide `model` SHALL be absent.
 */
export function validateNoModelGate(settingsKeys: readonly string[]): void {
	for (const key of FORBIDDEN_MODEL_GATE_KEYS) {
		if (settingsKeys.includes(key)) {
			throw new SpawnModelContractError("FORBIDDEN-2", `Forbidden settings key present: ${key}`);
		}
	}
}

/**
 * FORBIDDEN-1: a parsed object that received `model` SHALL still have `model`
 * after schema unknown-key deletion.
 */
export function validateModelNotStripped(
	input: Readonly<Record<string, unknown>>,
	parsed: Readonly<Record<string, unknown>>,
): void {
	if (MODEL_FIELD in input && !(MODEL_FIELD in parsed)) {
		throw new ModelFieldStrippedError();
	}
}

// =============================================================================
// Artifact 5: CONTRACT_SPAWN_MODEL Traceability Dictionary
// =============================================================================

export const CONTRACT_SPAWN_MODEL = {
	"PRE-1": {
		id: "PRE-1",
		description:
			"A present `model` argument SHALL be a non-empty string selector or a non-empty array of non-empty string selectors.",
		method: "test",
	},
	"PRE-2": {
		id: "PRE-2",
		description:
			"Omitted `model` argument SHALL be accepted as undefined and SHALL NOT trigger validation failure.",
		method: "test",
	},
	"POST-1": {
		id: "POST-1",
		description:
			"When `model` is provided on a `task` item, the executor SHALL dispatch that subagent invocation with the specified model selector.",
		method: "test",
	},
	"POST-2": {
		id: "POST-2",
		description:
			"When `model` is provided to `eval` `agent()`, the agent bridge SHALL construct the subagent session with the specified model selector.",
		method: "test",
	},
	"POST-3": {
		id: "POST-3",
		description:
			"When `model` is omitted, the subagent invocation SHALL inherit the configured default model for that role or parent session.",
		method: "test",
	},
	"POST-4": {
		id: "POST-4",
		description:
			"When `model` is `default`, the invocation SHALL resolve the model configured on disk, not the parent session's active model.",
		method: "test",
	},
	"INV-1": {
		id: "INV-1",
		description:
			"The settings schema SHALL NOT declare `task.enableModel`; subagent model selection is unconditionally enabled.",
		method: "test",
	},
	"FORBIDDEN-1": {
		id: "FORBIDDEN-1",
		description:
			"The task schema unknown-key stripper SHALL NOT strip the `model` field from valid task invocations.",
		method: "test",
	},
	"FORBIDDEN-2": {
		id: "FORBIDDEN-2",
		description:
			"The product SHALL NOT introduce configuration keys that unconditionally disable or hide the `model` argument.",
		method: "test",
	},
	"SEQ-1": {
		id: "SEQ-1",
		description:
			"Task item parsing SHALL validate `model` BEFORE task execution is scheduled.",
		method: "test",
	},
	"SEQ-2": {
		id: "SEQ-2",
		description:
			"Model selection resolution SHALL execute BEFORE subagent session initialization.",
		method: "test",
	},
	"SEQ-3": {
		id: "SEQ-3",
		description:
			"Model-specific thinking-level suffix parsing SHALL execute BEFORE model selection resolution completes.",
		method: "test",
	},
	"ERRORS-1": {
		id: "ERRORS-1",
		description:
			"An invalid `model` argument (empty string, empty array, non-string items) SHALL raise InvalidModelSelectorError citing PRE-1.",
		method: "test",
	},
} as const satisfies Record<string, Clause>;
