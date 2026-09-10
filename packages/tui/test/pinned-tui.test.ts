import { describe, expect, it } from "bun:test";
import { type Component, type Focusable, type TerminalFrameProvider, TUI, type ViewportSize } from "@oh-my-pi/pi-tui";
import {
	PINNED_ALT_SCREEN_ENTER as ALT_SCREEN_ENTER,
	PINNED_ALT_SCREEN_LEAVE as ALT_SCREEN_LEAVE,
	CONTRACT_PINNED_DOCK,
	InvalidMouseInputError,
	validateSgrMouseReports,
} from "../../../requirements/contracts/pinned_dock.contract";
import { VirtualTerminal } from "./virtual-terminal";

/**
 * Test Double: RecordingTerminal (Stub/Spy)
 * Wraps VirtualTerminal (kitty WASM engine) and records all written stream chunks.
 */
class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

/**
 * Test Double: EditorStub (Stub/Fake)
 * Implements Component and Focusable for TUI host integration testing.
 */
class EditorStub implements Component, Focusable {
	focused = false;
	text = "";
	readonly inputChunks: string[] = [];
	invalidate(): void {}
	render(): string[] {
		return [`PROMPT:${this.text}`];
	}
	handleInput(data: string): void {
		this.inputChunks.push(data);
		if (data.startsWith("\x1b")) return;
		this.text += data;
	}
}

/**
 * Test Double: PointerInteractiveOverlay (Spy)
 * Fullscreen overlay fixture that records every handleInput chunk. Used to
 * distinguish overlay-owned SGR delivery from ordinary unclaimed pinned input.
 * Double type: Spy. No collaborator contract replacement; injected as the overlay
 * component through TUI.showOverlay().
 */
class PointerInteractiveOverlay implements Component, Focusable {
	focused = false;
	readonly inputChunks: string[] = [];
	invalidate(): void {}
	render(): string[] {
		return ["POINTER_OVERLAY"];
	}
	handleInput(data: string): void {
		this.inputChunks.push(data);
	}
}

const PINNED_BUTTON_EVENT_1002 = "\x1b[?1002h";
const PINNED_SGR_EVENT_1006 = "\x1b[?1006h";
const OSC52_CLIPBOARD_WRITE = "\x1b]52;";

function countNeedle(haystacks: readonly string[], needle: string): number {
	let count = 0;
	for (const chunk of haystacks) {
		let from = 0;
		while (from < chunk.length) {
			const at = chunk.indexOf(needle, from);
			if (at < 0) break;
			count++;
			from = at + needle.length;
		}
	}
	return count;
}

const MOUSE_REPORTING_ENABLE_SEQUENCES = ["\x1b[?1000h", "\x1b[?1002h", "\x1b[?1003h", "\x1b[?1006h"] as const;
const MOUSE_REPORTING_DISABLE_SEQUENCES = ["\x1b[?1000l", "\x1b[?1002l", "\x1b[?1003l", "\x1b[?1006l"] as const;

function presentSequences(haystacks: readonly string[], needles: readonly string[]): string[] {
	const joined = haystacks.join("");
	return needles.filter(needle => joined.includes(needle));
}

