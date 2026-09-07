/**
 * Pinned jitter-free scroll and highlight-copy - specification authority.
 *
 * Implementation SHALL NOT import this module (CL11-F).
 * TypeScript 7 / erasable: no enum, no namespaces, no parameter properties.
 */

export type ClauseVerification = "test" | "execution" | "tool";

export interface Clause {
	readonly verification: ClauseVerification;
	readonly text: string;
}

export class PinnedJitterCopyContractError extends Error {
	readonly clauseId: string;
	constructor(clauseId: string, message: string) {
		super(`${clauseId} violation: ${message}`);
		this.name = "PinnedJitterCopyContractError";
		this.clauseId = clauseId;
	}
}

/** SGR mouse report prefix (CSI <). */
export const SGR_MOUSE_PREFIX = "\x1b[<";

/** OSC 52 clipboard write prefix used on copy. */
export const OSC52_CLIPBOARD_PREFIX = "\x1b]52;c;";

/** Wheel lines applied per SGR wheel event (must match pinned-composer). */
export const PINNED_WHEEL_SCROLL_LINES = 3;

/**
 * Pinned mouse enter: SGR encoding (1006) required.
 * Button-event tracking (1002) MAY stay so in-app drag selection receives motion.
 */
export const PINNED_MOUSE_SGR = "\x1b[?1006h";
export const PINNED_MOUSE_BUTTON_EVENT = "\x1b[?1002h";

export interface SgrMouseEventShape {
	readonly button: number;
	readonly col: number;
	readonly row: number;
	readonly release: boolean;
	readonly wheel: -1 | 1 | null;
	readonly motion: boolean;
	readonly leftClick: boolean;
}

const SGR_ONE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

export function decodeOneSgr(button: number, col: number, row: number, suffix: string): SgrMouseEventShape {
	const release = suffix === "m";
	const wheel = button & 64 ? ((button & 1 ? 1 : -1) as 1 | -1) : null;
	const motion = (button & 32) !== 0 && wheel === null;
	const leftClick = !release && wheel === null && !motion && (button & 3) === 0;
	return { button, col: col - 1, row: row - 1, release, wheel, motion, leftClick };
}

/**
 * POST-1: extract every SGR mouse report from a possibly concatenated buffer.
 */
export function validateSgrMouseStream(data: unknown): readonly SgrMouseEventShape[] {
	if (typeof data !== "string") {
		throw new PinnedJitterCopyContractError("PRE-1", "SGR stream input must be a string");
	}
	const events: SgrMouseEventShape[] = [];
	SGR_ONE.lastIndex = 0;
	for (const match of data.matchAll(SGR_ONE)) {
		events.push(decodeOneSgr(Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? "M"));
	}
	return events;
}

/**
 * POST-2: net wheel delta in lines for a stdin chunk.
 */
export function validateWheelDeltaLines(data: string): number {
	let notches = 0;
	for (const event of validateSgrMouseStream(data)) {
		if (event.wheel === -1) notches -= 1;
		else if (event.wheel === 1) notches += 1;
	}
	return notches * PINNED_WHEEL_SCROLL_LINES;
}

export function validateOsc52Copy(writes: readonly string[], expectedPlaintext: string): void {
	const blob = writes.join("");
	if (!blob.includes(OSC52_CLIPBOARD_PREFIX)) {
		throw new PinnedJitterCopyContractError("POST-3", "clipboard write missing OSC 52 prefix");
	}
	const encoded = Buffer.from(expectedPlaintext, "utf8").toString("base64");
	if (!blob.includes(encoded)) {
		throw new PinnedJitterCopyContractError("POST-3", "OSC 52 payload does not match selected plaintext");
	}
}

export function validateFollowHintNotInTranscript(
	frameLines: readonly string[],
	transcriptRowCount: number,
	followNeedle: string,
): void {
	for (let i = 0; i < transcriptRowCount && i < frameLines.length; i++) {
		if ((frameLines[i] ?? "").includes(followNeedle)) {
			throw new PinnedJitterCopyContractError(
				"POST-6",
				"follow hint overwrote a transcript content row",
			);
		}
	}
}

export const CONTRACT_PINNED_JITTER_COPY = {
	"PRE-1": {
		verification: "test",
		text: "SGR mouse stream parse input SHALL be a string",
	},
	"POST-1": {
		verification: "test",
		text: "parse of a stdin chunk SHALL return every SGR mouse report in order, including concatenated reports in one chunk",
	},
	"POST-2": {
		verification: "test",
		text: "the pinned mouse handler SHALL scroll by the summed wheel delta of all wheel reports in the chunk (PINNED_WHEEL_SCROLL_LINES per notch)",
	},
	"POST-3": {
		verification: "test",
		text: "left-button press, drag, and release on transcript rows SHALL copy the selected visible plaintext to the clipboard via OSC 52",
	},
	"POST-4": {
		verification: "test",
		text: "pinned mouse-enter SHALL include SGR encoding 1006; button-event 1002 MAY remain only to feed POST-3 drag motion",
	},
	"POST-5": {
		verification: "test",
		text: "Composer pinned renderFrame SHALL NOT call TranscriptContainer.render (unbounded full history); pinnedScroll SHALL be produced by a windowed path whose length is at most the physical row count",
	},
	"POST-6": {
		verification: "test",
		text: "when following is false, TUI SHALL NOT replace a transcript content row with a follow-key hint",
	},
	"INV-1": {
		verification: "test",
		text: "the editor dock SHALL remain the last rows of the physical frame",
	},
	"INV-2": {
		verification: "test",
		text: "implementation SHALL NOT import this contract module",
	},
	"SEQ-1": {
		verification: "test",
		text: "TUI.#handlePinnedInput SHALL stream-parse SGR before calling PinnedViewport.scrollBy (IP-DM-1)",
	},
	"SEQ-2": {
		verification: "test",
		text: "Composer.renderFrame pinned branch SHALL obtain transcript rows from a windowed renderer, not TranscriptContainer.render (IP-DM-3)",
	},
	"FORBIDDEN-1": {
		verification: "test",
		text: "a concatenated multi-report SGR chunk SHALL NOT be dropped as unparsed",
	},
	"ERRORS-1": {
		verification: "test",
		text: "validateSgrMouseStream SHALL throw PinnedJitterCopyContractError citing PRE-1 when the input is not a string; a string with no SGR reports SHALL return an empty list",
	},
} as const satisfies Record<string, Clause>;
