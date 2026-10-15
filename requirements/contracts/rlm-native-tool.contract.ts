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
	if (!Array.isArray(names) || names.some(name => typeof name !== "string")) {
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

/**
 * Read-only session predicate (upstream canonical definition, sdk.ts:382-384):
 * a session whose EXPLICIT tool list grants `read` but omits `write`. Upstream
 * gives such sessions a device-only write transport so xd:// mounting can
 * engage "without granting working-tree writes".
 *
 * `toolNames === undefined` means the full default set — NOT read-only.
 */
export function isReadOnlyToolSelection(toolNames: readonly string[] | undefined): boolean {
	if (toolNames === undefined) return false;
	return !toolNames.includes("write");
}

/**
 * FORBIDDEN-NATIVE-2: a read-only session SHALL NOT surface `ipython`.
 *
 * The tool executes arbitrary Python (`open(...,"w")`, `%%bash`, subprocess),
 * so mounting it into a session that was explicitly denied working-tree writes
 * would make that denial decorative. Upstream fixed the structurally identical
 * defect in 603312bcc0, where a startup pin promoted a device-only write to
 * full filesystem access.
 */
export function assertIpythonAbsentForReadOnly(toolNames: readonly string[] | undefined, surface: unknown): void {
	if (!isReadOnlyToolSelection(toolNames)) return;
	if (typeof surface !== "object" || surface === null || !("activeToolNames" in surface)) {
		throw new RlmNativeToolContractError("FORBIDDEN-NATIVE-2", "active tool surface is not inspectable");
	}
	const names = surface.activeToolNames;
	if (!Array.isArray(names)) {
		throw new RlmNativeToolContractError("FORBIDDEN-NATIVE-2", "activeToolNames must be an array");
	}
	if (names.includes(NATIVE_TOOL_NAME)) {
		throw new RlmNativeToolContractError(
			"FORBIDDEN-NATIVE-2",
			`read-only session (toolNames=${JSON.stringify(toolNames)}) surfaced ${NATIVE_TOOL_NAME}`,
		);
	}
}

// =============================================================================
// Artifact 5: Traceability
// =============================================================================

export const RLM_NATIVE_TOOL_CONTRACT = {
	"PRE-NATIVE-1": {
		verification: "test",
		text: "Session tool assembly is unrestricted (restrictToolNames is false) AND the session is not a read-only tool selection (isReadOnlyToolSelection(toolNames) is false; an explicit toolNames list omitting 'write' is read-only, while an absent list is the full default set).",
	},
	"POST-NATIVE-1": {
		verification: "test",
		text: "After initialization of a session satisfying PRE-NATIVE-1, ipython is present in the top-level active tools array getActiveToolNames() (REQ-RLM-0002).",
	},
	"POST-NATIVE-2": {
		verification: "test",
		text: "defaultLoadModeForToolName('ipython') evaluates to 'essential'.",
	},
	"INV-NATIVE-1": {
		verification: "test",
		text: "From initialization of a session satisfying PRE-NATIVE-1 through session disposal, ipython remains in the top-level active tools array.",
	},
	"FORBIDDEN-NATIVE-1": {
		verification: "test",
		text: "A session satisfying PRE-NATIVE-1 SHALL NOT unmount ipython from the top-level active tool array or demote ipython to discoverable-only status.",
	},
	"FORBIDDEN-NATIVE-2": {
		verification: "test",
		text: "A read-only session (isReadOnlyToolSelection(toolNames) is true) SHALL NOT surface ipython in getActiveToolNames() and SHALL NOT mount it under xd:// (getMountedXdevToolNames()). ipython executes arbitrary Python, so surfacing it would grant working-tree writes the session was explicitly denied; upstream 603312bcc0 fixed the structurally identical startup-pin promotion defect.",
	},
} as const satisfies Record<string, Clause>;

export type RlmNativeToolClauseId = keyof typeof RLM_NATIVE_TOOL_CONTRACT;
