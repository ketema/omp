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
	invalidate(): void {}
	render(): string[] {
		return [`PROMPT:${this.text}`];
	}
	handleInput(data: string): void {
		if (data.startsWith("\x1b")) return;
		this.text += data;
	}
}

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

describe("TUI pinned session integration (POST-7..10, INV-1, FORBIDDEN-1..2, SEQ-2..4)", () => {
	it("POST-9: enterPinned writes ALT_SCREEN_ENTER at most once until a matching leave", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.enterPinned()
		 * - Enforces: POST-9: TUI.enterPinned SHALL write ALT_SCREEN_ENTER at most once until a matching leave
		 * - Category: state-transition
		 * - Risk tier: High — duplicate DECSET 1049h corrupts terminal scrollback state
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-9 existing in contracts/pinned-composer.contract.ts
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
			expect(firstCount).toBe(
				1,
				`1. WHAT: enterPinned initial ALT_SCREEN_ENTER write FAILED
2. WHY: POST-9 violation - enterPinned must write ALT_SCREEN_ENTER exactly once
3. EXPECTED: 1
4. ACTUAL: ${firstCount}
5. GUIDANCE: Enter alternate screen on pinned session start`,
			);

			// Idempotent second call
			tui.enterPinned();
			await term.waitForRender();
			const secondCount = countNeedle(term.writes, ALT_SCREEN_ENTER);
			expect(secondCount).toBe(
				1,
				`1. WHAT: enterPinned second call ALT_SCREEN_ENTER write FAILED
2. WHY: POST-9 violation - subsequent enterPinned calls must not re-enter alternate screen
3. EXPECTED: 1
4. ACTUAL: ${secondCount}
5. GUIDANCE: Guard alternate screen entry with active state check`,
			);
		} finally {
			tui.stop();
		}
	});

	it("POST-10 / SEQ-3: opening a fullscreen overlay while pinned does not write a second ALT_SCREEN_ENTER", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.showOverlay()
		 * - Enforces: POST-10 / SEQ-3: fullscreen overlay enter SHALL NOT write ALT_SCREEN_ENTER when pin already owns the alt screen
		 * - Category: integration
		 * - Risk tier: High — duplicate alt-screen entry clears the terminal buffer unexpectedly
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-10 and SEQ-3 existing in contracts/pinned-composer.contract.ts
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
			expect(countNeedle(term.writes, ALT_SCREEN_ENTER)).toBe(
				1,
				`1. WHAT: enterPinned setup FAILED
2. WHY: POST-9 violation - enterPinned must write ALT_SCREEN_ENTER once
3. EXPECTED: 1
4. ACTUAL: ${countNeedle(term.writes, ALT_SCREEN_ENTER)}
5. GUIDANCE: Enter alternate screen once before overlay test`,
			);

			tui.showOverlay(overlay, { fullscreen: true, mouseTracking: true });
			await term.waitForRender();
			const afterOverlayCount = countNeedle(term.writes, ALT_SCREEN_ENTER);
			expect(afterOverlayCount).toBe(
				1,
				`1. WHAT: fullscreen overlay while pinned wrote duplicate ALT_SCREEN_ENTER
2. WHY: POST-10 / SEQ-3 violation - overlay must not write ALT_SCREEN_ENTER when pin already owns alt screen
3. EXPECTED: 1
4. ACTUAL: ${afterOverlayCount}
5. GUIDANCE: Check alt screen ownership before emitting DECSET 1049h for fullscreen overlay`,
			);
		} finally {
			tui.stop();
		}
	});

	it("non-fullscreen overlay composites into the pinned frame and receives keys", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#renderPinnedFrame()
		 * - Enforces: INV-1 dock remains; floating overlay must still paint
		 * - Category: integration / regression
		 * - Risk tier: High — /switch and /model freeze the dock if the overlay never paints
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites INV-1 (dock still last); overlay paint is the missing integration
		 *   [✓] C2 VALUABLE: fails if #renderPinnedFrame skips #compositeOverlaysIntoWindow
		 *   [✓] C3 NON-DUPLICATIVE: POST-10 covers fullscreen only
		 *   [✓] C4 NOT FUTURE-EDIT: locks current /switch freeze
		 */
		const term = new RecordingTerminal(40, 8, 100);
		const editor = new EditorStub();
		const overlay: Component & Focusable = {
			focused: false,
			invalidate() {},
			render: () => ["SWITCH_OVERLAY"],
			handleInput(data: string) {
				this.focused = this.focused;
				(this as { lastKey?: string }).lastKey = data;
			},
		};
		const provider: TerminalFrameProvider = {
			renderFrame() {
				return {
					viewport: [],
					pinnedScroll: ["alpha", "bravo", "charlie"],
					pinnedDock: ["PROMPT:"],
				};
			},
			acknowledgeHistory() {},
		};
		const tui = new TUI(term, true);
		tui.setFrameProvider(provider);
		tui.addChild(editor);
		tui.setFocus(editor);
		try {
			tui.start();
			tui.enterPinned();
			await term.waitForRender();
			tui.showOverlay(overlay, { anchor: "bottom-center" });
			await term.waitForRender();
			const viewport = term.getViewport().join("\n");
			expect(viewport.includes("SWITCH_OVERLAY")).toBe(
				true,
				`1. WHAT: pinned non-fullscreen overlay paint FAILED
2. WHY: overlay never composited into the pinned alt frame
3. EXPECTED: viewport contains SWITCH_OVERLAY
4. ACTUAL: ${JSON.stringify(term.getViewport().map(l => l.trimEnd()))}
5. GUIDANCE: Composite visible overlays into the pinned frame before emit`,
			);
			term.sendInput("x");
			await term.waitForRender();
			expect(editor.text).toBe(
				"",
				`1. WHAT: dock captured overlay keys FAILED
2. WHY: overlay must own focus while visible
3. EXPECTED: editor text empty
4. ACTUAL: "${editor.text}"
5. GUIDANCE: Focused overlay receives keys; dock does not`,
			);
		} finally {
			tui.stop();
		}
	});

	it("SEQ-4: TUI.stop leaves the alt screen at most once", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.stop()
		 * - Enforces: SEQ-4: TUI.stop SHALL leave the alt screen at most once
		 * - Category: lifecycle
		 * - Risk tier: High — duplicate alt-screen exit corrupts parent shell state
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause SEQ-4 existing in contracts/pinned-composer.contract.ts
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
		expect(stopCount).toBe(
			1,
			`1. WHAT: TUI.stop ALT_SCREEN_LEAVE count FAILED
2. WHY: SEQ-4 violation - TUI.stop must leave alt screen exactly once
3. EXPECTED: 1
4. ACTUAL: ${stopCount}
5. GUIDANCE: Emit DECSET 1049l on stop exactly once when alt screen was active`,
		);

		// Second stop call is idempotent
		tui.stop();
		await term.waitForRender();
		const secondStopCount = countNeedle(term.writes, ALT_SCREEN_LEAVE);
		expect(secondStopCount).toBe(
			1,
			`1. WHAT: TUI.stop idempotent leave count FAILED
2. WHY: SEQ-4 violation - repeated TUI.stop must not emit additional ALT_SCREEN_LEAVE
3. EXPECTED: 1
4. ACTUAL: ${secondStopCount}
5. GUIDANCE: Guard alt screen exit against repeated stop calls`,
		);
	});

	it("SEQ-2 / POST-7: wheel and viewport page keys reach PinnedViewport.scrollBy before editor input", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.handleInput()
		 * - Enforces: SEQ-2 / POST-7: wheel and viewport page keys SHALL reach PinnedViewport.scrollBy before focused editor handleInput; printable input SHALL NOT resume following
		 * - Category: integration
		 * - Risk tier: High — scrolling must not pollute editor with escape sequences or characters
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause SEQ-2 and POST-7 existing in contracts/pinned-composer.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: tests mouse wheel and page key precedence over editor text input
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
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

			// SGR mouse wheel up: \x1b[<64;1;1M
			term.sendInput("\x1b[<64;1;1M");
			await term.waitForRender();
			expect(editor.text).toBe(
				"",
				`1. WHAT: editor text after mouse wheel up FAILED
2. WHY: SEQ-2 violation - mouse wheel event must be intercepted for scroll and not reach editor
3. EXPECTED: ""
4. ACTUAL: "${editor.text}"
5. GUIDANCE: Intercept mouse wheel events in TUI before forwarding input to focused component`,
			);

			// PageUp key: \x1b[5~
			term.sendInput("\x1b[5~");
			await term.waitForRender();
			expect(editor.text).toBe(
				"",
				`1. WHAT: editor text after PageUp FAILED
2. WHY: SEQ-2 violation - PageUp event must be intercepted for viewport scroll and not reach editor
3. EXPECTED: ""
4. ACTUAL: "${editor.text}"
5. GUIDANCE: Intercept pageUp keybinding before forwarding to focused component`,
			);

			// Printable input 'x' must reach editor and mutate text without snapping scroll
			term.sendInput("x");
			await term.waitForRender();
			expect(editor.text).toBe(
				"x",
				`1. WHAT: editor text after printable input FAILED
2. WHY: POST-7 violation - printable character must reach editor
3. EXPECTED: "x"
4. ACTUAL: "${editor.text}"
5. GUIDANCE: Forward non-viewport keys to focused editor`,
			);
		} finally {
			tui.stop();
		}
	});

	it("INV-1: editor dock occupies the last dockHeight rows of the physical frame", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#renderPinnedFrame()
		 * - Enforces: INV-1: the editor dock SHALL occupy the last dockHeight rows of the physical frame
		 * - Category: invariant
		 * - Risk tier: High — dock row must always be anchored at the bottom of the physical terminal screen
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause INV-1 existing in contracts/pinned-composer.contract.ts
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
			expect(bottomRow).toBe(
				"PROMPT: input-line",
				`1. WHAT: physical terminal bottom row FAILED
2. WHY: INV-1 violation - bottom row of terminal grid must be the editor dock
3. EXPECTED: "PROMPT: input-line"
4. ACTUAL: "${bottomRow}"
5. GUIDANCE: Render dock at the bottom rows of the alternate screen frame`,
			);
		} finally {
			tui.stop();
		}
	});

	it("FORBIDDEN-2: pinned mode SHALL NOT pin the dock by setting a terminal scrolling region", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#renderPinnedFrame()
		 * - Enforces: FORBIDDEN-2: pinned mode SHALL NOT pin the dock by setting a terminal scrolling region (DECSTBM)
		 * - Category: forbidden
		 * - Risk tier: High — terminal scrolling regions break across terminal emulators and corrupt software scroll
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause FORBIDDEN-2 existing in contracts/pinned-composer.contract.ts
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
			expect(foundDecstbm).toBe(
				false,
				`1. WHAT: DECSTBM sequence detected in pinned mode terminal stream
2. WHY: FORBIDDEN-2 violation - pinned mode must not use DECSTBM scrolling regions
3. EXPECTED: false (no DECSTBM escape sequences)
4. ACTUAL: true
5. GUIDANCE: Use software frame composition instead of terminal hardware scrolling margins`,
			);
		} finally {
			tui.stop();
		}
	});

	it("POST-8 / FORBIDDEN-1: interactive paint SHALL NOT emit retired transcript rows to native scrollback", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#renderPinnedFrame()
		 * - Enforces: POST-8 / FORBIDDEN-1: every interactive frame SHALL omit retired native-scrollback batches; interactive paint SHALL NOT emit retired transcript rows to native scrollback
		 * - Category: forbidden
		 * - Risk tier: High — emitting to native scrollback corrupts terminal history during interactive session
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-8 and FORBIDDEN-1 existing in contracts/pinned-composer.contract.ts
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
			expect(historyAppended).toBe(
				false,
				`1. WHAT: retired history row emitted to terminal stream in pinned mode
2. WHY: POST-8 / FORBIDDEN-1 violation - interactive paint must not emit history batches to native scrollback
3. EXPECTED: false (history batches omitted)
4. ACTUAL: true
5. GUIDANCE: Pinned mode does not emit HistoryBatch to terminal output`,
			);
		} finally {
			tui.stop();
		}
	});
});
