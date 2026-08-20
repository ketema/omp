/**
 * RLM Native Tool Contract — specification authority (TS native).
 *
 * CL12-C SINGULAR AUTHORITY: This file is the authoritative specification
 * for the top-level native presentation of the RLM ipython tool.
 *
 * WHAT the host session must guarantee: the `ipython` tool is exposed
 * directly in the top-level native active tools array (`getActiveToolNames()`)
 * with `essential` load mode, never demoted to discoverable-only.
 *
 * Traceability: REQ-RLM-0002; DISCONNECT_MATRIX_TOPLEVEL_IPYTHON;
 * User directive 2026-08-20: "i want iPython to be as high priority as possible. essential... inside the native tool array".
 */

// =============================================================================
// Artifact 1: Constants
// =============================================================================

/** Model-facing tool name that must be top-level active. */
export const NATIVE_TOOL_NAME = "ipython";

/** Expected load mode for the native tool. */
export const NATIVE_TOOL_LOAD_MODE = "essential";

// =============================================================================
// Artifact 2: Exceptions
// =============================================================================

export class RlmNativeToolContractError extends Error {
	readonly clauseId: string;

	constructor(clauseId: string, detail: string, options?: { cause?: unknown }) {
		super(`${clauseId} violation: ${detail}`, options);
		this.name = "RlmNativeToolContractError";
		this.clauseId = clauseId;
	}
}

// =============================================================================
// Artifact 3: Structural types
// =============================================================================

export interface ActiveToolSurface {
	readonly activeToolNames: readonly string[];
	readonly loadMode: string;
}

export type ClauseVerification = "test" | "execution" | "tool";

export interface Clause {
	readonly verification: ClauseVerification;
	readonly text: string;
}

// =============================================================================
// Artifact 4: Validators
// =============================================================================

/**
 * POST-NATIVE-1: active tool names include `ipython`.
 */
export function assertActiveIpython(surface: unknown): asserts surface is ActiveToolSurface {
	if (typeof surface !== "object" || surface === null) {
		throw new RlmNativeToolContractError("POST-NATIVE-1", "active tool surface is not an object");
	}
	if (!("activeToolNames" in surface)) {
		throw new RlmNativeToolContractError("POST-NATIVE-1", "active tool surface has no activeToolNames property");
	}
	const names = surface.activeToolNames;
	if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) {
		throw new RlmNativeToolContractError("POST-NATIVE-1", "activeToolNames must be a string array");
	}
	if (!names.includes(NATIVE_TOOL_NAME)) {
		throw new RlmNativeToolContractError(
			"POST-NATIVE-1",
			`active tools ${JSON.stringify(names)} do not include ${NATIVE_TOOL_NAME}`,
		);
	}
}

/**
 * POST-NATIVE-2: load mode is `essential`.
 */
export function assertEssentialLoadMode(mode: unknown): void {
	if (typeof mode !== "string" || mode !== NATIVE_TOOL_LOAD_MODE) {
		throw new RlmNativeToolContractError(
			"POST-NATIVE-2",
			`expected loadMode to be ${NATIVE_TOOL_LOAD_MODE}, got ${String(mode)}`,
		);
	}
}

// =============================================================================
// Artifact 5: Traceability
// =============================================================================

export const RLM_NATIVE_TOOL_CONTRACT = {
	"PRE-NATIVE-1": {
		verification: "test",
		text: "Session tool assembly is unrestricted (restrictToolNames is false).",
	},
	"POST-NATIVE-1": {
		verification: "test",
		text: "After unrestricted session initialization, ipython is present in the top-level active tools array getActiveToolNames() (REQ-RLM-0002).",
	},
	"POST-NATIVE-2": {
		verification: "test",
		text: "defaultLoadModeForToolName('ipython') evaluates to 'essential'.",
	},
	"INV-NATIVE-1": {
		verification: "test",
		text: "From unrestricted session initialization through session disposal, ipython remains in the top-level active tools array.",
	},
	"FORBIDDEN-NATIVE-1": {
		verification: "test",
		text: "An unrestricted session SHALL NOT unmount ipython from the top-level active tool array or demote ipython to discoverable-only status.",
	},
} as const satisfies Record<string, Clause>;

export type RlmNativeToolClauseId = keyof typeof RLM_NATIVE_TOOL_CONTRACT;
