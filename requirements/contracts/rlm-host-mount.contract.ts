/**
 * RLM Host Mount Contract — specification authority (TS native).
 *
 * CL12-C SINGULAR AUTHORITY: This file is the authoritative specification
 * for the host mount contract.
 *
 * WHAT the host session must guarantee: the model-facing tool inventory
 * includes `ipython` after unrestricted session construction.
 *
 * HOW the host achieves that (factory invocation, export shape, cast or not)
 * is implementation. This file does not name it.
 *
 * The implementation does NOT import from this file; tests import both.
 *
 * Traceability: REQ-RLM-0002; SEQ-TOOL-1; DISCONNECT B01.
 * IKG: Concept "Design by Contract" — specification authority, not implementation.
 * IKG: ArchitecturalPrinciple "Contract-Implementation Independence".
 * IKG: Rule "Tests Exercise Implementation Not Contract".
 */

// =============================================================================
// Artifact 1: Constants
// =============================================================================

/** Model-facing tool name that must appear in the unrestricted session inventory. */
export const HOST_MOUNT_TOOL_NAME = "ipython";

// =============================================================================
// Artifact 2: Exceptions
// =============================================================================

export class RlmHostMountContractError extends Error {
	readonly clauseId: string;

	constructor(clauseId: string, detail: string, options?: { cause?: unknown }) {
		super(`${clauseId} violation: ${detail}`, options);
		this.name = "RlmHostMountContractError";
		this.clauseId = clauseId;
	}
}

// =============================================================================
// Artifact 3: Structural types
// =============================================================================

export interface MountedToolSurface {
	readonly toolNames: readonly string[];
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
 * POST-MOUNT-1: registered tool names include `ipython`.
 */
export function assertMountedIpython(surface: unknown): asserts surface is MountedToolSurface {
	if (typeof surface !== "object" || surface === null) {
		throw new RlmHostMountContractError("POST-MOUNT-1", "mount surface is not an object");
	}
	if (!("toolNames" in surface)) {
		throw new RlmHostMountContractError("POST-MOUNT-1", "mount surface has no toolNames property");
	}
	const names = surface.toolNames;
	if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) {
		throw new RlmHostMountContractError("POST-MOUNT-1", "toolNames must be a string array");
	}
	if (!names.includes(HOST_MOUNT_TOOL_NAME)) {
		throw new RlmHostMountContractError(
			"POST-MOUNT-1",
			`registered tools ${JSON.stringify(names)} do not include ${HOST_MOUNT_TOOL_NAME}`,
		);
	}
}

// =============================================================================
// Artifact 5: Traceability
// =============================================================================

export const RLM_HOST_MOUNT_CONTRACT = {
	"PRE-MOUNT-1": {
		verification: "test",
		text: "Session tool assembly is unrestricted (restrictToolNames is false).",
	},
	"POST-MOUNT-1": {
		verification: "test",
		text: "After unrestricted session construction, the model-facing tool inventory includes a tool named ipython (REQ-RLM-0002).",
	},
	"SEQ-MOUNT-1": {
		verification: "test",
		text: "TypeScript host MUST register the ipython tool on the session ExtensionAPI BEFORE the first model turn. Source: REQ-RLM-0002, DISCONNECT B01, IP-1.",
	},
	"INV-MOUNT-1": {
		verification: "test",
		text: "From unrestricted session construction through session dispose, the model-facing tool inventory continues to include ipython.",
	},
	"FORBIDDEN-MOUNT-1": {
		verification: "test",
		text: "An unrestricted session SHALL NOT omit ipython from the model-facing tool inventory.",
	},
} as const satisfies Record<string, Clause>;

export type RlmHostMountClauseId = keyof typeof RLM_HOST_MOUNT_CONTRACT;
