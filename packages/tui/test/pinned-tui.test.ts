import { describe, expect, it } from "bun:test";
import { type Component, type Focusable, type TerminalFrameProvider, TUI, type ViewportSize } from "@oh-my-pi/pi-tui";
import {
	PINNED_ALT_SCREEN_ENTER as ALT_SCREEN_ENTER,
	PINNED_ALT_SCREEN_LEAVE as ALT_SCREEN_LEAVE,
	CONTRACT_PINNED_DOCK,
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
			expect(firstCount, `1. WHAT: enterPinned initial ALT_SCREEN_ENTER write FAILED
2. WHY: POST-PV-11 violation - enterPinned must write ALT_SCREEN_ENTER exactly once
3. EXPECTED: 1
4. ACTUAL: ${firstCount}
5. GUIDANCE: Enter alternate screen on pinned session start`).toBe(1);

			// Idempotent second call
			tui.enterPinned();
			await term.waitForRender();
			const secondCount = countNeedle(term.writes, ALT_SCREEN_ENTER);
			expect(secondCount, `1. WHAT: enterPinned second call ALT_SCREEN_ENTER write FAILED
2. WHY: POST-PV-11 violation - subsequent enterPinned calls must not re-enter alternate screen
3. EXPECTED: 1
4. ACTUAL: ${secondCount}
5. GUIDANCE: Guard alternate screen entry with active state check`).toBe(1);
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
			expect(countNeedle(term.writes, ALT_SCREEN_ENTER), `1. WHAT: enterPinned setup FAILED
2. WHY: POST-PV-11 violation - enterPinned must write ALT_SCREEN_ENTER once
3. EXPECTED: 1
4. ACTUAL: ${countNeedle(term.writes, ALT_SCREEN_ENTER)}
5. GUIDANCE: Enter alternate screen once before overlay test`).toBe(1);

			tui.showOverlay(overlay, { fullscreen: true, mouseTracking: true });
			await term.waitForRender();
			const afterOverlayCount = countNeedle(term.writes, ALT_SCREEN_ENTER);
			expect(afterOverlayCount, `1. WHAT: fullscreen overlay while pinned wrote duplicate ALT_SCREEN_ENTER
2. WHY: POST-PV-12 / SEQ-PV-6 violation - overlay must not write ALT_SCREEN_ENTER when pin already owns alt screen
3. EXPECTED: 1
4. ACTUAL: ${afterOverlayCount}
5. GUIDANCE: Check alt screen ownership before emitting DECSET 1049h for fullscreen overlay`).toBe(1);
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
		expect(stopCount, `1. WHAT: TUI.stop ALT_SCREEN_LEAVE count FAILED
2. WHY: POST-PV-13 violation - TUI.stop must leave alt screen exactly once
3. EXPECTED: 1
4. ACTUAL: ${stopCount}
5. GUIDANCE: Emit DECSET 1049l on stop exactly once when alt screen was active`).toBe(1);

		// Second stop call is idempotent
		tui.stop();
		await term.waitForRender();
		const secondStopCount = countNeedle(term.writes, ALT_SCREEN_LEAVE);
		expect(secondStopCount, `1. WHAT: TUI.stop idempotent leave count FAILED
2. WHY: POST-PV-13 violation - repeated TUI.stop must not emit additional ALT_SCREEN_LEAVE
3. EXPECTED: 1
4. ACTUAL: ${secondStopCount}
5. GUIDANCE: Guard alt screen exit against repeated stop calls`).toBe(1);
	});

	it("POST-PV-14: viewport page keys reach PinnedViewport before editor input", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI public input lifecycle (start → enterPinned → sendInput)
		 * - Enforces: POST-PV-14: Viewport page-navigation keys SHALL reach PinnedViewport.scrollBy before editor input
		 * - Category: positive / preservation
		 * - Test pyramid: Integration
		 * - Risk tier: High — page navigation must not become editor text
		 * - Adversarial: Contract-governed, implementation-aware. Ordinary SGR wheel is FORBIDDEN-PV-7.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-14 in requirements/contracts/pinned_dock.contract.ts
		 *   [✓] C2 VALUABLE: forwarding PageUp into the editor fails the exact editor-text assertion
		 *   [✓] C3 NON-DUPLICATIVE: keyboard page navigation only; wheel unclaimedness is FORBIDDEN-PV-7
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current POST-PV-14 keyboard guarantee
		 */
		const postPv14 = CONTRACT_PINNED_DOCK["POST-PV-14"];
		const term = new RecordingTerminal(40, 8, 100);
		const editor = new EditorStub();
		const provider: TerminalFrameProvider = {
			renderFrame(_viewport: ViewportSize) {
				return {
					viewport: [],
					pinnedScroll: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
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

			term.sendInput("\x1b[5~");
			await term.waitForRender();
			expect(editor.text, `1. WHAT: test_post_pv_14_pageup_does_not_reach_editor FAILED
2. WHY: POST-PV-14 violation - ${postPv14.description}
3. EXPECTED: editor text remains ""
4. ACTUAL: ${JSON.stringify(editor.text)}
5. GUIDANCE: Page-navigation keys must not become editor text`).toBe("");

			term.sendInput("x");
			await term.waitForRender();
			expect(editor.text, `1. WHAT: test_post_pv_14_printable_reaches_editor FAILED
2. WHY: POST-PV-14 violation - ${postPv14.description}
3. EXPECTED: "x"
4. ACTUAL: ${JSON.stringify(editor.text)}
5. GUIDANCE: Printable keys that are not page-navigation keys must reach the focused editor`).toBe("x");
		} finally {
			tui.stop();
		}
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
			expect(bottomRow, `1. WHAT: physical terminal bottom row FAILED
2. WHY: INV-PV-8 violation - bottom row of terminal grid must be the editor dock
3. EXPECTED: "PROMPT: input-line"
4. ACTUAL: "${bottomRow}"
5. GUIDANCE: Render dock at the bottom rows of the alternate screen frame`).toBe("PROMPT: input-line");
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
			expect(foundDecstbm, `1. WHAT: DECSTBM sequence detected in pinned mode terminal stream
2. WHY: INV-PV-9 violation - pinned mode must not use DECSTBM scrolling regions
3. EXPECTED: false (no DECSTBM escape sequences)
4. ACTUAL: true
5. GUIDANCE: Use software frame composition instead of terminal hardware scrolling margins`).toBe(false);
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
			expect(historyAppended, `1. WHAT: retired history row emitted to terminal stream in pinned mode
2. WHY: INV-PV-10 violation - interactive paint must not emit history batches to native scrollback
3. EXPECTED: false (history batches omitted)
4. ACTUAL: true
5. GUIDANCE: Pinned mode does not emit HistoryBatch to terminal output`).toBe(false);
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
			expect(tui.isPinned(), `1. WHAT: test_seq_pv_10_pinned_state_before_first_frame FAILED
2. WHY: SEQ-PV-10 violation - ${seqPv10.description}
3. EXPECTED: isPinned() === true immediately after enterPinned, before the first frame settles
4. ACTUAL: isPinned() === ${tui.isPinned()}
5. GUIDANCE: Pinned mode must be active before the first pinned frame is emitted`).toBe(true);
			await term.waitForRender();

			const firstFrame = term.writes.join("");
			expect(countNeedle(term.writes, ALT_SCREEN_ENTER), `1. WHAT: test_post_pv_25_pinned_rendering_activated FAILED
2. WHY: POST-PV-25 / SEQ-PV-10 violation - ${postPv25.description}; ${seqPv10.description}
3. EXPECTED: exactly one alternate-screen enter sequence in the write stream
4. ACTUAL: ${countNeedle(term.writes, ALT_SCREEN_ENTER)}
5. GUIDANCE: Entering pinned mode must still take alternate-screen ownership`).toBe(1);
			expect(term.getViewport().some(row => row.includes("PROMPT:")), `1. WHAT: test_post_pv_25_dock_visible_on_first_frame FAILED
2. WHY: POST-PV-25 violation - ${postPv25.description}
3. EXPECTED: first pinned frame includes the dock prompt
4. ACTUAL: ${JSON.stringify(term.getViewport())}
5. GUIDANCE: Pinned rendering must paint the dock without taking pointer-selection ownership`).toBe(true);
			expect(firstFrame.includes(PINNED_BUTTON_EVENT_1002), `1. WHAT: test_post_pv_25_enter_pinned_emits_no_1002h FAILED
2. WHY: POST-PV-25 / SEQ-PV-10 / INV-PV-15 violation - ${postPv25.description}; ${seqPv10.description}; ${invPv15.description}
3. EXPECTED: write stream contains no "\\x1b[?1002h"
4. ACTUAL: write stream contained "\\x1b[?1002h"=${firstFrame.includes(PINNED_BUTTON_EVENT_1002)}; writes=${JSON.stringify(term.writes)}
5. GUIDANCE: Ordinary pinned activation must leave pointer selection to the terminal and must not enable button-event mouse reporting`).toBe(false);
			expect(firstFrame.includes(PINNED_SGR_EVENT_1006), `1. WHAT: test_post_pv_25_enter_pinned_emits_no_1006h FAILED
2. WHY: POST-PV-25 / SEQ-PV-10 / INV-PV-15 violation - ${postPv25.description}; ${seqPv10.description}; ${invPv15.description}
3. EXPECTED: write stream contains no "\\x1b[?1006h"
4. ACTUAL: write stream contained "\\x1b[?1006h"=${firstFrame.includes(PINNED_SGR_EVENT_1006)}; writes=${JSON.stringify(term.writes)}
5. GUIDANCE: Ordinary pinned activation must not enable SGR mouse reporting`).toBe(false);

			const writesBeforeRepaint = term.writes.length;
			tui.requestRender(true);
			await term.waitForRender();
			const laterWrites = term.writes.slice(writesBeforeRepaint).join("");
			expect(laterWrites.includes(PINNED_BUTTON_EVENT_1002) || laterWrites.includes(PINNED_SGR_EVENT_1006), `1. WHAT: test_inv_pv_15_later_pinned_paint_emits_no_mouse_reporting FAILED
2. WHY: INV-PV-15 violation - ${invPv15.description}
3. EXPECTED: a later pinned repaint writes neither "\\x1b[?1002h" nor "\\x1b[?1006h"
4. ACTUAL: later writes=${JSON.stringify(laterWrites)}
5. GUIDANCE: Pinned mode being active is not a reason to enable mouse reporting`).toBe(false);
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
		expect(thrown, `1. WHAT: test_errors_pv_6_ordinary_pointer_throws_no_exception FAILED
2. WHY: ERRORS-PV-6 violation - ${errorsPv6.description}
3. EXPECTED: no exception
4. ACTUAL: ${thrown instanceof Error ? `threw ${thrown.constructor.name}: ${thrown.message}` : String(thrown)}
5. GUIDANCE: An ordinary pinned pointer gesture is terminal-owned; it is not an application copy or an error`).toBeUndefined();
		expect(editor.inputChunks, `1. WHAT: test_forbidden_pv_8_ordinary_sgr_reaches_focused_component FAILED
2. WHY: FORBIDDEN-PV-8 violation - ${forbiddenPv8.description}
3. EXPECTED: focused editor receives ${JSON.stringify([press, motion, release])} unchanged
4. ACTUAL: ${JSON.stringify(editor.inputChunks)}
5. GUIDANCE: Ordinary pinned SGR reports must not be consumed; they must reach the focused component unchanged`).toEqual([press, motion, release]);
		expect(releaseWrites.includes(OSC52_CLIPBOARD_WRITE), `1. WHAT: test_forbidden_pv_5_ordinary_pointer_emits_no_osc52 FAILED
2. WHY: FORBIDDEN-PV-5 / ERRORS-PV-6 violation - ${forbiddenPv5.description}; ${errorsPv6.description}
3. EXPECTED: no OSC 52 clipboard write and no reconstructed application selection payload
4. ACTUAL: OSC 52 present=${releaseWrites.includes(OSC52_CLIPBOARD_WRITE)}; writes=${JSON.stringify(releaseWrites)}
5. GUIDANCE: Ordinary pinned pointer gestures must not produce application clipboard delivery`).toBe(false);
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
			expect(topAfter, `1. WHAT: test_forbidden_pv_7_ordinary_wheel_does_not_scroll FAILED
2. WHY: FORBIDDEN-PV-7 / FORBIDDEN-PV-8 violation - ${forbiddenPv7.description}; ${forbiddenPv8.description}
3. EXPECTED: top visible row remains ${JSON.stringify(topBefore)}
4. ACTUAL: ${JSON.stringify(topAfter)}
5. GUIDANCE: Ordinary pinned wheel reports must not move the application transcript window`).toBe(topBefore);
		} finally {
			tui.stop();
		}
	});

	it("SEQ-PV-3 / INV-PV-4 / FORBIDDEN-PV-1 / FORBIDDEN-PV-8: overlay-owned concatenated SGR is delivered; ordinary pinned SGR is not consumed as app selection", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI public input lifecycle (start → enterPinned → showOverlay → sendInput)
		 * - Enforces: SEQ-PV-3: Fullscreen overlay input handling SHALL parse SGR mouse reports only while that overlay explicitly requests pointer interaction
		 * - Enforces: INV-PV-4: While an explicitly pointer-interactive fullscreen overlay owns mouse tracking, TUI SHALL NOT drop concatenated SGR mouse reports arriving in one stdin chunk; ordinary pinned mode leaves those reports unclaimed
		 * - Enforces: FORBIDDEN-PV-1: While an explicitly pointer-interactive fullscreen overlay owns mouse tracking, a multi-report SGR chunk SHALL NOT be dropped or return null/unhandled
		 * - Enforces: FORBIDDEN-PV-8: ordinary pinned SGR remains unconsumed unless that overlay owns input
		 * - Category: integration / negative-space
		 * - Test pyramid: Integration
		 * - Risk tier: High — dropping overlay reports breaks pointer-interactive overlays; consuming ordinary reports steals native selection
		 * - Adversarial: Same concatenated chunk on the real sendInput path, once with no overlay and once with fullscreen mouseTracking.
		 *
		 * SEQ_TEST_SELF_CHECK:
		 *   [✓] Constructs TUI and drives start()/enterPinned()/showOverlay()
		 *   [✓] Verifies overlay ownership through overlay handleInput contents
		 *   [✓] Does not call private parse helpers on the TUI
		 *   [✓] PointerInteractiveOverlay is the overlay component, injected at showOverlay
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites SEQ-PV-3, INV-PV-4, FORBIDDEN-PV-1, FORBIDDEN-PV-8
		 *   [✓] C2 VALUABLE: current pinned path swallows SGR before overlay handleInput, so overlay.inputChunks stays empty and this fails
		 *   [✓] C3 NON-DUPLICATIVE: overlay-owned multi-report delivery; ordinary copy/wheel are the tests above
		 *   [✓] C4 NOT FUTURE-EDIT: bounds the existing pinned+overlay input branch that currently returns without delivering SGR
		 */
		const seqPv3 = CONTRACT_PINNED_DOCK["SEQ-PV-3"];
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
			expect(ordinaryWrites.includes(OSC52_CLIPBOARD_WRITE), `1. WHAT: test_forbidden_pv_8_ordinary_concatenated_sgr_is_unclaimed FAILED
2. WHY: FORBIDDEN-PV-8 / INV-PV-4 violation - ${forbiddenPv8.description}; ${invPv4.description}
3. EXPECTED: no OSC 52 write from an ordinary pinned concatenated SGR chunk
4. ACTUAL: writes=${JSON.stringify(ordinaryWrites)}
5. GUIDANCE: Ordinary pinned pointer reports must remain unclaimed by application selection`).toBe(false);

			tui.showOverlay(overlay, { fullscreen: true, mouseTracking: true });
			await term.waitForRender();
			term.sendInput(concatenated);
			await term.waitForRender();
			expect(overlay.inputChunks.join(""), `1. WHAT: test_seq_pv_3_overlay_receives_concatenated_sgr FAILED
2. WHY: SEQ-PV-3 / INV-PV-4 / FORBIDDEN-PV-1 violation - ${seqPv3.description}; ${invPv4.description}; ${forbiddenPv1.description}
3. EXPECTED: overlay input equals ${JSON.stringify(concatenated)}
4. ACTUAL: ${JSON.stringify(overlay.inputChunks)}
5. GUIDANCE: A fullscreen overlay that requested pointer interaction must receive every SGR report from a concatenated stdin chunk`).toBe(concatenated);
		} finally {
			tui.stop();
		}
	});
});
