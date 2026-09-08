/**
 * Software transcript window with a dock pinned to the bottom rows.
 * Scroll position is application state. This module does not paint CSI
 * and does not import the specification file.
 */

import { sliceByColumn, visibleWidth } from "./utils";

export const PINNED_MIN_TRANSCRIPT_ROWS = 3;
export const PINNED_WHEEL_SCROLL_LINES = 3;
export const PINNED_MOUSE_ENTER = "\x1b[?1002h\x1b[?1006h";
export const PINNED_MOUSE_LEAVE = "\x1b[?1006l\x1b[?1002l";
export const ALT_SCREEN_ENTER = "\x1b[?1049h";
export const ALT_SCREEN_LEAVE = "\x1b[?1049l";

// INV-PV-7: the only viewport mode this module honors. There is no
// inline/unpinned member — an "inline" value is structurally unrepresentable,
// not merely runtime-rejected.
export type ViewportMode = "pinned";

/** INV-PV-7: type guard used by callers validating an external/cached value; rejects "inline". */
export function isViewportMode(value: unknown): value is ViewportMode {
	return value === "pinned";
}
// Redeclared locally per CL11-F (this module does not import the contract
// file); tests bridge these against the contract's own equivalents.
const SELECTION_HIGHLIGHT_START = "\x1b[7m";
const SELECTION_HIGHLIGHT_END = "\x1b[27m";

/** Base error for pinned-dock contract violations; `clauseId` identifies which one. */
export class PinnedDockContractError extends Error {
	readonly clauseId: string;
	constructor(clauseId: string, message: string) {
		super(`${clauseId} violation: ${message}`);
		this.name = "PinnedDockContractError";
		this.clauseId = clauseId;
	}
}

/** PRE-PV-1: composeFrame's `height` option must be a finite number >= 1. */
export class InvalidHeightError extends PinnedDockContractError {
	constructor(height: unknown) {
		super("PRE-PV-1", `Terminal height must be a finite number >= 1, got ${String(height)}`);
	}
}

/** Window-relative span (rows within the composed window) of an active in-app drag selection. */
export interface SelectionSpan {
	readonly startRow: number;
	readonly startCol: number;
	readonly endRow: number;
	readonly endCol: number;
}

export interface ComposeFrameOptions {
	readonly transcript: readonly string[];
	readonly dock: readonly string[];
	readonly height: number;
	/** Active in-app transcript drag selection to inverse-highlight (POST-PV-9). */
	readonly selection?: SelectionSpan;
}

export interface ScrollInfo {
	readonly following: boolean;
	readonly linesBelow: number;
	readonly linesAbove: number;
}

export function clippedPinnedDockHeight(dockLength: number, height: number): number {
	const maxDock = Math.max(0, Math.trunc(height) - PINNED_MIN_TRANSCRIPT_ROWS);
	return Math.min(Math.max(0, dockLength), maxDock);
}

export class PinnedViewport {
	#scrollTop = 0;
	#following = true;
	#lastMaxScroll = 0;
	#lastWindowHeight = 0;

	/**
	 * Compose a frame of exactly `height` lines: scrolled transcript window on
	 * top, dock pinned to the bottom. Following pins the window to the
	 * transcript end; otherwise it stays frozen while content appends.
	 */
	composeFrame(options: ComposeFrameOptions): string[] {
		const height = Math.trunc(options.height);
		if (!Number.isFinite(height) || height < 1) {
			// PRE-PV-1 / ERRORS-PV-1: reject a non-finite or non-positive height.
			throw new InvalidHeightError(options.height);
		}
		let dockLines = [...options.dock];
		const dockHeight = clippedPinnedDockHeight(dockLines.length, height);
		if (dockLines.length > dockHeight) {
			dockLines = dockLines.slice(dockLines.length - dockHeight);
		}
		const windowHeight = height - dockLines.length;
		const maxScroll = Math.max(0, options.transcript.length - windowHeight);

		if (this.#following) {
			this.#scrollTop = maxScroll;
		} else {
			this.#scrollTop = Math.max(0, Math.min(this.#scrollTop, maxScroll));
		}
		this.#lastMaxScroll = maxScroll;
		this.#lastWindowHeight = windowHeight;

		const window = options.transcript.slice(this.#scrollTop, this.#scrollTop + windowHeight);
		this.#highlightSelection(window, options.selection);
		while (window.length < windowHeight) {
			window.push("");
		}
		return [...window, ...dockLines];
	}

	/** POST-PV-9: inverse-video the active in-app drag selection's window-relative cells. */
	#highlightSelection(window: string[], selection: SelectionSpan | undefined): void {
		if (!selection) return;
		const flip =
			selection.startRow > selection.endRow ||
			(selection.startRow === selection.endRow && selection.startCol > selection.endCol);
		const startRow = flip ? selection.endRow : selection.startRow;
		const startCol = flip ? selection.endCol : selection.startCol;
		const endRow = flip ? selection.startRow : selection.endRow;
		const endCol = flip ? selection.startCol : selection.endCol;
		for (let row = Math.max(0, startRow); row <= endRow && row < window.length; row++) {
			const line = window[row]!;
			const width = visibleWidth(line);
			const from = Math.min(row === startRow ? Math.max(0, startCol) : 0, width);
			// Closed cell interval: the end row's highlight includes endCol itself.
			const to = Math.min(row === endRow ? Math.max(0, endCol) + 1 : width, width);
			if (to <= from) continue;
			const before = sliceByColumn(line, 0, from);
			const selected = Bun.stripANSI(sliceByColumn(line, from, to - from));
			const after = sliceByColumn(line, to, Math.max(0, width - to));
			window[row] = `${before}${SELECTION_HIGHLIGHT_START}${selected}${SELECTION_HIGHLIGHT_END}${after}`;
		}
	}

	/** Scrolling up pauses following; reaching the bottom resumes it. */
	scrollBy(delta: number): void {
		const base = this.#following ? this.#lastMaxScroll : this.#scrollTop;
		this.#scrollTop = Math.max(0, Math.min(base + delta, this.#lastMaxScroll));
		this.#following = this.#scrollTop >= this.#lastMaxScroll;
	}

	scrollToTop(): void {
		this.#scrollTop = 0;
		this.#following = this.#lastMaxScroll === 0;
	}

	scrollToBottom(): void {
		this.#scrollTop = this.#lastMaxScroll;
		this.#following = true;
	}

	pageSize(): number {
		return Math.max(1, this.#lastWindowHeight - 1);
	}

	windowHeight(): number {
		return this.#lastWindowHeight;
	}

	isFollowing(): boolean {
		return this.#following;
	}

	scrollTop(): number {
		return this.#scrollTop;
	}

	scrollInfo(): ScrollInfo {
		return {
			following: this.#following,
			linesBelow: Math.max(0, this.#lastMaxScroll - this.#scrollTop),
			linesAbove: this.#scrollTop,
		};
	}
}
