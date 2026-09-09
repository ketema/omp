/**
 * Pinned composer viewport — specification authority (WHAT, not HOW).
 *
 * IKG: Concept "Design by Contract" (Meyer, IEEE Computer 1992; Hoare Logic).
 * Contract is specification — NOT implementation. ArchitecturalPrinciple
 * "Contract-Implementation Independence" GOVERNS this file.
 *
 * Interactive OMP is always pinned. There is no inline mode.
 * Implementation SHALL NOT import this module (CL11-F).
 * Tests import both this file and the implementation and assert alignment.
 *
 * TypeScript 7 / erasable: no enum keyword, no namespaces, no parameter properties.
 * Pattern "Idiomatic Per-Ecosystem Distribution": TS as const + throw, not icontract.
 */

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

export const PINNED_MIN_TRANSCRIPT_ROWS = 3;
export const PINNED_WHEEL_SCROLL_LINES = 3;
export const PINNED_MOUSE_ENTER = "\x1b[?1002h\x1b[?1006h";
export const PINNED_MOUSE_LEAVE = "\x1b[?1006l\x1b[?1002l";
export const ALT_SCREEN_ENTER = "\x1b[?1049h";
export const ALT_SCREEN_LEAVE = "\x1b[?1049l";
export const FOLLOW_KEYBINDING = "tui.viewport.follow";
export const PAGE_UP_KEYBINDING = "tui.viewport.pageUp";
export const PAGE_DOWN_KEYBINDING = "tui.viewport.pageDown";
export const TOP_KEYBINDING = "tui.viewport.top";
export const VIEWPORT_SETTING_PATH = "tui.viewport";

export interface ComposeFrameInput {
	readonly transcript: readonly string[];
	readonly dock: readonly string[];
	readonly height: number;
}

export interface ScrollInfo {
	readonly following: boolean;
	readonly linesBelow: number;
	readonly linesAbove: number;
}

export function validateComposeHeight(height: unknown): number {
	if (typeof height !== "number" || !Number.isFinite(height) || height < 1) {
		throw new PinnedComposerContractError(
			"PRE-1",
			`height must be a finite number >= 1, got ${String(height)}`,
		);
	}
	return Math.trunc(height);
}

export function clippedPinnedDockHeight(dockLength: number, height: number): number {
	const safeHeight = validateComposeHeight(height);
	const maxDock = Math.max(0, safeHeight - PINNED_MIN_TRANSCRIPT_ROWS);
	return Math.min(Math.max(0, dockLength), maxDock);
}

export const CONTRACT_PINNED_COMPOSER = {
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
		text: "the last dockHeight rows of the returned frame SHALL equal the dock (top-clipped when the dock is taller than the reserved dock band)",
	},
	"POST-3": {
		verification: "test",
		text: "when height allows, at least PINNED_MIN_TRANSCRIPT_ROWS of the frame SHALL be transcript, not dock",
	},
	"POST-4": {
		verification: "test",
		text: "when following is true, the visible transcript SHALL be the tail",
	},
	"POST-5": {
		verification: "test",
		text: "when following is false, newly appended transcript SHALL NOT change which transcript rows are visible except to clamp if the window would sit past the end",
	},
	"POST-6": {
		verification: "test",
		text: "a scroll that leaves the tail SHALL pause following; a scroll that lands on the tail SHALL resume following",
	},
	"POST-7": {
		verification: "test",
		text: "printable editor input SHALL NOT start following and SHALL NOT change which transcript rows are visible",
	},
	"POST-8": {
		verification: "test",
		text: "every interactive frame SHALL omit retired native-scrollback batches",
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
		text: "the editor dock SHALL occupy the last dockHeight rows of the physical frame",
	},
	"INV-2": {
		verification: "test",
		text: "implementation SHALL NOT import this contract module",
	},
	"FORBIDDEN-1": {
		verification: "test",
		text: "interactive paint SHALL NOT emit retired transcript rows to native scrollback",
	},
	"FORBIDDEN-2": {
		verification: "test",
		text: "pinned mode SHALL NOT pin the dock by setting a terminal scrolling region",
	},
	"FORBIDDEN-3": {
		verification: "test",
		text: "SETTINGS_SCHEMA SHALL NOT contain tui.viewport; interactive sessions have no unpinned mode",
	},
	"SEQ-1": {
		verification: "test",
		text: "Composer.start SHALL call TUI.enterPinned after ui.start (IP-1/SEQ-1)",
	},
	"SEQ-2": {
		verification: "test",
		text: "wheel and viewport page keys SHALL reach PinnedViewport.scrollBy before the focused editor handleInput (IP-2, IP-3)",
	},
	"SEQ-3": {
		verification: "test",
		text: "fullscreen overlay enter SHALL NOT write ALT_SCREEN_ENTER when pin already owns the alt screen",
	},
	"SEQ-4": {
		verification: "test",
		text: "TUI.stop SHALL leave the alt screen at most once",
	},
	"SEQ-5": {
		verification: "test",
		text: "Composer.renderFrame SHALL hand TUI only pinnedScroll and pinnedDock (IP-1); no retired native-scrollback batch",
	},
	"ERRORS-1": {
		verification: "test",
		text: "validateComposeHeight SHALL throw PinnedComposerContractError citing PRE-1; PinnedViewport.composeFrame SHALL throw Error whose message contains PRE-1",
	},
} as const satisfies Record<string, Clause>;