describe("TUI pinned session integration (POST-PV-11..14, INV-PV-8..10, SEQ-PV-6)", () => {
	it("POST-PV-11: enterPinned writes ALT_SCREEN_ENTER at most once until a matching leave", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.enterPinned()
		 * - Enforces: POST-PV-11: TUI.enterPinned SHALL write ALT_SCREEN_ENTER at most once until a matching leave
		 * - Category: state-transition
		 * - Risk tier: High — duplicate DECSET 1049h corrupts terminal scrollback state
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-PV-11 existing in requirements/contracts/pinned_dock.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: primary check for alternate screen entrance idempotency
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		const term = new RecordingTerminal(40, 8, 100);
		const tui = new TUI(term, true);
		const editor = new EditorStub();
		tui.addChild(editor);
		tui.setFocus(editor);
		try {
			tui.start();
			tui.enterPinned();
			await term.waitForRender();
			const firstCount = countNeedle(term.writes, ALT_SCREEN_ENTER);
			expect(
				firstCount,
				`1. WHAT: enterPinned initial ALT_SCREEN_ENTER write FAILED
2. WHY: POST-PV-11 violation - enterPinned must write ALT_SCREEN_ENTER exactly once
3. EXPECTED: 1
4. ACTUAL: ${firstCount}
5. GUIDANCE: Enter alternate screen on pinned session start`,
			).toBe(1);

			// Idempotent second call
			tui.enterPinned();
			await term.waitForRender();
			const secondCount = countNeedle(term.writes, ALT_SCREEN_ENTER);
			expect(
				secondCount,
				`1. WHAT: enterPinned second call ALT_SCREEN_ENTER write FAILED
2. WHY: POST-PV-11 violation - subsequent enterPinned calls must not re-enter alternate screen
3. EXPECTED: 1
4. ACTUAL: ${secondCount}
5. GUIDANCE: Guard alternate screen entry with active state check`,
			).toBe(1);
		} finally {
			tui.stop();
		}
	});

	it("POST-PV-12 / SEQ-PV-6: opening a fullscreen overlay while pinned does not write a second ALT_SCREEN_ENTER", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.showOverlay()
		 * - Enforces: POST-PV-12 / SEQ-PV-6: fullscreen overlay enter SHALL NOT write ALT_SCREEN_ENTER when pin already owns the alt screen
		 * - Category: integration
		 * - Risk tier: High — duplicate alt-screen entry clears the terminal buffer unexpectedly
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clauses POST-PV-12 and SEQ-PV-6 existing in requirements/contracts/pinned_dock.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: checks overlay integration with pinned alt-screen ownership
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		const term = new RecordingTerminal(40, 8, 100);
		const tui = new TUI(term, true);
		const editor = new EditorStub();
		const overlay: Component = {
			invalidate() {},
			render: () => ["OVERLAY_CONTENT"],
		};
		tui.addChild(editor);
		tui.setFocus(editor);
		try {
			tui.start();
			tui.enterPinned();
			await term.waitForRender();
			expect(
				countNeedle(term.writes, ALT_SCREEN_ENTER),
				`1. WHAT: enterPinned setup FAILED
2. WHY: POST-PV-11 violation - enterPinned must write ALT_SCREEN_ENTER once
3. EXPECTED: 1
4. ACTUAL: ${countNeedle(term.writes, ALT_SCREEN_ENTER)}
5. GUIDANCE: Enter alternate screen once before overlay test`,
			).toBe(1);

			tui.showOverlay(overlay, { fullscreen: true, mouseTracking: true });
			await term.waitForRender();
			const afterOverlayCount = countNeedle(term.writes, ALT_SCREEN_ENTER);
			expect(
				afterOverlayCount,
				`1. WHAT: fullscreen overlay while pinned wrote duplicate ALT_SCREEN_ENTER
2. WHY: POST-PV-12 / SEQ-PV-6 violation - overlay must not write ALT_SCREEN_ENTER when pin already owns alt screen
3. EXPECTED: 1
4. ACTUAL: ${afterOverlayCount}
5. GUIDANCE: Check alt screen ownership before emitting DECSET 1049h for fullscreen overlay`,
			).toBe(1);
		} finally {
			tui.stop();
		}
	});

	it("POST-PV-13: TUI.stop leaves the alt screen at most once", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.stop()
		 * - Enforces: POST-PV-13: TUI.stop SHALL leave the alt screen at most once
		 * - Category: lifecycle
		 * - Risk tier: High — duplicate alt-screen exit corrupts parent shell state
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-PV-13 existing in requirements/contracts/pinned_dock.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: verifies terminal teardown leaves alternate screen cleanly exactly once
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		const term = new RecordingTerminal(40, 8, 100);
		const tui = new TUI(term, true);
		const editor = new EditorStub();
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		tui.enterPinned();
		await term.waitForRender();

		tui.stop();
		await term.waitForRender();
		const stopCount = countNeedle(term.writes, ALT_SCREEN_LEAVE);
		expect(
			stopCount,
			`1. WHAT: TUI.stop ALT_SCREEN_LEAVE count FAILED
2. WHY: POST-PV-13 violation - TUI.stop must leave alt screen exactly once
3. EXPECTED: 1
4. ACTUAL: ${stopCount}
5. GUIDANCE: Emit DECSET 1049l on stop exactly once when alt screen was active`,
		).toBe(1);

		// Second stop call is idempotent
		tui.stop();
		await term.waitForRender();
		const secondStopCount = countNeedle(term.writes, ALT_SCREEN_LEAVE);
		expect(
			secondStopCount,
			`1. WHAT: TUI.stop idempotent leave count FAILED
2. WHY: POST-PV-13 violation - repeated TUI.stop must not emit additional ALT_SCREEN_LEAVE
3. EXPECTED: 1
4. ACTUAL: ${secondStopCount}
5. GUIDANCE: Guard alt screen exit against repeated stop calls`,
		).toBe(1);
	});

	it("INV-PV-8: editor dock occupies the last dockHeight rows of the physical frame", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#renderPinnedFrame()
		 * - Enforces: INV-PV-8: the editor dock SHALL occupy the last dockHeight rows of the physical frame
		 * - Category: invariant
		 * - Risk tier: High — dock row must always be anchored at the bottom of the physical terminal screen
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause INV-PV-8 existing in requirements/contracts/pinned_dock.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: verifies physical rendering output on the terminal grid
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		const term = new RecordingTerminal(40, 6, 100);
		const editor = new EditorStub();
		const provider: TerminalFrameProvider = {
			renderFrame() {
				return {
					viewport: [],
					pinnedScroll: ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"],
					pinnedDock: ["PROMPT: input-line"],
				};
			},
			acknowledgeHistory() {},
		};
		const tui = new TUI(term, true);
		tui.setFrameProvider(provider);
		tui.setFocus(editor);
		try {
			tui.start();
			tui.enterPinned();
			await term.waitForRender();

			const rows = term.getViewport().map(line => line.trimEnd());
			const bottomRow = rows[rows.length - 1];
			expect(
				bottomRow,
				`1. WHAT: physical terminal bottom row FAILED
2. WHY: INV-PV-8 violation - bottom row of terminal grid must be the editor dock
3. EXPECTED: "PROMPT: input-line"
4. ACTUAL: "${bottomRow}"
5. GUIDANCE: Render dock at the bottom rows of the alternate screen frame`,
			).toBe("PROMPT: input-line");
		} finally {
			tui.stop();
		}
	});

	it("INV-PV-9: pinned mode SHALL NOT pin the dock by setting a terminal scrolling region", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#renderPinnedFrame()
		 * - Enforces: INV-PV-9: pinned mode SHALL NOT pin the dock by setting a terminal scrolling region (DECSTBM)
		 * - Category: forbidden
		 * - Risk tier: High — terminal scrolling regions break across terminal emulators and corrupt software scroll
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause INV-PV-9 existing in requirements/contracts/pinned_dock.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: negative test asserting absence of DECSTBM sequences
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		const term = new RecordingTerminal(40, 6, 100);
		const editor = new EditorStub();
		const provider: TerminalFrameProvider = {
			renderFrame() {
				return {
					viewport: [],
					pinnedScroll: ["0", "1", "2", "3", "4", "5", "6", "7"],
					pinnedDock: ["PROMPT:"],
				};
			},
			acknowledgeHistory() {},
		};
		const tui = new TUI(term, true);
		tui.setFrameProvider(provider);
		tui.setFocus(editor);
		try {
			tui.start();
			tui.enterPinned();
			await term.waitForRender();

			// Check all recorded writes for DECSTBM: \x1b[<top>;<bottom>r or \x1b[r
			const decstbmRegex = /\x1b\[\d*(?:;\d*)?r/;
			let foundDecstbm = false;
			for (const chunk of term.writes) {
				if (decstbmRegex.test(chunk)) {
					foundDecstbm = true;
					break;
				}
			}
			expect(
				foundDecstbm,
				`1. WHAT: DECSTBM sequence detected in pinned mode terminal stream
2. WHY: INV-PV-9 violation - pinned mode must not use DECSTBM scrolling regions
3. EXPECTED: false (no DECSTBM escape sequences)
4. ACTUAL: true
5. GUIDANCE: Use software frame composition instead of terminal hardware scrolling margins`,
			).toBe(false);
		} finally {
			tui.stop();
		}
	});

	it("INV-PV-10: interactive paint SHALL NOT emit retired transcript rows to native scrollback", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#renderPinnedFrame()
		 * - Enforces: INV-PV-10: interactive paint SHALL NOT emit retired transcript rows to native scrollback
		 * - Category: forbidden
		 * - Risk tier: High — emitting to native scrollback corrupts terminal history during interactive session
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause INV-PV-10 existing in requirements/contracts/pinned_dock.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: verifies native scrollback write suppression in pinned mode
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		const term = new RecordingTerminal(40, 6, 100);
		const editor = new EditorStub();
		const provider: TerminalFrameProvider = {
			renderFrame() {
				return {
					history: { id: 1, rows: ["RETIRED_ROW_1", "RETIRED_ROW_2"] },
					viewport: [],
					pinnedScroll: ["0", "1", "2", "3", "4", "5", "6", "7"],
					pinnedDock: ["PROMPT:"],
				};
			},
			acknowledgeHistory() {},
		};
		const tui = new TUI(term, true);
		tui.setFrameProvider(provider);
		tui.setFocus(editor);
		try {
			tui.start();
			tui.enterPinned();
			await term.waitForRender();

			// Normal buffer history must not have been appended
			const historyAppended = term.writes.some(chunk => chunk.includes("RETIRED_ROW_1"));
			expect(
				historyAppended,
				`1. WHAT: retired history row emitted to terminal stream in pinned mode
2. WHY: INV-PV-10 violation - interactive paint must not emit history batches to native scrollback
3. EXPECTED: false (history batches omitted)
4. ACTUAL: true
5. GUIDANCE: Pinned mode does not emit HistoryBatch to terminal output`,
			).toBe(false);
		} finally {
			tui.stop();
		}
	});
});

