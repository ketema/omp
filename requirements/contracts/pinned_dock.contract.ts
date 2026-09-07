/**
 * CL11 Behavioral Contract for Pinned Interactive Viewport, Software Scrollback, and Overlay Compositing
 *
 * Source Authority: requirements/REQUIREMENT_MANIFEST_PINNED_REFACTOR.md
 * Prime Reference:  ~/projects/prime-agent/packages/tui/src/fullscreen.ts
 *
 * Implementation modules SHALL NOT import this contract file (CL11-F).
 * Tests bridge specification and implementation.
 * Language mode: TypeScript 7 erasable (no runtime enum, no namespaces, no parameter properties).
 */

// ============================================================================
// ARTIFACT 1: IMPORTABLE CONSTANTS
// ============================================================================

export const PINNED_MIN_TRANSCRIPT_ROWS = 3;
export const PINNED_WHEEL_SCROLL_LINES = 3;
export const PINNED_ALT_SCREEN_ENTER = "\x1b[?1049h";
export const PINNED_ALT_SCREEN_LEAVE = "\x1b[?1049l";
export const PINNED_MOUSE_SGR_ENTER = "\x1b[?1006h";
export const PINNED_MOUSE_BUTTON_ENTER = "\x1b[?1002h";
export const OSC52_CLIPBOARD_PREFIX = "\x1b]52;c;";

// ============================================================================
// ARTIFACT 2: DOMAIN ERROR HIERARCHY
// ============================================================================

export class PinnedDockContractError extends Error {
	readonly clauseId: string;
	constructor(clauseId: string, message: string) {
		super(`${clauseId} violation: ${message}`);
		this.name = "PinnedDockContractError";
		this.clauseId = clauseId;
	}
}

export class InvalidHeightError extends PinnedDockContractError {
	constructor(height: unknown) {
		super("PRE-PV-1", `Terminal height must be a finite number >= 1, got ${String(height)}`);
	}
}

export class UnparsedMouseEventError extends PinnedDockContractError {
	constructor(rawChunk: string) {
		super("FORBIDDEN-PV-1", `Concatenated SGR chunk dropped unparsed: ${JSON.stringify(rawChunk)}`);
	}
}

export class ZeroScrollbackError extends PinnedDockContractError {
	constructor(historyCount: number, windowHeight: number) {
		super("INV-PV-1", `Scrollback destroyed: historyCount=${historyCount} <= windowHeight=${windowHeight} while session active`);
	}
}

// ============================================================================
// ARTIFACT 3: FROZEN DATACLASSES / TYPED VALUE OBJECTS
// ============================================================================

export interface SgrMouseEvent {
	readonly button: number;
	readonly col: number;
	readonly row: number;
	readonly release: boolean;
	readonly wheel: -1 | 1 | null;
	readonly motion: boolean;
	readonly leftClick: boolean;
}

export interface ComposeFrameOptions {
	readonly transcript: readonly string[];
	readonly dock: readonly string[];
	readonly height: number;
}

export interface ScrollInfo {
	readonly following: boolean;
	readonly linesBelow: number;
	readonly linesAbove: number;
}

// ============================================================================
// ARTIFACT 4: CALLABLE VALIDATORS (RAISE CITING CLAUSE IDS)
// ============================================================================

export function validateComposeHeight(height: number): void {
	if (!Number.isFinite(height) || height < 1) {
		throw new InvalidHeightError(height);
	}
}

