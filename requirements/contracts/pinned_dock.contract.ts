/**
 * CL11 Canonical Contract: Pinned Viewport, Software Scrollback, and Terminal-Native Selection
 *
 * Single Authoritative Specification for the Pinned TUI Domain.
 * Consolidates and supersedes:
 *   - requirements/contracts/pinned-composer.contract.ts (DELETED)
 *   - requirements/contracts/pinned-jitter-copy.contract.ts (DELETED)
 *
 * Source Authority: requirements/REQUIREMENT_MANIFEST_PINNED_REFACTOR.md
 * Prime Reference:  ~/projects/prime-agent/packages/tui/src/fullscreen.ts
 *
 * Implementation modules SHALL NOT import this contract file (CL11-F).
 * Language mode: TypeScript 7 erasable.
 */

// ============================================================================
// ARTIFACT 1: IMPORTABLE CONSTANTS
// ============================================================================

export const PINNED_MIN_TRANSCRIPT_ROWS = 3;
export const PINNED_ALT_SCREEN_ENTER = "\x1b[?1049h";
export const PINNED_ALT_SCREEN_LEAVE = "\x1b[?1049l";

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

export class InvalidMouseInputError extends PinnedDockContractError {
	constructor(input: unknown) {
		super("PRE-PV-2", `Input data must be a string, got ${typeof input}`);
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
		throw new InvalidMouseInputError(rawChunk);
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

export const CONTRACT_PINNED_DOCK = {
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
	"POST-PV-7": {
		verification: "test",
		description: "Composer pinned renderFrame SHALL NOT permanently consume available viewport rows with unretired startup headers when active session messages exist; retired header sits at index 0 of history",
	},
	"POST-PV-11": {
		verification: "test",
		description: "TUI.enterPinned SHALL write ALT_SCREEN_ENTER at most once until a matching leave",
	},
	"POST-PV-12": {
		verification: "test",
		description: "opening a fullscreen overlay while pinned SHALL NOT write a second ALT_SCREEN_ENTER when pin already owns the alt screen",
	},
	"POST-PV-13": {
		verification: "test",
		description: "TUI.stop SHALL leave the alt screen at most once",
	},
	"POST-PV-14": {
		verification: "test",
		description: "Viewport page-navigation keys SHALL reach PinnedViewport.scrollBy before editor input",
	},
	"POST-PV-15": {
		verification: "test",
		description: "PinnedViewport.composeFrame SHALL clip an oversized dock from the top, keeping the editor and at least PINNED_MIN_TRANSCRIPT_ROWS",
	},
	"POST-PV-16": {
		verification: "test",
		description: "when following is false, PinnedViewport.composeFrame SHALL keep scrollTop frozen while content appends",
	},
	"POST-PV-17": {
		verification: "test",
		description: "PinnedViewport.scrollBy SHALL pause following on scroll up and resume following on landing at the transcript tail",
	},
	"POST-PV-18": {
		verification: "test",
		description: "PinnedViewport.composeFrame SHALL NOT start following solely because of dock mutation",
	},
	"POST-PV-19": {
		verification: "test",
		description: "PinnedViewport.composeFrame following=true SHALL pin the window to the transcript tail",
	},
	"POST-PV-20": {
		verification: "test",
		description: "PINNED_MIN_TRANSCRIPT_ROWS constant SHALL equal 3",
	},
	"POST-PV-25": {
		verification: "test",
		description: "TUI.enterPinned SHALL activate pinned rendering without emitting PINNED mouse-reporting sequences ?1002h or ?1006h for ordinary pointer selection",
	},
	"POST-PV-26": {
		verification: "execution",
		description: "In the real Ghostty and Herdr/tmux environment, ordinary pinned transcript drag selection and host copy SHALL remain terminal-native and pane-confined",
	},
	"POST-PV-27": {
		verification: "test",
		description: "TUI SHALL enable fullscreen-overlay mouse reporting only when the top visible fullscreen overlay has mouseTracking === true; omitted and false SHALL leave terminal pointer behavior unclaimed",
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
		description: "TUI.#doRender SHALL enable terminal mouse reporting after the top visible fullscreen overlay explicitly requests pointer interaction with mouseTracking === true, and SHALL disable reporting when that ownership ends",
	},
	"SEQ-PV-4": {
		verification: "test",
		description: "Composer.renderFrame SHALL provide the full accumulated transcript history to PinnedViewport on every interactive frame, caching settled blocks",
	},
	"SEQ-PV-6": {
		verification: "test",
		description: "opening a fullscreen overlay while pinned SHALL check alt-screen ownership before emitting DECSET 1049h",
	},
	"SEQ-PV-10": {
		verification: "test",
		description: "TUI.enterPinned SHALL establish pinned state and alternate-screen ownership before its first frame while leaving ordinary pointer selection unclaimed by writing neither ?1002h nor ?1006h. Source: REQ-2026-PINNED-001, IP-PV-1",
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
		description: "While an explicitly pointer-interactive fullscreen overlay owns mouse tracking, TUI SHALL NOT drop concatenated SGR mouse reports arriving in one stdin chunk; ordinary pinned mode leaves those reports unclaimed",
	},
	"INV-PV-5": {
		verification: "test",
		description: "TUI SHALL NOT overwrite transcript content rows with navigation or follow hints",
	},
	"INV-PV-6": {
		verification: "tool",
		description: "Implementation modules SHALL NOT import this contract file (CL11-F)",
	},
	"INV-PV-7": {
		verification: "test",
		description: "TUI SHALL NOT expose or honor an inline/unpinned viewport setting or code path",
	},
	"INV-PV-8": {
		verification: "test",
		description: "PinnedViewport dock SHALL occupy the last dockHeight rows of the physical frame",
	},
	"INV-PV-9": {
		verification: "test",
		description: "pinned mode SHALL NOT pin the dock by setting a terminal scrolling region (DECSTBM)",
	},
	"INV-PV-10": {
		verification: "test",
		description: "interactive paint SHALL NOT emit retired transcript rows to native scrollback",
	},
	"INV-PV-15": {
		verification: "test",
		description: "TUI SHALL NOT write ?1002h or ?1006h solely because pinned mode is active",
	},
	"INV-PV-16": {
		verification: "test",
		description: "A fullscreen overlay with mouseTracking omitted or false SHALL NOT enable terminal mouse reporting",
	},
	"LIFETIME_INV-PV-1": {
		verification: "test",
		description: "From pinned entry through explicit fullscreen-overlay ownership transfer, pinned exit, and stop, TUI SHALL enable and release only terminal modes it owns; ordinary pinned mode SHALL never acquire ?1002h or ?1006h ownership",
	},
	"FORBIDDEN-PV-1": {
		verification: "test",
		description: "While an explicitly pointer-interactive fullscreen overlay owns mouse tracking, a multi-report SGR chunk SHALL NOT be dropped or return null/unhandled",
	},
	"FORBIDDEN-PV-5": {
		verification: "test",
		description: "TUI SHALL NOT emit OSC 52 or reconstruct application-owned selected bytes in response to an ordinary pinned pointer gesture",
	},
	"FORBIDDEN-PV-7": {
		verification: "test",
		description: "TUI SHALL NOT apply an ordinary pinned SGR wheel report to PinnedViewport.scrollBy; application-owned wheel scrolling is deferred to terminal-native behavior",
	},
	"FORBIDDEN-PV-8": {
		verification: "test",
		description: "TUI.#handlePinnedInput SHALL NOT consume an ordinary pinned SGR pointer report unless an explicitly pointer-interactive fullscreen overlay owns the input",
	},
	"FORBIDDEN-PV-9": {
		verification: "tool",
		description: "The pinned input implementation SHALL not import or invoke an SGR parser for ordinary pinned input; a bounded production-source policy scan discharges this internal non-observable prohibition",
	},
	"ERRORS-PV-1": {
		verification: "test",
		description: "validateComposeHeight SHALL throw InvalidHeightError citing PRE-PV-1 on non-positive height",
	},
	"ERRORS-PV-2": {
		verification: "test",
		description: "validateSgrMouseReports SHALL throw InvalidMouseInputError citing PRE-PV-2 on non-string input",
	},
	"ERRORS-PV-6": {
		verification: "test",
		description: "For an ordinary pinned pointer gesture, TUI SHALL intentionally perform no application copy and throw no exception because the terminal owns selection; error class: none; propagation: none",
	},
} as const satisfies Record<string, ContractClause>;
