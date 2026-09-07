import { describe, expect, it } from "bun:test";
import {
	Input,
	Text,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	TUI,
	type ViewportSize,
} from "@oh-my-pi/pi-tui";
import { parseSgrMouseStream } from "@oh-my-pi/pi-tui/mouse";
import {
	CONTRACT_PINNED_DOCK,
	OSC52_CLIPBOARD_PREFIX,
} from "../../../requirements/contracts/pinned_dock.contract";
import { VirtualTerminal } from "./virtual-terminal";

/**
 * Boundary spy: delegates grid behavior to VirtualTerminal and records exact
 * terminal writes solely for POST-PV-6's OSC 52 observable.
 *
 * Double type: Spy.
 * Contract: requirements/contracts/pinned_dock.contract.ts POST-PV-6.
 */
class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

/**
 * Immutable frame input for real TUI lifecycle tests. It contains no provider
 * behavior under test; its values are the transcript and dock inputs governed
 * by the pinned-dock contract.
 */
class StaticPinnedFrameProvider implements TerminalFrameProvider {
	readonly transcript: readonly string[];
	readonly dock: readonly string[];

	constructor(transcript: readonly string[], dock: readonly string[]) {
		this.transcript = transcript;
		this.dock = dock;
	}

	renderFrame(_viewport: ViewportSize): TerminalFramePlan {
		return {
			viewport: [],
			pinnedScroll: [...this.transcript],
			pinnedDock: [...this.dock],
		};
	}
}

const postPv3 = CONTRACT_PINNED_DOCK["POST-PV-3"];
const postPv4 = CONTRACT_PINNED_DOCK["POST-PV-4"];
const postPv6 = CONTRACT_PINNED_DOCK["POST-PV-6"];
const seqPv2 = CONTRACT_PINNED_DOCK["SEQ-PV-2"];
const seqPv5 = CONTRACT_PINNED_DOCK["SEQ-PV-5"];