export function validateSgrMouseReports(rawChunk: string, events: readonly SgrMouseEvent[]): void {
	if (typeof rawChunk !== "string") {
		throw new PinnedDockContractError("PRE-PV-2", `Input data must be a string, got ${typeof rawChunk}`);
	}
	const countExpected = (rawChunk.match(/\x1b\[<(\d+);(\d+);(\d+)[Mm]/g) ?? []).length;
	if (countExpected > 0 && events.length === 0) {
		throw new UnparsedMouseEventError(rawChunk);
	}
}

export function validateSoftwareScrollback(transcriptLength: number, windowHeight: number, totalHistoryBlocks: number): void {
	if (totalHistoryBlocks > 5 && transcriptLength <= windowHeight) {
		throw new ZeroScrollbackError(transcriptLength, windowHeight);
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

export const CONTRACT_PINNED_DOCK: Record<string, ContractClause> = {
	"PRE-PV-1": {
		verification: "test",
		description: "PinnedViewport.composeFrame height argument SHALL be a finite number >= 1",
	},
	"PRE-PV-2": {
		verification: "test",
		description: "SGR mouse input parsers SHALL accept string data and reject non-string types",
	},
	"POST-PV-1": {
		verification: "test",
		description: "PinnedViewport.composeFrame SHALL return an array of exactly height lines with dock pinned to the bottom rows",
	},
	"POST-PV-2": {
		verification: "test",
		description: "PinnedViewport.composeFrame SHALL preserve full transcript lines in software history, allowing scrollTop to index previous session output",
	},
	"POST-PV-3": {
		verification: "test",
		description: "TUI.#renderPinnedFrame SHALL composite all active visible floating and anchored overlays over the composed base frame before emitting to the terminal",
	},
	"POST-PV-4": {
		verification: "test",
		description: "parseSgrMouseStream SHALL extract and decode all concatenated SGR mouse reports in a single stdin buffer chunk without dropping reports",
	},
	"POST-PV-5": {
		verification: "test",
		description: "TUI.#handlePinnedInput SHALL sum all wheel event deltas in a chunk to ensure smooth, unhindered momentum scrolling",
	},
	"POST-PV-6": {
		verification: "test",
		description: "Left-button drag across transcript rows SHALL capture selected plaintext and copy to clipboard via OSC 52 upon button release",
	},
	"POST-PV-7": {
		verification: "test",
		description: "Composer pinned renderFrame SHALL NOT permanently consume available viewport rows with unretired startup headers when active session messages exist",
	},
	"SEQ-PV-1": {
		verification: "test",
		description: "TUI.#renderPinnedFrame SHALL invoke PinnedViewport.composeFrame before overlay compositing",
	},
	"SEQ-PV-2": {
		verification: "test",
		description: "TUI.#renderPinnedFrame SHALL invoke TUI.#compositeOverlaysIntoWindow after composeFrame and before emitting the alternate-screen frame",
	},
	"SEQ-PV-3": {
		verification: "test",
		description: "TUI.#handlePinnedInput SHALL invoke parseSgrMouseStream before applying wheel delta or drag selection",
	},
	"SEQ-PV-4": {
		verification: "test",
		description: "Composer.renderFrame SHALL provide the full accumulated transcript history to PinnedViewport on every interactive frame",
	},
	"SEQ-PV-5": {
		verification: "test",
		description: "TUI SHALL reset active drag selection state when an overlay steals focus or when pinned mode exits",
	},
	"INV-PV-1": {
		verification: "test",
		description: "PinnedViewport SHALL NOT truncate scrollable history to the visible window height",
	},
	"INV-PV-2": {
		verification: "test",
		description: "TUI SHALL NOT discard or omit floating overlays from the rendered terminal frame in pinned mode",
	},
	"INV-PV-3": {
		verification: "test",
		description: "TUI SHALL NOT assign input focus to an invisible or uncomposited component",
	},
	"INV-PV-4": {
		verification: "test",
		description: "TUI SHALL NOT drop concatenated SGR mouse reports arriving in a single stdin chunk",
	},
	"INV-PV-5": {
		verification: "test",
		description: "TUI SHALL NOT overwrite transcript content rows with navigation or follow hints",
	},
	"INV-PV-6": {
		verification: "test",
		description: "Implementation modules SHALL NOT import this contract file (CL11-F)",
	},
	"FORBIDDEN-PV-1": {
		verification: "test",
		description: "A multi-report SGR chunk SHALL NOT be dropped or return null/unhandled",
	},
	"ERRORS-PV-1": {
		verification: "test",
		description: "validateComposeHeight SHALL throw InvalidHeightError citing PRE-PV-1 on non-positive height",
	},
};
