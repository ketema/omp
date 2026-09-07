/**
 * Pinned composer viewport contract — specification authority.
 *
 * Implementation SHALL NOT import this module (CL11-F).
 * Tests import both this file and the implementation and assert alignment.
 */

export type ViewportMode = "inline" | "pinned";

export type ClauseVerification = "test" | "execution" | "tool";

export interface Clause {
	readonly verification: ClauseVerification;
	readonly text: string;
}

export class PinnedComposerContractError extends Error {
	readonly clauseId: string;
	constructor(clauseId: string, message: string) {
		super(`${clauseId} violation: ${message}`);
		this.name = "PinnedComposerContractError";
		this.clauseId = clauseId;
	}
}

export const VIEWPORT_MODES = ["inline", "pinned"] as const;
export const DEFAULT_VIEWPORT_MODE: ViewportMode = "pinned";
export const PINNED_MIN_TRANSCRIPT_ROWS = 3;
export const PINNED_WHEEL_SCROLL_LINES = 3;
export const PINNED_MOUSE_ENTER = "\x1b[?1002h\x1b[?1006h";
export const PINNED_MOUSE_LEAVE = "\x1b[?1006l\x1b[?1002l";
export const ALT_SCREEN_ENTER = "\x1b[?1049h";
export const ALT_SCREEN_LEAVE = "\x1b[?1049l";

export interface ComposeFrameInput {
	readonly transcript: readonly string[];
	readonly dock: readonly string[];
	readonly height: number;
}

export interface ComposeFrameResult {
	readonly frame: readonly string[];
	readonly windowHeight: number;
	readonly dockHeight: number;
	readonly scrollTop: number;
	readonly following: boolean;
}

export interface ScrollInfo {
	readonly following: boolean;
	readonly linesBelow: number;
	readonly linesAbove: number;
}

export function validateViewportMode(value: unknown): ViewportMode {
	if (value === "inline" || value === "pinned") return value;
	throw new PinnedComposerContractError(
		"PRE-MODE-1",
		`viewport mode must be "inline" or "pinned", got ${String(value)}`,
	);
}

export function validateComposeHeight(height: number): number {
	if (!Number.isFinite(height) || height < 1) {
		throw new PinnedComposerContractError("PRE-1", `height must be a finite number >= 1, got ${String(height)}`);
	}
	return Math.trunc(height);
}

export function clippedPinnedDockHeight(dockLength: number, height: number): number {
	const safeHeight = validateComposeHeight(height);
	const maxDock = Math.max(0, safeHeight - PINNED_MIN_TRANSCRIPT_ROWS);
	return Math.min(Math.max(0, dockLength), maxDock);
}

export const CONTRACT_PINNED_COMPOSER = {
	"PRE-MODE-1": {
		verification: "test",
		text: 'tui.viewport SHALL be the literal "inline" or "pinned"',
	},
	"PRE-1": {
		verification: "test",
		text: "composeFrame height SHALL be a finite number >= 1",
	},
	"POST-1": {
		verification: "test",
		text: "composeFrame SHALL return a frame whose length equals height",
	},
	"POST-2": {
		verification: "test",
		text: "composeFrame SHALL place dock rows (clipped from the top if needed) as the last dockHeight rows",
	},
	"POST-3": {
		verification: "test",
		text: "composeFrame SHALL reserve at least PINNED_MIN_TRANSCRIPT_ROWS for the transcript window when height allows",
	},
	"POST-4": {
		verification: "test",
		text: "when following is true, composeFrame SHALL pin scrollTop to maxScroll (transcript tail)",
	},
	"POST-5": {
		verification: "test",
		text: "when following is false, composeFrame SHALL keep scrollTop unchanged except to clamp into [0, maxScroll]",
	},
	"POST-6": {
		verification: "test",
		text: "scrollBy(delta) SHALL pause following when the result is above the tail and resume following when the result is at the tail",
	},
	"POST-7": {
		verification: "test",
		text: "printable editor input SHALL NOT set following true or change scrollTop",
	},
	"POST-8": {
		verification: "test",
		text: "while pinned, Composer.renderFrame SHALL omit HistoryBatch",
	},
	"POST-9": {
		verification: "test",
		text: "TUI.enterPinned SHALL write ALT_SCREEN_ENTER at most once until a matching leave",
	},
	"POST-10": {
		verification: "test",
		text: "opening a fullscreen overlay while pinned SHALL NOT write a second ALT_SCREEN_ENTER",
	},
	"INV-1": {
		verification: "test",
		text: "while pinned the editor dock SHALL occupy the last dockHeight rows of the physical frame",
	},
	"INV-2": {
		verification: "test",
		text: "implementation SHALL NOT import this contract module",
	},
	"FORBIDDEN-1": {
		verification: "test",
		text: "pinned mode SHALL NOT emit HistoryBatch rows to native scrollback",
	},
	"FORBIDDEN-2": {
		verification: "test",
		text: "pinned mode SHALL NOT use DECSTBM (CSI r) to pin the dock",
	},
	"SEQ-1": {
		verification: "test",
		text: "Composer.start SHALL call TUI.enterPinned after ui.start when viewport is pinned",
	},
	"SEQ-2": {
		verification: "test",
		text: "wheel and viewport page keys SHALL reach PinnedViewport.scrollBy before the focused editor handleInput",
	},
	"SEQ-3": {
		verification: "test",
		text: "Composer.setPreferences SHALL enter pinned mode when viewport is pinned and leave it when viewport is inline",
	},
	"ERRORS-1": {
		verification: "test",
		text: "validateViewportMode and validateComposeHeight SHALL throw PinnedComposerContractError citing the clause id; PinnedViewport.composeFrame SHALL throw Error whose message contains PRE-1",
	},
} as const satisfies Record<string, Clause>;
