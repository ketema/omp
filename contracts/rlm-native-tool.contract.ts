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
 * Read-only session predicate.
 *
 * Upstream canonical definition lives at
 * packages/coding-agent/src/tools/index.ts:874-879 (verified identical in the
 * pristine v18.11.0 baseline): a session is read-only when its EXPLICIT tool
 * list GRANTS `read` AND OMITS `write`. Upstream gives exactly those sessions a
 * device-only write transport so xd:// mounting can engage without granting
 * working-tree writes (see the `deviceOnlyWrite` doc in sdk.ts).
 *
 * BOTH conjuncts are load-bearing. Omitting the `read` conjunct makes the
 * predicate strictly broader than upstream's and misclassifies write-capable
 * selections: a subagent declaring `tools: ["bash","edit"]` can write the
 * working tree and run arbitrary shell, so it is NOT read-only and MUST retain
 * the native tool. Human decision 2026-10-15: "in any session mode that is not
 * read only ipython must be loaded and available."
 *
 * `toolNames === undefined` means the full default set — NOT read-only.
 */
export function isReadOnlyToolSelection(toolNames: readonly string[] | undefined): boolean {
	if (toolNames === undefined) return false;
	return toolNames.includes("read") && !toolNames.includes("write");
}

/**
 * POST-NATIVE-3: ipython SHALL NOT be restricted from any subagent or session.
 *
 * Directive (Ketema 2026-11-13): "ipython is a critical tool for context management.
 * even for sub agents. ipython SHALL NOT BE RESTRICTED IN ANY WAY FROM ANY SUB AGENT."
 * Former FORBIDDEN-NATIVE-2 is retired: read-without-write sessions (e.g. ccabdd-auditor)
 * unconditionally admit ipython for in-kernel computation and data reduction.
 */
export function assertIpythonAdmittedForReadOnly(toolNames: readonly string[] | undefined, surface: unknown): void {
	if (!isReadOnlyToolSelection(toolNames)) return;
	if (typeof surface !== "object" || surface === null || !("activeToolNames" in surface)) {
		throw new RlmNativeToolContractError("POST-NATIVE-3", "active tool surface is not inspectable");
	}
	const names = surface.activeToolNames;
	if (!Array.isArray(names)) {
		throw new RlmNativeToolContractError("POST-NATIVE-3", "activeToolNames must be an array");
	}
	if (!names.includes(NATIVE_TOOL_NAME)) {
		throw new RlmNativeToolContractError(
			"POST-NATIVE-3",
			`subagent or session (toolNames=${JSON.stringify(toolNames)}) omitted ${NATIVE_TOOL_NAME}`,
		);
	}
}

// =============================================================================
// Artifact 5: Traceability
// =============================================================================

export const RLM_NATIVE_TOOL_CONTRACT = {
	"PRE-NATIVE-1": {
		verification: "test",
		text: "Session tool assembly is unrestricted (restrictToolNames is false). An explicit list omitting 'write' (such as ccabdd-auditor) admits ipython unconditionally (POST-NATIVE-3).",
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
		text: "From initialization of a session satisfying PRE-NATIVE-1 through session disposal, ipython remains in the top-level active tools array across every mid-session reselection path, including AgentSession.setActiveTools / applyActiveToolsByName invoked by extensions.",
	},
	"FORBIDDEN-NATIVE-1": {
		verification: "test",
		text: "A session satisfying PRE-NATIVE-1 SHALL NOT unmount ipython from the top-level active tool array or demote ipython to discoverable-only status.",
	},
	"POST-NATIVE-3": {
		verification: "test",
		text: "ipython SHALL NOT be restricted in any way from any subagent or session. Even when a subagent's explicit tool selection grants 'read' and omits 'write' (canonical ccabdd-auditor: [read, grep, glob, bash, ipython, task, hub, yield]), createRlmExtension() is admitted and ipython surfaces in getActiveToolNames(). Former FORBIDDEN-NATIVE-2 is retired by user directive 2026-11-13.",
	},
	"ERRORS-NATIVE-1": {
		verification: "test",
		text: "Every contract validator in this file SHALL signal violation by throwing RlmNativeToolContractError with its clauseId field set to the violated clause ID and the message naming the offending tool or value. The error SHALL propagate to the caller uncaught; validators SHALL NOT absorb, downgrade, or return a boolean in place of throwing. An uninspectable surface SHALL fail closed (throw) rather than pass silently (CL9-A).",
	},
} as const satisfies Record<string, Clause>;

export type RlmNativeToolClauseId = keyof typeof RLM_NATIVE_TOOL_CONTRACT;
