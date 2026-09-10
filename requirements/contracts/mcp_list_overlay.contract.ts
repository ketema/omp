/**
 * CL11 Canonical Contract: Focused `/mcp list` Inventory Overlay
 *
 * Single Authoritative Specification for the MCP inventory presentation domain.
 * Source Authority: requirements/REQUIREMENT_MANIFEST_PINNED_REFACTOR.md
 *
 * Implementation modules SHALL NOT import this contract file (CL11-F).
 * Tests bridge the independent contract boundary to production behavior.
 */

// ============================================================================
// ARTIFACT 1: IMPORTABLE CONSTANTS
// ============================================================================

export const MCP_LIST_COMMAND = "/mcp list";
export const MCP_LIST_OVERLAY_MIN_INVENTORY_CHARS = 1;

// ============================================================================
// ARTIFACT 2: DOMAIN ERROR HIERARCHY
// ============================================================================

export class McpListOverlayContractError extends Error {
	readonly clauseId: string;

	constructor(clauseId: string, message: string) {
		super(`${clauseId} violation: ${message}`);
		this.name = "McpListOverlayContractError";
		this.clauseId = clauseId;
	}
}

export class InvalidMcpListOverlayRequestError extends McpListOverlayContractError {
	constructor(message: string) {
		super("PRE-MCP-1", message);
	}
}

export class InvalidMcpListOverlayPresentationError extends McpListOverlayContractError {
	constructor(message: string) {
		super("INV-MCP-1", message);
	}
}

// ============================================================================
// ARTIFACT 3: FROZEN DATACLASSES / TYPED VALUE OBJECTS
// ============================================================================

export interface McpListOverlayRequest {
	readonly command: typeof MCP_LIST_COMMAND;
	readonly inventory: string;
}

export interface McpListOverlayPresentation {
	readonly focused: boolean;
	readonly scrollable: boolean;
	readonly escapeDismissible: boolean;
	readonly transcriptMounted: boolean;
	readonly editorFocusRestoredOnDismissal: boolean;
}

// ============================================================================
// ARTIFACT 4: CALLABLE VALIDATORS (RAISE CITING CLAUSE IDS)
// ============================================================================

export function validateMcpListOverlayRequest(request: unknown): asserts request is McpListOverlayRequest {
	if (typeof request !== "object" || request === null) {
		throw new InvalidMcpListOverlayRequestError("request must be an object");
	}
	const candidate = request as Partial<McpListOverlayRequest>;
	if (candidate.command !== MCP_LIST_COMMAND) {
		throw new InvalidMcpListOverlayRequestError(`command must equal ${MCP_LIST_COMMAND}`);
	}
	if (
		typeof candidate.inventory !== "string" ||
		candidate.inventory.trim().length < MCP_LIST_OVERLAY_MIN_INVENTORY_CHARS
	) {
		throw new InvalidMcpListOverlayRequestError("inventory must be a non-empty formatted string");
	}
}

export function validateMcpListOverlayPresentation(
	presentation: unknown,
): asserts presentation is McpListOverlayPresentation {
	if (typeof presentation !== "object" || presentation === null) {
		throw new InvalidMcpListOverlayPresentationError("presentation must be an object");
	}
	const candidate = presentation as Partial<McpListOverlayPresentation>;
	if (candidate.focused !== true) {
		throw new InvalidMcpListOverlayPresentationError("inventory overlay must receive input focus");
	}
	if (candidate.scrollable !== true) {
		throw new InvalidMcpListOverlayPresentationError("inventory overlay must be scrollable");
	}
	if (candidate.escapeDismissible !== true) {
		throw new InvalidMcpListOverlayPresentationError("inventory overlay must dismiss through Escape or cancel");
	}
	if (candidate.transcriptMounted !== false) {
		throw new InvalidMcpListOverlayPresentationError("inventory overlay must not mount command output in transcript history");
	}
	if (candidate.editorFocusRestoredOnDismissal !== true) {
		throw new InvalidMcpListOverlayPresentationError("dismissal must restore the active editor area focus");
	}
}

// ============================================================================
// ARTIFACT 5: TRACEABILITY MATRIX (CONTRACT_* CLAUSE DEFINITIONS)
// ============================================================================

export type VerificationMethod = "test" | "execution" | "tool";

export interface ContractClause {
	readonly verification: VerificationMethod;
	readonly description: string;
}

export const CONTRACT_MCP_LIST_OVERLAY = {
	"PRE-MCP-1": {
		verification: "test",
		description: "McpListOverlayRequest SHALL carry the exact /mcp list command and a non-empty formatted inventory string",
	},
	"POST-MCP-1": {
		verification: "test",
		description: "MCPCommandController.#handleList SHALL format configured-server inventory and no-server guidance as non-empty overlay information",
	},
	"POST-MCP-2": {
		verification: "test",
		description: "MCPCommandController.#handleList SHALL call InteractiveMode.showSessionInfo with its formatted inventory instead of the generic command-output path",
	},
	"POST-MCP-3": {
		verification: "test",
		description: "InteractiveMode.showSessionInfo SHALL show a focused SessionInfoOverlay whose ScrollView handles scroll input, whose Escape or cancel input hides the overlay, and whose dismissal restores the active editor-area focus",
	},
	"POST-MCP-4": {
		verification: "test",
		description: "When no MCP servers are configured, the existing no-server guidance SHALL appear in the focused overlay and not in transcript history",
	},
	"POST-MCP-5": {
		verification: "test",
		description: "Commands other than /mcp list SHALL retain generic command-output presentation through showCommandMessage and InteractiveMode.presentCommandOutput",
	},
	"SEQ-MCP-1": {
		verification: "test",
		description: "MCPCommandController.#handleList SHALL invoke InteractiveMode.showSessionInfo after inventory formatting and before its command promise resolves. Source: REQ-2026-PINNED-001, SEQ-PV-6, IP-MCP-1",
	},
	"SEQ-MCP-2": {
		verification: "test",
		description: "InteractiveMode.showSessionInfo SHALL create the overlay, show it, set focus to it, and request a render; its close callback SHALL hide the handle before restoring active editor-area focus. Source: REQ-2026-PINNED-001 lifecycle path",
	},
	"INV-MCP-1": {
		verification: "test",
		description: "The /mcp list path SHALL retain a focused, scrollable, Escape-dismissible overlay and SHALL NOT mount its inventory in transcript history",
	},
	"INV-MCP-2": {
		verification: "test",
		description: "The focused overlay specialization SHALL be limited to /mcp list and SHALL NOT change generic command-output persistence for other commands",
	},
	"INV-MCP-3": {
		verification: "tool",
		description: "Implementation modules SHALL NOT import this contract file (CL11-F)",
	},
	"FORBIDDEN-MCP-1": {
		verification: "test",
		description: "MCPCommandController.#handleList SHALL NOT call showCommandMessage or InteractiveMode.presentCommandOutput for either configured-server inventory or no-server guidance",
	},
	"ERRORS-MCP-1": {
		verification: "test",
		description: "validateMcpListOverlayRequest SHALL throw InvalidMcpListOverlayRequestError citing PRE-MCP-1 for a non-/mcp list command or empty inventory; the invalid request is rejected without presentation",
	},
	"ERRORS-MCP-2": {
		verification: "test",
		description: "An Error thrown while MCPCommandController.#handleList reads configuration SHALL be caught, transformed into InteractiveMode.showError text beginning Failed to list servers, and not propagated; this intentionally keeps the interactive command loop responsive",
	},
} as const satisfies Record<string, ContractClause>;
