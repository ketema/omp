/**
 * CL11 Canonical Contract: Pinned Viewport, Software Scrollback, and Pane-Confined Selection
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
export const PINNED_WHEEL_SCROLL_LINES = 3;
export const PINNED_ALT_SCREEN_ENTER = "\x1b[?1049h";
export const PINNED_ALT_SCREEN_LEAVE = "\x1b[?1049l";
export const PINNED_MOUSE_SGR_ENTER = "\x1b[?1006h";
export const PINNED_MOUSE_BUTTON_ENTER = "\x1b[?1002h";
export const OSC52_CLIPBOARD_PREFIX = "\x1b]52;c;";
export const SELECTION_HIGHLIGHT_START = "\x1b[7m";
export const SELECTION_HIGHLIGHT_END = "\x1b[27m";
export const PINNED_CLIPBOARD_FAILURE_PREFIX = "Pinned selection copy failed:";

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

export class InvalidPinnedSelectionError extends PinnedDockContractError {
	constructor(selection: unknown) {
		super("PRE-PV-3", `Pinned clipboard selection must be a non-empty string, got ${String(selection)}`);
	}
}

export class InvalidPinnedClipboardDeliveryResultError extends PinnedDockContractError {
	constructor(message: string) {
		super("INV-PV-11", message);
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

export interface SelectionSpan {
	readonly startRow: number;
	readonly startCol: number;
	readonly endRow: number;
	readonly endCol: number;
}

export type NativeClipboardCopyStatus = "resolved" | "failed";

export interface PinnedClipboardDeliveryResult {
	readonly osc52Attempted: boolean;
	readonly nativeCopy: NativeClipboardCopyStatus;
	readonly nativeFailure?: Error;
}

export type PinnedClipboardFailureHandler = (failure: Error) => void;

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

export function validatePinnedClipboardSelection(selection: unknown): asserts selection is string {
	if (typeof selection !== "string" || selection.length === 0) {
		throw new InvalidPinnedSelectionError(selection);
	}
}

export function validatePinnedClipboardDeliveryResult(
	result: unknown,
): asserts result is PinnedClipboardDeliveryResult {
	if (typeof result !== "object" || result === null) {
		throw new InvalidPinnedClipboardDeliveryResultError("clipboard delivery result must be an object");
	}
	const candidate = result as Partial<PinnedClipboardDeliveryResult>;
	if (candidate.osc52Attempted !== true) {
		throw new InvalidPinnedClipboardDeliveryResultError(
			"OSC 52 compatibility emission must be attempted before evaluating native delivery",
		);
	}
	if (candidate.nativeCopy !== "resolved" && candidate.nativeCopy !== "failed") {
		throw new InvalidPinnedClipboardDeliveryResultError("nativeCopy must be either resolved or failed");
	}
	if (candidate.nativeCopy === "resolved" && candidate.nativeFailure !== undefined) {
		throw new InvalidPinnedClipboardDeliveryResultError(
			"resolved native delivery must not retain a native failure",
		);
	}
	if (candidate.nativeCopy === "failed" && !(candidate.nativeFailure instanceof Error)) {
		throw new InvalidPinnedClipboardDeliveryResultError(
			"failed native delivery must retain its normalized Error",
		);
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
	"PRE-PV-3": {
		verification: "test",
		description: "Pinned ClipboardTransport SHALL receive a non-empty ANSI-stripped selection string after visual-cell extraction",
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
		description: "Left-button drag across transcript rows SHALL capture exact ANSI-stripped plaintext from pane-local visual cells using visual column widths",
	},
	"POST-PV-6b": {
		verification: "test",
		description: "For each non-empty pane-local selection, TUI SHALL attempt OSC 52 compatibility emission containing that same plaintext; OSC 52 emission or lack of acknowledgment SHALL NOT establish local copy success",
	},
	"POST-PV-7": {
		verification: "test",
		description: "Composer pinned renderFrame SHALL NOT permanently consume available viewport rows with unretired startup headers when active session messages exist; retired header sits at index 0 of history",
	},
	"POST-PV-8": {
		verification: "test",
		description: "Fullscreen overlay display SHALL NOT write PINNED_MOUSE_LEAVE (?1006l) while an overlay requests mouse tracking, keeping SGR 1006 active",
	},
	"POST-PV-9": {
		verification: "test",
		description: "PinnedViewport.composeFrame SHALL apply visual inverse video styling (\x1b[7m...\x1b[27m) to cells within an active in-app selection drag",
	},
	"POST-PV-10": {
		verification: "test",
		description: "TUI.#handlePinnedInput SHALL only commit drag selection to clipboard on release of mouse button 0 (left click)",
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
		description: "wheel and viewport page keys SHALL reach PinnedViewport.scrollBy before editor input",
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
	"POST-PV-21": {
		verification: "test",
		description: "For every non-empty pinned selection, ClipboardTransport SHALL invoke the existing native macOS clipboard provider with the captured plaintext; native provider resolution SHALL be the sole local-success predicate",
	},
	"POST-PV-22": {
		verification: "test",
		description: "When the native provider resolves, TUI SHALL not invoke the pinned clipboard failure handler solely because OSC 52 has no acknowledgment or compatibility delivery is unavailable",
	},
	"POST-PV-23": {
		verification: "test",
		description: "When the native provider rejects or throws, TUI SHALL invoke its registered pinned clipboard failure handler exactly once with the normalized Error",
	},
	"POST-PV-24": {
		verification: "test",
		description: "InteractiveMode SHALL register the pinned clipboard failure handler so a native delivery failure invokes InteractiveMode.showError and not a pinned-local banner or status-only surface",
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
		description: "Composer.renderFrame SHALL provide the full accumulated transcript history to PinnedViewport on every interactive frame, caching settled blocks",
	},
	"SEQ-PV-5": {
		verification: "test",
		description: "TUI SHALL reset active drag selection state when an overlay steals focus or when pinned mode exits",
	},
	"SEQ-PV-6": {
		verification: "test",
		description: "opening a fullscreen overlay while pinned SHALL check alt-screen ownership before emitting DECSET 1049h",
	},
	"SEQ-PV-7": {
		verification: "test",
		description: "TUI.#copySelectedTranscriptToClipboard SHALL invoke ClipboardTransport after visual-cell extraction; ClipboardTransport SHALL attempt OSC 52 before native delivery; TUI SHALL invoke its failure handler after a failed native result. Source: REQ-2026-PINNED-001, SEQ-PV-4, SEQ-PV-5, IP-PV-1, IP-PV-2",
	},
	"SEQ-PV-8": {
		verification: "test",
		description: "InteractiveMode SHALL register its TUI pinned clipboard failure handler after UiHelpers creation and before user input can complete a pinned selection; the handler SHALL invoke showError after a failed native result. Source: REQ-2026-PINNED-001, SEQ-PV-5, IP-PV-2",
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
	"INV-PV-11": {
		verification: "test",
		description: "Pinned ClipboardTransport SHALL preserve a native provider rejection or throw as nativeCopy=failed with a normalized Error; OSC 52 emission SHALL NOT convert that result to success",
	},
	"FORBIDDEN-PV-1": {
		verification: "test",
		description: "A multi-report SGR chunk SHALL NOT be dropped or return null/unhandled",
	},
	"FORBIDDEN-PV-2": {
		verification: "test",
		description: "Pinned clipboard delivery SHALL NOT read back from the native clipboard to infer, replace, or validate the selected payload",
	},
	"FORBIDDEN-PV-3": {
		verification: "test",
		description: "A native pinned clipboard failure SHALL NOT invoke InteractiveMode.showPinnedError or InteractiveMode.showStatus in place of showError",
	},
	"ERRORS-PV-1": {
		verification: "test",
		description: "validateComposeHeight SHALL throw InvalidHeightError citing PRE-PV-1 on non-positive height",
	},
	"ERRORS-PV-2": {
		verification: "test",
		description: "validateSgrMouseReports SHALL throw InvalidMouseInputError citing PRE-PV-2 on non-string input",
	},
	"ERRORS-PV-3": {
		verification: "test",
		description: "validatePinnedClipboardSelection SHALL throw InvalidPinnedSelectionError citing PRE-PV-3 for an empty or non-string delivery input; no clipboard delivery is permitted",
	},
	"ERRORS-PV-4": {
		verification: "test",
		description: "ClipboardTransport SHALL catch a native provider rejection or thrown value, normalize it to Error in a nativeCopy=failed result, and not propagate the native exception; InteractiveMode SHALL present that result through showError exactly once",
	},
} as const satisfies Record<string, ContractClause>;
