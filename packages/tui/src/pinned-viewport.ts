/**
 * Software transcript window with a dock pinned to the bottom rows.
 * Scroll position is application state. This module does not paint CSI
 * and does not import the specification file.
 */

export const PINNED_MIN_TRANSCRIPT_ROWS = 3;
export const PINNED_WHEEL_SCROLL_LINES = 3;
export const PINNED_MOUSE_ENTER = "\x1b[?1002h\x1b[?1006h";
export const PINNED_MOUSE_LEAVE = "\x1b[?1006l\x1b[?1002l";
export const ALT_SCREEN_ENTER = "\x1b[?1049h";
export const ALT_SCREEN_LEAVE = "\x1b[?1049l";

export type ViewportMode = "inline" | "pinned";

export function isViewportMode(value: unknown): value is ViewportMode {
	return value === "inline" || value === "pinned";
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
			throw new Error(`PRE-1 violation: height must be a finite number >= 1, got ${String(options.height)}`);
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
		while (window.length < windowHeight) {
			window.push("");
		}
		return [...window, ...dockLines];
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