describe("pinned dock refactor — SLICE-1 overlay compositing and selection integrity", () => {
	it("POST-PV-4 / FORBIDDEN-PV-1: decodes every report in one concatenated SGR mouse chunk", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: parseSgrMouseStream()
		 * - Enforces: POST-PV-4: parseSgrMouseStream SHALL extract and decode all concatenated SGR mouse reports in a single stdin buffer chunk without dropping reports.
		 * - Enforces: FORBIDDEN-PV-1 / INV-PV-4: a multi-report SGR chunk SHALL NOT be dropped, return null, or lose constituent reports.
		 * - Category: boundary
		 * - Test pyramid: Unit
		 * - Risk tier: High — a dropped packet loses wheel momentum or a drag transition.
		 * - Adversarial: Contract-governed, implementation-aware.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-4, FORBIDDEN-PV-1, and INV-PV-4 in requirements/contracts/pinned_dock.contract.ts.
		 *   [✓] C2 VALUABLE: an implementation that parses only the first report, reorders reports, or decodes a flag incorrectly fails the exact event-array assertion.
		 *   [✓] C3 NON-DUPLICATIVE: directly exercises parseSgrMouseStream; existing router tests exercise the distinct routeSgrMouseInput surface.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current multi-report parsing guarantee.
		 */
		const chunk = "\x1b[<64;7;3M\x1b[<0;4;2M\x1b[<32;8;2M\x1b[<0;8;2m";
		const events = parseSgrMouseStream(chunk);

		expect(events).toEqual(
			[
				{ button: 64, col: 6, row: 2, release: false, wheel: -1, motion: false, leftClick: false },
				{ button: 0, col: 3, row: 1, release: false, wheel: null, motion: false, leftClick: true },
				{ button: 32, col: 7, row: 1, release: false, wheel: null, motion: true, leftClick: false },
				{ button: 0, col: 7, row: 1, release: true, wheel: null, motion: false, leftClick: false },
			],
			`1. WHAT: test_post_pv_4_decodes_concatenated_sgr_reports FAILED
2. WHY: POST-PV-4 / FORBIDDEN-PV-1 / INV-PV-4 violation - ${postPv4.description}
3. EXPECTED: four decoded reports in source order: wheel-up, left-press, drag-motion, left-release
4. ACTUAL: ${JSON.stringify(events)}
5. GUIDANCE: Preserve and decode every complete SGR report present in the received input chunk`,
		);
	});

	it("POST-PV-3 / SEQ-PV-2: composites every visible floating and anchored overlay before input is delivered", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI pinned render lifecycle.
		 * - Enforces: POST-PV-3: TUI.#renderPinnedFrame SHALL composite all active visible floating and anchored overlays over the composed base frame before emitting to the terminal.
		 * - Enforces: SEQ-PV-2 / INV-PV-2 / INV-PV-3: composition follows frame construction and visible overlay focus remains input-capable.
		 * - Category: integration
		 * - Test pyramid: Integration
		 * - Risk tier: High — an invisible focused overlay freezes the prompt dock.
		 * - Adversarial: Contract-governed, implementation-aware.
		 *
		 * SEQ_TEST_SELF_CHECK:
		 *   [✓] Constructs TUI through its public lifecycle.
		 *   [✓] Verifies composed terminal output and focused overlay input through observable state.
		 *   [✓] Does not call private composition or focus methods directly.
		 *   [✓] Uses only real TUI components at construction time.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-3, SEQ-PV-2, INV-PV-2, and INV-PV-3 in requirements/contracts/pinned_dock.contract.ts.
		 *   [✓] C2 VALUABLE: omitting either overlay or focusing an uncomposited overlay fails a distinct observable assertion.
		 *   [✓] C3 NON-DUPLICATIVE: requires simultaneous floating and anchored overlays; existing tests cover one anchored overlay only.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the active-overlay composition and focus guarantees already contracted.
		 */
		const terminal = new VirtualTerminal(50, 12, 100);
		const tui = new TUI(terminal, false);
		const anchoredInput = new Input();
		anchoredInput.prompt = "ANCHOR_OVERLAY:";
		const floatingOverlay = new Text("FLOATING_OVERLAY", 0, 0);

		tui.setFrameProvider(new StaticPinnedFrameProvider(["TRANSCRIPT_BASE"], ["PROMPT_DOCK"]));
		try {
			tui.start();
			tui.enterPinned();
			await terminal.waitForRender();

			tui.showOverlay(floatingOverlay, { anchor: "top-left" });
			tui.showOverlay(anchoredInput, { anchor: "bottom-right" });
			await terminal.waitForRender();

			const renderedFrame = terminal.getViewport().join("\n");
			expect(renderedFrame.includes("FLOATING_OVERLAY")).toBe(
				true,
				`1. WHAT: test_post_pv_3_composites_floating_overlay FAILED
2. WHY: POST-PV-3 / INV-PV-2 violation - ${postPv3.description}
3. EXPECTED: emitted pinned frame contains the visible floating overlay text "FLOATING_OVERLAY"
4. ACTUAL: ${JSON.stringify(terminal.getViewport().map(line => line.trimEnd()))}
5. GUIDANCE: Paint every visible floating overlay into the pinned frame before terminal emission`,
			);
			expect(renderedFrame.includes("ANCHOR_OVERLAY:")).toBe(
				true,
				`1. WHAT: test_post_pv_3_composites_anchored_overlay FAILED
2. WHY: POST-PV-3 / SEQ-PV-2 violation - ${seqPv2.description}
3. EXPECTED: emitted pinned frame contains the visible anchored overlay prompt "ANCHOR_OVERLAY:"
4. ACTUAL: ${JSON.stringify(terminal.getViewport().map(line => line.trimEnd()))}
5. GUIDANCE: Composite anchored overlays after frame construction and before terminal emission`,
			);

			terminal.sendInput("z");
			await terminal.waitForRender();
			expect(anchoredInput.getValue()).toBe(
				"z",
				`1. WHAT: test_inv_pv_3_visible_overlay_receives_input FAILED
2. WHY: INV-PV-3 violation - visible composited overlay did not receive its focused input
3. EXPECTED: anchored overlay input value "z"
4. ACTUAL: ${JSON.stringify(anchoredInput.getValue())}
5. GUIDANCE: Give keyboard focus only to a visible composited overlay and deliver its input without freezing the dock`,
			);
		} finally {
			tui.stop();
		}
	});

	it("POST-PV-6: copies an exact multi-row transcript selection through OSC 52 on release", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI pinned input lifecycle.
		 * - Enforces: POST-PV-6: left-button drag across transcript rows SHALL capture selected plaintext and copy it to the clipboard via OSC 52 upon button release.
		 * - Category: boundary
		 * - Test pyramid: Integration
		 * - Risk tier: High — failed cross-row selection loses terminal copy behavior.
		 * - Adversarial: Contract-governed, implementation-aware.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-6 in requirements/contracts/pinned_dock.contract.ts.
		 *   [✓] C2 VALUABLE: wrong row ordering, column bounds, plaintext extraction, encoding, or OSC 52 emission fails the exact packet assertion.
		 *   [✓] C3 NON-DUPLICATIVE: covers the multi-row selection boundary; existing coverage uses a single transcript row.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current selection-to-clipboard behavior.
		 */
		const terminal = new RecordingTerminal(48, 8, 100);
		const tui = new TUI(terminal, false);
		const selectedPlaintext = "ALPHA_TRANSCRIPT_LINE\nBETA";
		const expectedOsc52 = `${OSC52_CLIPBOARD_PREFIX}${Buffer.from(selectedPlaintext, "utf8").toString("base64")}\x07`;

		tui.setFrameProvider(
			new StaticPinnedFrameProvider(
				["ALPHA_TRANSCRIPT_LINE", "BETA_TRANSCRIPT_LINE", "GAMMA_TRANSCRIPT_LINE"],
				["PROMPT_DOCK"],
			),
		);
		try {
			tui.start();
			tui.enterPinned();
			await terminal.waitForRender();

			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;5;2M");
			terminal.sendInput("\x1b[<0;5;2m");
			await terminal.waitForRender();

			expect(terminal.writes.join("").includes(expectedOsc52)).toBe(
				true,
				`1. WHAT: test_post_pv_6_copies_multi_row_selection FAILED
2. WHY: POST-PV-6 violation - ${postPv6.description}
3. EXPECTED: exact OSC 52 clipboard packet for ${JSON.stringify(selectedPlaintext)}
4. ACTUAL: terminal emitted OSC 52 packet=${terminal.writes.join("").includes(expectedOsc52)}
5. GUIDANCE: Preserve selected plaintext across transcript rows and emit one matching OSC 52 packet on release`,
			);
		} finally {
			tui.stop();
		}
	});

	it("SEQ-PV-5: overlay focus clears an in-progress drag before a later release", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI pinned input lifecycle.
		 * - Enforces: SEQ-PV-5: TUI SHALL reset active drag selection state when an overlay steals focus or when pinned mode exits.
		 * - Enforces: POST-PV-6: only an uninterrupted transcript drag may emit its OSC 52 clipboard copy.
		 * - Category: negative integration
		 * - Test pyramid: Integration
		 * - Risk tier: High — stale selection can copy plaintext after a focus transition.
		 * - Adversarial: Contract-governed, implementation-aware.
		 *
		 * SEQ_TEST_SELF_CHECK:
		 *   [✓] Constructs TUI and the overlay through public lifecycle methods.
		 *   [✓] Observes the terminal write boundary after focus is stolen and restored.
		 *   [✓] Does not call private drag or focus methods directly.
		 *   [✓] Uses real Input overlay construction; no dependency is replaced after construction.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites SEQ-PV-5 and POST-PV-6 in requirements/contracts/pinned_dock.contract.ts.
		 *   [✓] C2 VALUABLE: retaining a drag anchor across overlay focus makes the release emit OSC 52 and fails this assertion.
		 *   [✓] C3 NON-DUPLICATIVE: tests the overlay-focus interruption path; existing coverage tests only pinned-mode exit interruption.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the explicit current drag-state reset obligation.
		 */
		const terminal = new RecordingTerminal(48, 8, 100);
		const tui = new TUI(terminal, false);
		const overlay = new Input();
		overlay.prompt = "FOCUS_STEALER:";

		tui.setFrameProvider(new StaticPinnedFrameProvider(["SELECTABLE_TRANSCRIPT"], ["PROMPT_DOCK"]));
		try {
			tui.start();
			tui.enterPinned();
			await terminal.waitForRender();

			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;6;1M");
			await terminal.waitForRender();

			const handle = tui.showOverlay(overlay, { anchor: "center" });
			await terminal.waitForRender();
			handle.hide();
			await terminal.waitForRender();

			const writesBeforeRelease = terminal.writes.length;
			terminal.sendInput("\x1b[<0;6;1m");
			await terminal.waitForRender();
			const writesAfterInterruptedRelease = terminal.writes.slice(writesBeforeRelease).join("");

			expect(writesAfterInterruptedRelease.includes(OSC52_CLIPBOARD_PREFIX)).toBe(
				false,
				`1. WHAT: test_seq_pv_5_overlay_focus_clears_drag FAILED
2. WHY: SEQ-PV-5 / POST-PV-6 violation - ${seqPv5.description}
3. EXPECTED: no OSC 52 clipboard write after a drag is interrupted by overlay focus
4. ACTUAL: OSC 52 clipboard write emitted=${writesAfterInterruptedRelease.includes(OSC52_CLIPBOARD_PREFIX)}
5. GUIDANCE: Discard active drag selection immediately when overlay focus takes control`,
			);
		} finally {
			tui.stop();
		}
	});
});