describe("TUI terminal-native ordinary pinned selection (Decision 6A)", () => {
	it("POST-PV-25 / SEQ-PV-10 / INV-PV-15: enterPinned activates pinned rendering without ?1002h or ?1006h", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.enterPinned()
		 * - Enforces: POST-PV-25: TUI.enterPinned SHALL activate pinned rendering without emitting PINNED mouse-reporting sequences ?1002h or ?1006h for ordinary pointer selection
		 * - Enforces: SEQ-PV-10: TUI.enterPinned SHALL establish pinned state before its first frame and SHALL leave ordinary pointer selection unclaimed by not invoking a PINNED_MOUSE_ENTER terminal write
		 * - Enforces: INV-PV-15: TUI SHALL NOT write ?1002h or ?1006h solely because pinned mode is active
		 * - Category: positive / negative-space / integration
		 * - Test pyramid: Integration
		 * - Risk tier: High — enabling button-event mouse reporting steals host-native selection
		 * - Adversarial: Observes the real start()/enterPinned() write stream, not a private mode flag.
		 *
		 * SEQ_TEST_SELF_CHECK:
		 *   [✓] Constructs TUI via new TUI(...) and drives start()/enterPinned()
		 *   [✓] Verifies SEQ-PV-10 through isPinned, first pinned frame, and write-stream absence
		 *   [✓] Does not call private mouse-sync helpers
		 *   [✓] No mock; RecordingTerminal is injected at construction
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-25, SEQ-PV-10, INV-PV-15 in requirements/contracts/pinned_dock.contract.ts
		 *   [✓] C2 VALUABLE: current enterPinned writes ?1002h/?1006h, so this fails while that emission remains; skipping enterPinned would also fail isPinned/alt-screen
		 *   [✓] C3 NON-DUPLICATIVE: the only entry-lifecycle assertion that pinned activation emits no button-event/SGR reporting
		 *   [✓] C4 NOT FUTURE-EDIT: bounds the existing enterPinned write path, not a hypothetical API
		 */
		const postPv25 = CONTRACT_PINNED_DOCK["POST-PV-25"];
		const seqPv10 = CONTRACT_PINNED_DOCK["SEQ-PV-10"];
		const invPv15 = CONTRACT_PINNED_DOCK["INV-PV-15"];
		const term = new RecordingTerminal(40, 8, 100);
		const editor = new EditorStub();
		const provider: TerminalFrameProvider = {
			renderFrame(_viewport: ViewportSize) {
				return {
					viewport: [],
					pinnedScroll: ["TRANSCRIPT_ROW"],
					pinnedDock: [editor.render()[0]!],
				};
			},
			acknowledgeHistory() {},
		};
		const tui = new TUI(term, true);
		tui.setFrameProvider(provider);
		tui.setFocus(editor);
		try {
			tui.start();
			tui.enterPinned();
			expect(
				tui.isPinned(),
				`1. WHAT: test_seq_pv_10_pinned_state_before_first_frame FAILED
2. WHY: SEQ-PV-10 violation - ${seqPv10.description}
3. EXPECTED: isPinned() === true immediately after enterPinned, before the first frame settles
4. ACTUAL: isPinned() === ${tui.isPinned()}
5. GUIDANCE: Pinned mode must be active before the first pinned frame is emitted`,
			).toBe(true);
			await term.waitForRender();

			const firstFrame = term.writes.join("");
			expect(
				countNeedle(term.writes, ALT_SCREEN_ENTER),
				`1. WHAT: test_post_pv_25_pinned_rendering_activated FAILED
2. WHY: POST-PV-25 / SEQ-PV-10 violation - ${postPv25.description}; ${seqPv10.description}
3. EXPECTED: exactly one alternate-screen enter sequence in the write stream
4. ACTUAL: ${countNeedle(term.writes, ALT_SCREEN_ENTER)}
5. GUIDANCE: Entering pinned mode must still take alternate-screen ownership`,
			).toBe(1);
			expect(
				term.getViewport().some(row => row.includes("PROMPT:")),
				`1. WHAT: test_post_pv_25_dock_visible_on_first_frame FAILED
2. WHY: POST-PV-25 violation - ${postPv25.description}
3. EXPECTED: first pinned frame includes the dock prompt
4. ACTUAL: ${JSON.stringify(term.getViewport())}
5. GUIDANCE: Pinned rendering must paint the dock without taking pointer-selection ownership`,
			).toBe(true);
			expect(
				firstFrame.includes(PINNED_BUTTON_EVENT_1002),
				`1. WHAT: test_post_pv_25_enter_pinned_emits_no_1002h FAILED
2. WHY: POST-PV-25 / SEQ-PV-10 / INV-PV-15 violation - ${postPv25.description}; ${seqPv10.description}; ${invPv15.description}
3. EXPECTED: write stream contains no "\\x1b[?1002h"
4. ACTUAL: write stream contained "\\x1b[?1002h"=${firstFrame.includes(PINNED_BUTTON_EVENT_1002)}; writes=${JSON.stringify(term.writes)}
5. GUIDANCE: Ordinary pinned activation must leave pointer selection to the terminal and must not enable button-event mouse reporting`,
			).toBe(false);
			expect(
				firstFrame.includes(PINNED_SGR_EVENT_1006),
				`1. WHAT: test_post_pv_25_enter_pinned_emits_no_1006h FAILED
2. WHY: POST-PV-25 / SEQ-PV-10 / INV-PV-15 violation - ${postPv25.description}; ${seqPv10.description}; ${invPv15.description}
3. EXPECTED: write stream contains no "\\x1b[?1006h"
4. ACTUAL: write stream contained "\\x1b[?1006h"=${firstFrame.includes(PINNED_SGR_EVENT_1006)}; writes=${JSON.stringify(term.writes)}
5. GUIDANCE: Ordinary pinned activation must not enable SGR mouse reporting`,
			).toBe(false);

			const writesBeforeRepaint = term.writes.length;
			tui.requestRender(true);
			await term.waitForRender();
			const laterWrites = term.writes.slice(writesBeforeRepaint).join("");
			expect(
				laterWrites.includes(PINNED_BUTTON_EVENT_1002) || laterWrites.includes(PINNED_SGR_EVENT_1006),
				`1. WHAT: test_inv_pv_15_later_pinned_paint_emits_no_mouse_reporting FAILED
2. WHY: INV-PV-15 violation - ${invPv15.description}
3. EXPECTED: a later pinned repaint writes neither "\\x1b[?1002h" nor "\\x1b[?1006h"
4. ACTUAL: later writes=${JSON.stringify(laterWrites)}
5. GUIDANCE: Pinned mode being active is not a reason to enable mouse reporting`,
			).toBe(false);
		} finally {
			tui.stop();
		}
	});

	it("FORBIDDEN-PV-5 / FORBIDDEN-PV-8 / ERRORS-PV-6: ordinary pinned pointer gesture is unclaimed", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI public input lifecycle (start → enterPinned → sendInput)
		 * - Enforces: FORBIDDEN-PV-5: TUI SHALL NOT emit OSC 52 or reconstruct application-owned selected bytes in response to an ordinary pinned pointer gesture
		 * - Enforces: FORBIDDEN-PV-8: TUI SHALL NOT parse or consume an ordinary pinned SGR pointer report unless an explicitly pointer-interactive fullscreen overlay owns the input
		 * - Enforces: ERRORS-PV-6: For an ordinary pinned pointer gesture, TUI SHALL intentionally perform no application copy, throw no exception, and propagate no clipboard failure because the terminal owns selection; error class: none; propagation: none
		 * - Category: negative / error
		 * - Test pyramid: Integration
		 * - Risk tier: High — consuming ordinary SGR steals terminal-native selection
		 * - Adversarial: Drives press/motion/release through terminal.sendInput onto the already focused EditorStub.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites FORBIDDEN-PV-5, FORBIDDEN-PV-8, ERRORS-PV-6
		 *   [✓] C2 VALUABLE: silently dropping SGR without OSC 52 still fails the exact EditorStub inputChunks assertion; emitting OSC 52 fails the write assertion
		 *   [✓] C3 NON-DUPLICATIVE: ordinary drag/copy surface; wheel is FORBIDDEN-PV-7; overlay-owned reports are SEQ-PV-3
		 *   [✓] C4 NOT FUTURE-EDIT: bounds the existing ordinary pinned SGR input path
		 */
		const forbiddenPv5 = CONTRACT_PINNED_DOCK["FORBIDDEN-PV-5"];
		const forbiddenPv8 = CONTRACT_PINNED_DOCK["FORBIDDEN-PV-8"];
		const errorsPv6 = CONTRACT_PINNED_DOCK["ERRORS-PV-6"];
		const press = "\x1b[<0;1;1M";
		const motion = "\x1b[<32;10;1M";
		const release = "\x1b[<0;10;1m";
		const term = new RecordingTerminal(48, 8, 100);
		const editor = new EditorStub();
		const provider: TerminalFrameProvider = {
			renderFrame(_viewport: ViewportSize) {
				return {
					viewport: [],
					pinnedScroll: ["SELECTABLE_TRANSCRIPT_TEXT"],
					pinnedDock: [editor.render()[0]!],
				};
			},
			acknowledgeHistory() {},
		};
		const tui = new TUI(term, true);
		tui.setFrameProvider(provider);
		tui.setFocus(editor);
		let thrown: unknown;
		let releaseWrites = "";
		try {
			tui.start();
			tui.enterPinned();
			await term.waitForRender();
			term.sendInput(press);
			term.sendInput(motion);
			await term.waitForRender();
			const writesBeforeRelease = term.writes.length;
			term.sendInput(release);
			await term.waitForRender();
			releaseWrites = term.writes.slice(writesBeforeRelease).join("");
		} catch (err) {
			thrown = err;
		} finally {
			tui.stop();
		}
		expect(
			thrown,
			`1. WHAT: test_errors_pv_6_ordinary_pointer_throws_no_exception FAILED
2. WHY: ERRORS-PV-6 violation - ${errorsPv6.description}
3. EXPECTED: no exception
4. ACTUAL: ${thrown instanceof Error ? `threw ${thrown.constructor.name}: ${thrown.message}` : String(thrown)}
5. GUIDANCE: An ordinary pinned pointer gesture is terminal-owned; it is not an application copy or an error`,
		).toBeUndefined();
		expect(
			editor.inputChunks,
			`1. WHAT: test_forbidden_pv_8_ordinary_sgr_reaches_focused_component FAILED
2. WHY: FORBIDDEN-PV-8 violation - ${forbiddenPv8.description}
3. EXPECTED: focused editor receives ${JSON.stringify([press, motion, release])} unchanged
4. ACTUAL: ${JSON.stringify(editor.inputChunks)}
5. GUIDANCE: Ordinary pinned SGR reports must not be consumed; they must reach the focused component unchanged`,
		).toEqual([press, motion, release]);
		expect(
			releaseWrites.includes(OSC52_CLIPBOARD_WRITE),
			`1. WHAT: test_forbidden_pv_5_ordinary_pointer_emits_no_osc52 FAILED
2. WHY: FORBIDDEN-PV-5 / ERRORS-PV-6 violation - ${forbiddenPv5.description}; ${errorsPv6.description}
3. EXPECTED: no OSC 52 clipboard write and no reconstructed application selection payload
4. ACTUAL: OSC 52 present=${releaseWrites.includes(OSC52_CLIPBOARD_WRITE)}; writes=${JSON.stringify(releaseWrites)}
5. GUIDANCE: Ordinary pinned pointer gestures must not produce application clipboard delivery`,
		).toBe(false);
	});

	it("FORBIDDEN-PV-7: ordinary pinned SGR wheel does not scroll the transcript window", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI public input lifecycle (start → enterPinned → sendInput)
		 * - Enforces: FORBIDDEN-PV-7: TUI SHALL NOT apply an ordinary pinned SGR wheel report to PinnedViewport.scrollBy; application-owned wheel scrolling is deferred to terminal-native behavior
		 * - Enforces: FORBIDDEN-PV-8: ordinary pinned SGR reports remain unparsed and unconsumed when no overlay owns tracking
		 * - Category: negative
		 * - Test pyramid: Integration
		 * - Risk tier: High — consuming wheel reports steals terminal-native scrolling and selection
		 * - Adversarial: Concatenated wheel reports through sendInput; asserts the visible window does not move.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites FORBIDDEN-PV-7 and FORBIDDEN-PV-8
		 *   [✓] C2 VALUABLE: current ordinary pinned wheel path scrolls 3 lines per tick, so the top row changes and this fails
		 *   [✓] C3 NON-DUPLICATIVE: wheel-to-scroll surface; drag/copy is the previous test; keyboard page nav is POST-PV-14
		 *   [✓] C4 NOT FUTURE-EDIT: bounds the existing ordinary pinned SGR wheel branch
		 */
		const forbiddenPv7 = CONTRACT_PINNED_DOCK["FORBIDDEN-PV-7"];
		const forbiddenPv8 = CONTRACT_PINNED_DOCK["FORBIDDEN-PV-8"];
		const term = new RecordingTerminal(48, 8, 100);
		const editor = new EditorStub();
		const history = Array.from({ length: 20 }, (_, i) => `HIST_${String(i).padStart(2, "0")}`);
		const provider: TerminalFrameProvider = {
			renderFrame(_viewport: ViewportSize) {
				return {
					viewport: [],
					pinnedScroll: history,
					pinnedDock: [editor.render()[0]!],
				};
			},
			acknowledgeHistory() {},
		};
		const tui = new TUI(term, true);
		tui.setFrameProvider(provider);
		tui.setFocus(editor);
		try {
			tui.start();
			tui.enterPinned();
			await term.waitForRender();
			const topBefore = term.getViewport()[0]?.trimEnd();
			term.sendInput("\x1b[<64;1;1M\x1b[<64;1;1M");
			await term.waitForRender();
			const topAfter = term.getViewport()[0]?.trimEnd();
			expect(
				topAfter,
				`1. WHAT: test_forbidden_pv_7_ordinary_wheel_does_not_scroll FAILED
2. WHY: FORBIDDEN-PV-7 / FORBIDDEN-PV-8 violation - ${forbiddenPv7.description}; ${forbiddenPv8.description}
3. EXPECTED: top visible row remains ${JSON.stringify(topBefore)}
4. ACTUAL: ${JSON.stringify(topAfter)}
5. GUIDANCE: Ordinary pinned wheel reports must not move the application transcript window`,
			).toBe(topBefore);
		} finally {
			tui.stop();
		}
	});

	it("SEQ-PV-3 / INV-PV-4 / FORBIDDEN-PV-1 / FORBIDDEN-PV-8: overlay-owned concatenated SGR is delivered; ordinary pinned SGR is not consumed as app selection", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI public input lifecycle (start → enterPinned → showOverlay → sendInput)
		 * - Enforces: SEQ-PV-3: TUI.#doRender SHALL enable terminal mouse reporting after the top visible fullscreen overlay explicitly requests pointer interaction with mouseTracking === true, and SHALL disable reporting when that ownership ends
		 * - Enforces: POST-PV-27: TUI SHALL enable fullscreen-overlay mouse reporting only when the top visible fullscreen overlay has mouseTracking === true
		 * - Enforces: INV-PV-4: While an explicitly pointer-interactive fullscreen overlay owns mouse tracking, TUI SHALL NOT drop concatenated SGR mouse reports arriving in one stdin chunk; ordinary pinned mode leaves those reports unclaimed
		 * - Enforces: FORBIDDEN-PV-1: While an explicitly pointer-interactive fullscreen overlay owns mouse tracking, a multi-report SGR chunk SHALL NOT be dropped or return null/unhandled
		 * - Enforces: FORBIDDEN-PV-8: ordinary pinned SGR remains unconsumed unless that overlay owns input
		 * - Category: integration / negative-space
		 * - Test pyramid: Integration
		 * - Risk tier: High — dropping overlay reports breaks pointer-interactive overlays; consuming ordinary reports steals native selection
		 * - Adversarial: Observes tracking enable writes on mouseTracking === true, then the same concatenated chunk on sendInput.
		 *
		 * SEQ_TEST_SELF_CHECK:
		 *   [✓] Constructs TUI and drives start()/enterPinned()/showOverlay()
		 *   [✓] Verifies overlay ownership through overlay handleInput contents and terminal writes
		 *   [✓] Does not call private parse helpers on the TUI
		 *   [✓] PointerInteractiveOverlay is the overlay component, injected at showOverlay
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites SEQ-PV-3, POST-PV-27, INV-PV-4, FORBIDDEN-PV-1, FORBIDDEN-PV-8
		 *   [✓] C2 VALUABLE: a true overlay that skips enable writes fails the sequence assertion; swallowing SGR fails overlay.inputChunks
		 *   [✓] C3 NON-DUPLICATIVE: true-overlay tracking writes plus concatenated raw SGR route; omitted/false are terminal-mode-only tests below
		 *   [✓] C4 NOT FUTURE-EDIT: bounds the existing pinned+overlay input and #doRender tracking branch
		 */
		const seqPv3 = CONTRACT_PINNED_DOCK["SEQ-PV-3"];
		const postPv27 = CONTRACT_PINNED_DOCK["POST-PV-27"];
		const invPv4 = CONTRACT_PINNED_DOCK["INV-PV-4"];
		const forbiddenPv1 = CONTRACT_PINNED_DOCK["FORBIDDEN-PV-1"];
		const forbiddenPv8 = CONTRACT_PINNED_DOCK["FORBIDDEN-PV-8"];
		const concatenated = "\x1b[<0;2;2M\x1b[<32;4;2M";
		const term = new RecordingTerminal(48, 8, 100);
		const editor = new EditorStub();
		const overlay = new PointerInteractiveOverlay();
		const provider: TerminalFrameProvider = {
			renderFrame(_viewport: ViewportSize) {
				return {
					viewport: [],
					pinnedScroll: ["SELECTABLE_TRANSCRIPT_TEXT"],
					pinnedDock: [editor.render()[0]!],
				};
			},
			acknowledgeHistory() {},
		};
		const tui = new TUI(term, true);
		tui.setFrameProvider(provider);
		tui.setFocus(editor);
		try {
			tui.start();
			tui.enterPinned();
			await term.waitForRender();

			const writesBeforeOrdinary = term.writes.length;
			term.sendInput(concatenated);
			await term.waitForRender();
			const ordinaryWrites = term.writes.slice(writesBeforeOrdinary).join("");
			expect(
				ordinaryWrites.includes(OSC52_CLIPBOARD_WRITE),
				`1. WHAT: test_forbidden_pv_8_ordinary_concatenated_sgr_is_unclaimed FAILED
2. WHY: FORBIDDEN-PV-8 / INV-PV-4 violation - ${forbiddenPv8.description}; ${invPv4.description}
3. EXPECTED: no OSC 52 write from an ordinary pinned concatenated SGR chunk
4. ACTUAL: writes=${JSON.stringify(ordinaryWrites)}
5. GUIDANCE: Ordinary pinned pointer reports must remain unclaimed by application selection`,
			).toBe(false);

			const writesBeforeOverlay = term.writes.length;
			tui.showOverlay(overlay, { fullscreen: true, mouseTracking: true });
			await term.waitForRender();
			const overlayEnables = presentSequences(term.writes.slice(writesBeforeOverlay), MOUSE_REPORTING_ENABLE_SEQUENCES);
			expect(
				overlayEnables.includes(PINNED_SGR_EVENT_1006),
				`1. WHAT: test_seq_pv_3_true_overlay_writes_mouse_reporting FAILED
2. WHY: SEQ-PV-3 / POST-PV-27 violation - ${seqPv3.description}; ${postPv27.description}
3. EXPECTED: mouseTracking === true writes SGR mouse reporting enable "\\x1b[?1006h"
4. ACTUAL: enable sequences=${JSON.stringify(overlayEnables)}; writes=${JSON.stringify(term.writes.slice(writesBeforeOverlay))}
5. GUIDANCE: An explicit true overlay must take terminal mouse-reporting ownership`,
			).toBe(true);
			term.sendInput(concatenated);
			await term.waitForRender();
			expect(
				overlay.inputChunks.join(""),
				`1. WHAT: test_seq_pv_3_overlay_receives_concatenated_sgr FAILED
2. WHY: SEQ-PV-3 / INV-PV-4 / FORBIDDEN-PV-1 violation - ${seqPv3.description}; ${invPv4.description}; ${forbiddenPv1.description}
3. EXPECTED: overlay input equals ${JSON.stringify(concatenated)}
4. ACTUAL: ${JSON.stringify(overlay.inputChunks)}
5. GUIDANCE: A fullscreen overlay that requested pointer interaction must receive every SGR report from a concatenated stdin chunk`,
			).toBe(concatenated);
		} finally {
			tui.stop();
		}
	});
});

