/**
 * Spawn-model contract — specification authority for optional per-invocation
 * subagent `model` on `task` and eval `agent()`.
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
	constructor(message: string) {
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
	readonly verification: VerificationMethod;
	readonly text: string;
}

export interface SpawnModelRequest {
	readonly model?: ModelSelector;
}

export interface ResolvedSpawnModel {
	readonly requestModel: ModelSelector | undefined;
	readonly usedParentSessionBecauseDefault: boolean;
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
	if (Array.isArray(model)) {
		if (model.length === 0 || !model.every(isNonEmptySelector)) {
			throw new InvalidModelSelectorError(INVALID_MODEL_MESSAGE);
		}
		return model;
	}
	throw new InvalidModelSelectorError(INVALID_MODEL_MESSAGE);
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
	if (!Object.hasOwn(request, "model") || request.model === undefined) {
		return;
	}
	throw new SpawnModelContractError(
		"POST-3",
		"omitted model must not produce a request.model selector",
	);
}

/**
 * POST-4 / REQ-SM-005A: selector `default` SHALL NOT be recorded as parent-session inherit.
 */
export function validateDefaultIsNotParentInherit(resolved: ResolvedSpawnModel): void {
	const selector = resolved.requestModel;
	const isDefault =
		selector === DEFAULT_ROLE_SELECTOR ||
		(Array.isArray(selector) && selector.length === 1 && selector[0] === DEFAULT_ROLE_SELECTOR);
	if (isDefault && resolved.usedParentSessionBecauseDefault) {
		throw new SpawnModelContractError(
			"POST-4",
			"selector default must resolve the on-disk default role, not the parent session",
		);
	}
}

/**
 * FORBIDDEN-2: settings keys that hide `model` SHALL be absent.
 */
export function validateNoModelGate(settingsKeys: readonly string[]): void {
	for (const key of FORBIDDEN_MODEL_GATE_KEYS) {
		if (settingsKeys.includes(key)) {
			throw new SpawnModelContractError("FORBIDDEN-2", `settings key ${key} hides model`);
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
	if (!Object.hasOwn(input, MODEL_FIELD)) {
		return;
	}
	if (!Object.hasOwn(parsed, MODEL_FIELD)) {
		throw new ModelFieldStrippedError("schema deleted supplied model");
	}
}

// =============================================================================
// Artifact 5: CONTRACT_SPAWN_MODEL Traceability Dictionary
// =============================================================================

export const CONTRACT_SPAWN_MODEL = {
	"PRE-1": {
		verification: "test",
		text: "A present model SHALL be a non-empty string or a non-empty array of non-empty strings.",
	},
	"PRE-2": {
		verification: "test",
		text: "An omitted model is valid. validateOptionalModel(undefined) returns undefined.",
	},
	"POST-1": {
		verification: "test",
		text: "When task spawn supplies model, TaskTool passes that value to runStructuredSubagent as model.",
	},
	"POST-2": {
		verification: "test",
		text: "When eval agent() supplies model, runEvalAgent passes that value to runStructuredSubagent as model.",
	},
	"POST-3": {
		verification: "test",
		text: "When the caller omits model, request.model is unset and on-disk configuration applies.",
	},
	"POST-4": {
		verification: "test",
		text: "Selector default resolves the on-disk default role and does not substitute the parent session model.",
	},
	"INV-1": {
		verification: "test",
		text: "SETTINGS_SCHEMA does not contain task.enableModel.",
	},
	"FORBIDDEN-1": {
		verification: "test",
		text: "Unknown-key deletion SHALL NOT drop a supplied model field.",
	},
	"FORBIDDEN-2": {
		verification: "test",
		text: "The product SHALL NOT add a settings key that hides model.",
	},
	"SEQ-1": {
		verification: "test",
		text: "TaskTool #runSpawn MUST call runStructuredSubagent with model when present BEFORE child start. Source: REQ-SM-001, IP-1.",
	},
	"SEQ-2": {
		verification: "test",
		text: "runEvalAgent MUST call runStructuredSubagent with model when present BEFORE child start. Source: REQ-SM-002, IP-2.",
	},
	"SEQ-3": {
		verification: "test",
		text: "runStructuredSubagent MUST pass request.model as requestModel into resolveAgentModelSelection BEFORE subprocess start. Source: IP-3.",
	},
	"ERRORS-1": {
		verification: "test",
		text: "Empty string or empty array model SHALL fail fast with InvalidModelSelectorError citing PRE-1.",
	},
} as const satisfies Record<string, Clause>;