describe("TUI fullscreen overlay mouseTracking opt-in (Decision 7A)", () => {
	it("POST-PV-27 / SEQ-PV-3 / INV-PV-16: omitted mouseTracking writes no mouse-reporting enable", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI public overlay lifecycle (start → enterPinned → showOverlay)
		 * - Enforces: POST-PV-27: TUI SHALL enable fullscreen-overlay mouse reporting only when the top visible fullscreen overlay has mouseTracking === true; omitted and false SHALL leave terminal pointer behavior unclaimed
		 * - Enforces: SEQ-PV-3: TUI.#doRender SHALL enable terminal mouse reporting after the top visible fullscreen overlay explicitly requests pointer interaction with mouseTracking === true
		 * - Enforces: INV-PV-16: A fullscreen overlay with mouseTracking omitted or false SHALL NOT enable terminal mouse reporting
		 * - Category: negative / integration
		 * - Test pyramid: Integration
		 * - Risk tier: High — default-on overlay tracking steals terminal-native selection
		 * - Adversarial: Real start()/enterPinned()/showOverlay({ fullscreen: true }) with mouseTracking omitted. Terminal-mode assertion only; no injected overlay SGR filter.
		 *
		 * SEQ_TEST_SELF_CHECK:
		 *   [✓] Constructs TUI via new TUI(...) and drives start()/enterPinned()/showOverlay()
		 *   [✓] Verifies SEQ-PV-3 through the write stream, not a private flag
		 *   [✓] Does not call private mouse-sync helpers
		 *   [✓] RecordingTerminal is injected at construction
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-27, SEQ-PV-3, INV-PV-16 in requirements/contracts/pinned_dock.contract.ts
		 *   [✓] C2 VALUABLE: current default-on predicate writes 1000h/1003h/1006h when mouseTracking is omitted, so this fails
		 *   [✓] C3 NON-DUPLICATIVE: omitted-option terminal writes only; false is the next test; true tracking+SGR is SEQ-PV-3 above
		 *   [✓] C4 NOT FUTURE-EDIT: bounds the existing fullscreen overlay tracking predicate
		 */
		const postPv27 = CONTRACT_PINNED_DOCK["POST-PV-27"];
		const seqPv3 = CONTRACT_PINNED_DOCK["SEQ-PV-3"];
		const invPv16 = CONTRACT_PINNED_DOCK["INV-PV-16"];
		const term = new RecordingTerminal(40, 8, 100);
		const editor = new EditorStub();
		const overlay: Component = {
			invalidate() {},
			render: () => ["OMITTED_TRACKING_OVERLAY"],
		};
		const provider: TerminalFrameProvider = {
			renderFrame(_viewport: ViewportSize) {
				return {
					viewport: [],
					pinnedScroll: ["TRANSCRIPT_ROW"],
					pinnedDock: [editor.render()[0]!],
				};
			},
			acknowledgeHistory() {},
		};
		const tui = new TUI(term, true);
		tui.setFrameProvider(provider);
		tui.setFocus(editor);
		try {
			tui.start();
			tui.enterPinned();
			await term.waitForRender();
			const writesBeforeOverlay = term.writes.length;
			tui.showOverlay(overlay, { fullscreen: true });
			await term.waitForRender();
			const overlayEnables = presentSequences(term.writes.slice(writesBeforeOverlay), MOUSE_REPORTING_ENABLE_SEQUENCES);
			expect(
				overlayEnables,
				`1. WHAT: test_inv_pv_16_omitted_mouse_tracking_enables_reporting FAILED
2. WHY: POST-PV-27 / SEQ-PV-3 / INV-PV-16 violation - ${postPv27.description}; ${seqPv3.description}; ${invPv16.description}
3. EXPECTED: [] (no ?1000h/?1002h/?1003h/?1006h after omitted-mouseTracking fullscreen overlay)
4. ACTUAL: ${JSON.stringify(overlayEnables)}; writes=${JSON.stringify(term.writes.slice(writesBeforeOverlay))}
5. GUIDANCE: Omitting mouseTracking must leave terminal pointer behavior unclaimed`,
			).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("POST-PV-27 / SEQ-PV-3 / INV-PV-16: false mouseTracking writes no mouse-reporting enable", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI public overlay lifecycle (start → enterPinned → showOverlay)
		 * - Enforces: POST-PV-27: omitted and false SHALL leave terminal pointer behavior unclaimed
		 * - Enforces: SEQ-PV-3: reporting is enabled only after mouseTracking === true
		 * - Enforces: INV-PV-16: A fullscreen overlay with mouseTracking omitted or false SHALL NOT enable terminal mouse reporting
		 * - Category: negative / integration
		 * - Test pyramid: Integration
		 * - Risk tier: High — false must remain an explicit non-claim, not a silent default-on
		 * - Adversarial: Real showOverlay({ fullscreen: true, mouseTracking: false }). Terminal-mode assertion only; no off-state input filter.
		 *
		 * SEQ_TEST_SELF_CHECK:
		 *   [✓] Constructs TUI via new TUI(...) and drives start()/enterPinned()/showOverlay()
		 *   [✓] Verifies SEQ-PV-3 through the write stream
		 *   [✓] Does not call private mouse-sync helpers
		 *   [✓] RecordingTerminal is injected at construction
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-27, SEQ-PV-3, INV-PV-16
		 *   [✓] C2 VALUABLE: writing any enable sequence on false fails the exact empty-array assertion
		 *   [✓] C3 NON-DUPLICATIVE: false-option terminal writes; omitted is the previous test
		 *   [✓] C4 NOT FUTURE-EDIT: bounds the existing fullscreen overlay tracking predicate
		 */
		const postPv27 = CONTRACT_PINNED_DOCK["POST-PV-27"];
		const seqPv3 = CONTRACT_PINNED_DOCK["SEQ-PV-3"];
		const invPv16 = CONTRACT_PINNED_DOCK["INV-PV-16"];
		const term = new RecordingTerminal(40, 8, 100);
		const editor = new EditorStub();
		const overlay: Component = {
			invalidate() {},
			render: () => ["FALSE_TRACKING_OVERLAY"],
		};
		const provider: TerminalFrameProvider = {
			renderFrame(_viewport: ViewportSize) {
				return {
					viewport: [],
					pinnedScroll: ["TRANSCRIPT_ROW"],
					pinnedDock: [editor.render()[0]!],
				};
			},
			acknowledgeHistory() {},
		};
		const tui = new TUI(term, true);
		tui.setFrameProvider(provider);
		tui.setFocus(editor);
		try {
			tui.start();
			tui.enterPinned();
			await term.waitForRender();
			const writesBeforeOverlay = term.writes.length;
			tui.showOverlay(overlay, { fullscreen: true, mouseTracking: false });
			await term.waitForRender();
			const overlayEnables = presentSequences(term.writes.slice(writesBeforeOverlay), MOUSE_REPORTING_ENABLE_SEQUENCES);
			expect(
				overlayEnables,
				`1. WHAT: test_inv_pv_16_false_mouse_tracking_enables_reporting FAILED
2. WHY: POST-PV-27 / SEQ-PV-3 / INV-PV-16 violation - ${postPv27.description}; ${seqPv3.description}; ${invPv16.description}
3. EXPECTED: [] (no ?1000h/?1002h/?1003h/?1006h after mouseTracking: false fullscreen overlay)
4. ACTUAL: ${JSON.stringify(overlayEnables)}; writes=${JSON.stringify(term.writes.slice(writesBeforeOverlay))}
5. GUIDANCE: mouseTracking false must leave terminal pointer behavior unclaimed`,
			).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("LIFETIME_INV-PV-1: entry, true overlay, close, exit, and stop enable and release only owned modes", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI public lifecycle (start → enterPinned → showOverlay → hide → exitPinned → stop)
		 * - Enforces: LIFETIME_INV-PV-1: From pinned entry through explicit fullscreen-overlay ownership transfer, pinned exit, and stop, TUI SHALL enable and release only terminal modes it owns; ordinary pinned mode SHALL never acquire ?1002h or ?1006h ownership
		 * - Enforces: SEQ-PV-3: reporting is enabled after mouseTracking === true and disabled when that ownership ends
		 * - Enforces: POST-PV-27: only mouseTracking === true owns fullscreen overlay mouse reporting
		 * - Category: lifetime / integration
		 * - Test pyramid: Integration
		 * - Risk tier: High — leaking mouse reporting past overlay close or stop corrupts the parent terminal
		 * - Adversarial: Observes the write stream at each public lifecycle stage. No off-state input filter.
		 *
		 * SEQ_TEST_SELF_CHECK:
		 *   [✓] Constructs TUI via new TUI(...) and drives start()/enterPinned()/showOverlay()/hide()/exitPinned()/stop()
		 *   [✓] Verifies ownership transfer through terminal writes, not private flags
		 *   [✓] Does not call private mouse-sync helpers
		 *   [✓] OverlayHandle.hide is the public close path returned by showOverlay
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites LIFETIME_INV-PV-1, SEQ-PV-3, POST-PV-27
		 *   [✓] C2 VALUABLE: missing enable on true, missing disable on close, or re-acquiring 1002h/1006h after close fails a stage assertion
		 *   [✓] C3 NON-DUPLICATIVE: full ownership-transfer sequence; entry-only is POST-PV-25; true SGR route is SEQ-PV-3
		 *   [✓] C4 NOT FUTURE-EDIT: walks the existing public lifecycle path
		 */
		const lifetimeInvPv1 = CONTRACT_PINNED_DOCK["LIFETIME_INV-PV-1"];
		const seqPv3 = CONTRACT_PINNED_DOCK["SEQ-PV-3"];
		const postPv27 = CONTRACT_PINNED_DOCK["POST-PV-27"];
		const term = new RecordingTerminal(40, 8, 100);
		const editor = new EditorStub();
		const overlay: Component = {
			invalidate() {},
			render: () => ["TRUE_TRACKING_OVERLAY"],
		};
		const provider: TerminalFrameProvider = {
			renderFrame(_viewport: ViewportSize) {
				return {
					viewport: [],
					pinnedScroll: ["TRANSCRIPT_ROW"],
					pinnedDock: [editor.render()[0]!],
				};
			},
			acknowledgeHistory() {},
		};
		const tui = new TUI(term, true);
		tui.setFrameProvider(provider);
		tui.setFocus(editor);
		tui.start();
		tui.enterPinned();
		await term.waitForRender();
		const entryEnables = presentSequences(term.writes, MOUSE_REPORTING_ENABLE_SEQUENCES);
		expect(
			entryEnables.includes(PINNED_BUTTON_EVENT_1002) || entryEnables.includes(PINNED_SGR_EVENT_1006),
			`1. WHAT: test_lifetime_inv_pv_1_entry_acquires_no_1002h_or_1006h FAILED
2. WHY: LIFETIME_INV-PV-1 violation - ${lifetimeInvPv1.description}
3. EXPECTED: ordinary pinned entry writes neither "\\x1b[?1002h" nor "\\x1b[?1006h"
4. ACTUAL: enable sequences=${JSON.stringify(entryEnables)}; writes=${JSON.stringify(term.writes)}
5. GUIDANCE: Ordinary pinned mode must never acquire button-event or SGR mouse-reporting ownership`,
		).toBe(false);

		const writesBeforeOverlay = term.writes.length;
		const handle = tui.showOverlay(overlay, { fullscreen: true, mouseTracking: true });
		await term.waitForRender();
		const overlayEnables = presentSequences(term.writes.slice(writesBeforeOverlay), MOUSE_REPORTING_ENABLE_SEQUENCES);
		expect(
			overlayEnables.includes(PINNED_SGR_EVENT_1006),
			`1. WHAT: test_lifetime_inv_pv_1_true_overlay_enables_reporting FAILED
2. WHY: LIFETIME_INV-PV-1 / SEQ-PV-3 / POST-PV-27 violation - ${lifetimeInvPv1.description}; ${seqPv3.description}; ${postPv27.description}
3. EXPECTED: mouseTracking === true writes "\\x1b[?1006h"
4. ACTUAL: enable sequences=${JSON.stringify(overlayEnables)}; writes=${JSON.stringify(term.writes.slice(writesBeforeOverlay))}
5. GUIDANCE: Explicit overlay ownership must enable terminal mouse reporting`,
		).toBe(true);

		const writesBeforeClose = term.writes.length;
		handle.hide();
		await term.waitForRender();
		const closeWrites = term.writes.slice(writesBeforeClose);
		const closeDisables = presentSequences(closeWrites, MOUSE_REPORTING_DISABLE_SEQUENCES);
		const closeEnables = presentSequences(closeWrites, MOUSE_REPORTING_ENABLE_SEQUENCES);
		expect(
			closeDisables.includes("\x1b[?1006l"),
			`1. WHAT: test_lifetime_inv_pv_1_overlay_close_releases_reporting FAILED
2. WHY: LIFETIME_INV-PV-1 / SEQ-PV-3 violation - ${lifetimeInvPv1.description}; ${seqPv3.description}
3. EXPECTED: overlay close writes "\\x1b[?1006l"
4. ACTUAL: disable sequences=${JSON.stringify(closeDisables)}; writes=${JSON.stringify(closeWrites)}
5. GUIDANCE: Ending overlay pointer ownership must release terminal mouse reporting`,
		).toBe(true);
		expect(
			closeEnables.includes(PINNED_BUTTON_EVENT_1002) || closeEnables.includes(PINNED_SGR_EVENT_1006),
			`1. WHAT: test_lifetime_inv_pv_1_close_reacquires_1002h_or_1006h FAILED
2. WHY: LIFETIME_INV-PV-1 violation - ${lifetimeInvPv1.description}
3. EXPECTED: overlay close does not write "\\x1b[?1002h" or "\\x1b[?1006h"
4. ACTUAL: enable sequences=${JSON.stringify(closeEnables)}; writes=${JSON.stringify(closeWrites)}
5. GUIDANCE: Returning to ordinary pinned mode must not re-acquire mouse-reporting ownership`,
		).toBe(false);

		const writesBeforeExit = term.writes.length;
		tui.exitPinned();
		await term.waitForRender();
		const exitEnables = presentSequences(term.writes.slice(writesBeforeExit), MOUSE_REPORTING_ENABLE_SEQUENCES);
		expect(
			exitEnables.includes(PINNED_BUTTON_EVENT_1002) || exitEnables.includes(PINNED_SGR_EVENT_1006),
			`1. WHAT: test_lifetime_inv_pv_1_exit_reacquires_1002h_or_1006h FAILED
2. WHY: LIFETIME_INV-PV-1 violation - ${lifetimeInvPv1.description}
3. EXPECTED: exitPinned writes neither "\\x1b[?1002h" nor "\\x1b[?1006h"
4. ACTUAL: enable sequences=${JSON.stringify(exitEnables)}; writes=${JSON.stringify(term.writes.slice(writesBeforeExit))}
5. GUIDANCE: Pinned exit must not acquire mouse-reporting ownership`,
		).toBe(false);

		const writesBeforeStop = term.writes.length;
		tui.stop();
		await term.waitForRender();
		const stopEnables = presentSequences(term.writes.slice(writesBeforeStop), MOUSE_REPORTING_ENABLE_SEQUENCES);
		expect(
			stopEnables.includes(PINNED_BUTTON_EVENT_1002) || stopEnables.includes(PINNED_SGR_EVENT_1006),
			`1. WHAT: test_lifetime_inv_pv_1_stop_reacquires_1002h_or_1006h FAILED
2. WHY: LIFETIME_INV-PV-1 violation - ${lifetimeInvPv1.description}
3. EXPECTED: stop writes neither "\\x1b[?1002h" nor "\\x1b[?1006h"
4. ACTUAL: enable sequences=${JSON.stringify(stopEnables)}; writes=${JSON.stringify(term.writes.slice(writesBeforeStop))}
5. GUIDANCE: Stop must release owned modes and must not acquire mouse-reporting ownership`,
		).toBe(false);
	});

	it("PRE-PV-2 / ERRORS-PV-2: validateSgrMouseReports rejects non-string input with InvalidMouseInputError", () => {
		/**
		 * CONTRACT VERIFICATION (supporting, not implementation RED):
		 * - Contract: validateSgrMouseReports()
		 * - Enforces: PRE-PV-2: SGR mouse input parsers SHALL accept string data and reject non-string types
		 * - Enforces: ERRORS-PV-2: validateSgrMouseReports SHALL throw InvalidMouseInputError citing PRE-PV-2 on non-string input
		 * - Category: error / boundary
		 * - Test pyramid: Unit
		 * - Risk tier: Medium — wrong error class or clauseId hides parser precondition failures
		 * - Adversarial: Direct contract-validator call with a non-string chunk and empty events.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites PRE-PV-2 and ERRORS-PV-2 in requirements/contracts/pinned_dock.contract.ts
		 *   [✓] C2 VALUABLE: a different error class or clauseId fails the exact assertions
		 *   [✓] C3 NON-DUPLICATIVE: the only direct validator boundary for non-string SGR input
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current PRE-PV-2 / ERRORS-PV-2 mapping
		 */
		const prePv2 = CONTRACT_PINNED_DOCK["PRE-PV-2"];
		const errorsPv2 = CONTRACT_PINNED_DOCK["ERRORS-PV-2"];
		let thrown: unknown;
		try {
			validateSgrMouseReports(1 as unknown as string, []);
		} catch (err) {
			thrown = err;
		}
		expect(
			thrown instanceof InvalidMouseInputError,
			`1. WHAT: test_errors_pv_2_non_string_throws_invalid_mouse_input FAILED
2. WHY: PRE-PV-2 / ERRORS-PV-2 violation - ${prePv2.description}; ${errorsPv2.description}
3. EXPECTED: InvalidMouseInputError
4. ACTUAL: ${thrown instanceof Error ? `${thrown.constructor.name}: ${thrown.message}` : String(thrown)}
5. GUIDANCE: Non-string SGR input must be rejected as InvalidMouseInputError`,
		).toBe(true);
		expect(
			thrown instanceof InvalidMouseInputError ? thrown.clauseId : undefined,
			`1. WHAT: test_errors_pv_2_clause_id_is_pre_pv_2 FAILED
2. WHY: PRE-PV-2 / ERRORS-PV-2 violation - ${prePv2.description}; ${errorsPv2.description}
3. EXPECTED: clauseId === "PRE-PV-2"
4. ACTUAL: ${thrown instanceof InvalidMouseInputError ? thrown.clauseId : String(thrown)}
5. GUIDANCE: InvalidMouseInputError must cite clause PRE-PV-2`,
		).toBe("PRE-PV-2");
	});
});
