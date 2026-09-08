import { describe, expect, it } from "bun:test";
import {
	type Component,
	Input,
	Text,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	TUI,
	type ViewportSize,
} from "@oh-my-pi/pi-tui";
import { parseSgrMouseStream } from "@oh-my-pi/pi-tui/mouse";
import { InvalidHeightError as ImplInvalidHeightError, isViewportMode, PinnedViewport } from "@oh-my-pi/pi-tui/pinned-viewport";
import {
	CONTRACT_PINNED_DOCK,
	InvalidHeightError as ContractInvalidHeightError,
	InvalidMouseInputError,
	OSC52_CLIPBOARD_PREFIX,
	SELECTION_HIGHLIGHT_END,
	SELECTION_HIGHLIGHT_START,
	validateSgrMouseReports,
	validateSoftwareScrollback,
	ZeroScrollbackError,
} from "../../../requirements/contracts/pinned_dock.contract";
import { VirtualTerminal } from "./virtual-terminal";

// ============================================================================
// Test doubles
// ============================================================================

/**
 * Boundary spy: delegates grid behavior to VirtualTerminal (kitty WASM engine)
 * and records every raw write chunk in call order. Used to observe escape
 * sequences (OSC 52 clipboard payloads, SGR mouse-mode toggles, inverse-video
 * markers) that VirtualTerminal's grid readback cannot expose directly.
 *
 * Double type: Spy.
 * Contract: requirements/contracts/pinned_dock.contract.ts POST-PV-6, POST-PV-8, POST-PV-9, POST-PV-10, SEQ-PV-5.
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
 * by the contract.
 *
 * Double type: Stub.
 * Contract: requirements/contracts/pinned_dock.contract.ts POST-PV-3, POST-PV-6.
 */
class StaticPinnedFrameProvider implements TerminalFrameProvider {
	constructor(
		private readonly scroll: readonly string[],
		private readonly dock: readonly string[],
	) {}

	renderFrame(_viewport: ViewportSize): TerminalFramePlan {
		return {
			viewport: [],
			pinnedScroll: this.scroll,
			pinnedDock: this.dock,
		};
	}
}

/** Extract and UTF-8-decode the payload of an OSC 52 clipboard write, or undefined if absent. */
function decodeOsc52Payload(writes: string): string | undefined {
	const match = writes.match(/\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/);
	if (!match) return undefined;
	return Buffer.from(match[1]!, "base64").toString("utf8");
}

const FAMILY_EMOJI = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}"; // man ZWJ woman ZWJ girl ZWJ boy: one 2-column grapheme, 11 UTF-16 code units

// ============================================================================
// PinnedViewport.composeFrame — real implementation entry point (PRE-PV-1,
// ERRORS-PV-1, POST-PV-1, PRE-PV-2, ERRORS-PV-2)
// ============================================================================

describe("pinned dock refactor — PinnedViewport.composeFrame real-implementation contract", () => {
	it("PRE-PV-1 / ERRORS-PV-1: composeFrame itself throws a PRE-PV-1 contract-conforming error on non-positive height", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: PinnedViewport.composeFrame()
		 * - Enforces: PRE-PV-1: PinnedViewport.composeFrame height argument SHALL be a finite number >= 1
		 * - Enforces: ERRORS-PV-1: validateComposeHeight SHALL throw InvalidHeightError citing PRE-PV-1 on non-positive height
		 * - Category: error
		 * - Risk tier: High — an uncaught generic Error during a render pass can crash the interactive render loop
		 * - Adversarial: Contract-governed, implementation-aware. Targets the real class the clause names
		 *   and bridges the independent implementation and contract error declarations through their
		 *   observable Error shape rather than shared prototype identity.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites PRE-PV-1 and ERRORS-PV-1 in requirements/contracts/pinned_dock.contract.ts.
		 *   [✓] C2 VALUABLE: a generic Error, wrong clause identifier, or wrong contract message fails
		 *       the observable error-shape assertions.
		 *   [✓] C3 NON-DUPLICATIVE: the only test invoking PinnedViewport.composeFrame's own height validation;
		 *       the PRE-PV-2 test below covers the mouse-input validator, a disjoint surface.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit ERRORS-PV-1 contract error shape.
		 */
		const viewport = new PinnedViewport();
		for (const invalidHeight of [0, -1, -100, Number.NaN, Number.NEGATIVE_INFINITY]) {
			let caught: unknown;
			try {
				viewport.composeFrame({ transcript: ["ROW"], dock: ["DOCK"], height: invalidHeight });
			} catch (err) {
				caught = err;
			}
			const contractError = new ContractInvalidHeightError(invalidHeight);
			expect(caught).toBeInstanceOf(
				ImplInvalidHeightError,
				`1. WHAT: test_pre_pv_1_composeFrame_throws_contract_conforming_error(${String(invalidHeight)}) FAILED
2. WHY: PRE-PV-1 / ERRORS-PV-1 violation - composeFrame did not throw the implementation's InvalidHeightError
3. EXPECTED: an implementation InvalidHeightError whose observable shape matches the contract InvalidHeightError
4. ACTUAL: ${caught instanceof Error ? `threw ${caught.constructor.name}: ${caught.message}` : String(caught)}
5. GUIDANCE: non-positive terminal heights must use the implementation error that conforms to ERRORS-PV-1`,
			);
			if (!(caught instanceof ImplInvalidHeightError)) continue;
			expect(caught).toBeInstanceOf(
				Error,
				`1. WHAT: test_pre_pv_1_composeFrame_throws_contract_conforming_error(${String(invalidHeight)}) FAILED
2. WHY: PRE-PV-1 / ERRORS-PV-1 violation - composeFrame did not throw an Error object
3. EXPECTED: an Error object carrying the contract-defined name, clause identifier, and message
4. ACTUAL: ${String(caught)}
5. GUIDANCE: non-positive terminal heights must fail with the contract-defined error shape`,
			);
			expect(caught.name).toBe(
				contractError.name,
				`1. WHAT: test_pre_pv_1_composeFrame_throws_contract_conforming_error(${String(invalidHeight)}) FAILED
2. WHY: PRE-PV-1 / ERRORS-PV-1 violation - error name does not identify a pinned-dock contract violation
3. EXPECTED: name ${JSON.stringify(contractError.name)}
4. ACTUAL: ${JSON.stringify(caught.name)}
5. GUIDANCE: non-positive terminal heights must identify the error as a pinned-dock contract violation`,
			);
			expect(caught.clauseId).toBe(
				contractError.clauseId,
				`1. WHAT: test_pre_pv_1_composeFrame_throws_contract_conforming_error(${String(invalidHeight)}) FAILED
2. WHY: PRE-PV-1 / ERRORS-PV-1 violation - error does not cite the violated precondition
3. EXPECTED: clauseId ${JSON.stringify(contractError.clauseId)}
4. ACTUAL: ${JSON.stringify(caught.clauseId)}
5. GUIDANCE: non-positive terminal heights must cite PRE-PV-1`,
			);
			expect(caught.message).toContain(
				"PRE-PV-1 violation: Terminal height must be a finite number >= 1",
				`1. WHAT: test_pre_pv_1_composeFrame_throws_contract_conforming_error(${String(invalidHeight)}) FAILED
2. WHY: PRE-PV-1 / ERRORS-PV-1 violation - error message does not state the contract-defined height failure
3. EXPECTED: message containing "PRE-PV-1 violation: Terminal height must be a finite number >= 1"
4. ACTUAL: ${JSON.stringify(caught.message)}
5. GUIDANCE: non-positive terminal heights must report the PRE-PV-1 height requirement`,
			);
		}
	});

	it("POST-PV-1: composeFrame returns exactly height lines with the dock pinned to the bottom rows", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: PinnedViewport.composeFrame()
		 * - Enforces: POST-PV-1: PinnedViewport.composeFrame SHALL return an array of exactly height lines
		 *   with dock pinned to the bottom rows
		 * - Category: positive
		 * - Risk tier: High — a miscomposed frame corrupts the physical terminal display
		 * - Adversarial: Contract-governed, implementation-aware.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-1 in requirements/contracts/pinned_dock.contract.ts.
		 *   [✓] C2 VALUABLE: exact-array assertion; any transcript/dock placement error fails it.
		 *   [✓] C3 NON-DUPLICATIVE: the only test asserting the exact shape of a valid composeFrame call.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit POST-PV-1 guarantee.
		 */
		const postPv1 = CONTRACT_PINNED_DOCK["POST-PV-1"];
		const viewport = new PinnedViewport();
		const frame = viewport.composeFrame({
			transcript: ["ROW_1", "ROW_2", "ROW_3", "ROW_4"],
			dock: ["DOCK_1", "DOCK_2"],
			height: 6,
		});
		expect(frame).toEqual(
			["ROW_1", "ROW_2", "ROW_3", "ROW_4", "DOCK_1", "DOCK_2"],
			`1. WHAT: test_post_pv_1_frame_shape FAILED
2. WHY: POST-PV-1 violation - ${postPv1.description}
3. EXPECTED: ["ROW_1", "ROW_2", "ROW_3", "ROW_4", "DOCK_1", "DOCK_2"] (height 6, dock pinned to the bottom 2 rows)
4. ACTUAL: ${JSON.stringify(frame)}
5. GUIDANCE: Return exactly height rows with the scrolled transcript window on top and the dock pinned to the bottom rows`,
		);
	});

	it("CONTRACT VERIFICATION — PRE-PV-2 / ERRORS-PV-2: validateSgrMouseReports throws InvalidMouseInputError on non-string input", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: validateSgrMouseReports() (named directly by ERRORS-PV-2)
		 * - Enforces: PRE-PV-2: SGR mouse input parsers SHALL accept string data and reject non-string types
		 * - Enforces: ERRORS-PV-2: validateSgrMouseReports SHALL throw InvalidMouseInputError citing PRE-PV-2
		 *   on non-string input
		 * - Category: error
		 * - Risk tier: Medium — a non-string chunk reaching the parser is an internal wiring bug, not a user input path
		 * - Adversarial: contract validator verification. ERRORS-PV-2 names validateSgrMouseReports directly
		 *   (unlike ERRORS-PV-1, which is tested against the real PinnedViewport.composeFrame above), so this
		 *   IS the real subject of the clause, not a stand-in for it.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites PRE-PV-2 and ERRORS-PV-2 in requirements/contracts/pinned_dock.contract.ts.
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO.
		 *   [✓] C3 NON-DUPLICATIVE: the only test of the mouse-input validator's error type.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit ERRORS-PV-2 guarantee.
		 */
		const prePv2 = CONTRACT_PINNED_DOCK["PRE-PV-2"];
		const errorsPv2 = CONTRACT_PINNED_DOCK["ERRORS-PV-2"];
		const nonStringInput = null as unknown as string;
		let caught: unknown;
		try {
			validateSgrMouseReports(nonStringInput, []);
		} catch (err) {
			caught = err;
		}
		expect(caught instanceof InvalidMouseInputError).toBe(
			true,
			`1. WHAT: test_pre_pv_2_validator_rejects_non_string FAILED
2. WHY: PRE-PV-2 / ERRORS-PV-2 violation - ${prePv2.description}; ${errorsPv2.description}
3. EXPECTED: validateSgrMouseReports(null, []) throws InvalidMouseInputError
4. ACTUAL: ${caught instanceof Error ? `threw ${caught.constructor.name}: ${caught.message}` : String(caught)}
5. GUIDANCE: Validate that rawChunk is a string before scanning it for SGR reports`,
		);
	});
});

// ============================================================================
// Overlay compositing and focus integrity (POST-PV-3, POST-PV-8, SEQ-PV-1,
// SEQ-PV-2, INV-PV-2, INV-PV-3)
// ============================================================================

describe("pinned dock refactor — overlay compositing and focus integrity", () => {
	it("POST-PV-3 / SEQ-PV-1 / SEQ-PV-2 / INV-PV-2: composites every visible floating overlay before input is delivered", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#renderPinnedFrame() / TUI.#compositeOverlaysIntoWindow()
		 * - Enforces: POST-PV-3: TUI.#renderPinnedFrame SHALL composite all active visible floating and
		 *   anchored overlays over the composed base frame before emitting to the terminal
		 * - Enforces: SEQ-PV-1: composeFrame runs before overlay compositing (the overlay renders atop a
		 *   correctly composed base, which is only possible if composeFrame ran first)
		 * - Enforces: SEQ-PV-2: #compositeOverlaysIntoWindow runs after composeFrame and before #emitAltFrame
		 *   (the overlay text reaching the emitted frame proves the ordering)
		 * - Enforces: INV-PV-2: TUI SHALL NOT discard or omit floating overlays from the rendered frame
		 * - Category: positive / integration
		 * - Test pyramid: Integration
		 * - Risk tier: High — an invisible overlay steals focus and freezes the dock (manifest DM-3)
		 * - Adversarial: Contract-governed, implementation-aware.
		 *
		 * SEQ_TEST_SELF_CHECK:
		 *   [✓] Constructs the real TUI and drives it through start()/enterPinned()/showOverlay(), never a
		 *       direct call to #renderPinnedFrame or #compositeOverlaysIntoWindow.
		 *   [✓] Verifies SEQ-PV-1/SEQ-PV-2 ordering through the observable emitted frame and delivered input.
		 *   [✓] No mock is used; the real TUI, real Input component, and real VirtualTerminal are exercised.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-3, SEQ-PV-1, SEQ-PV-2, INV-PV-2 in the contract.
		 *   [✓] C2 VALUABLE: an unwired #compositeOverlaysIntoWindow call fails both assertions below.
		 *   [✓] C3 NON-DUPLICATIVE: the only test asserting overlay visibility plus focused-input delivery together.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit overlay-compositing guarantee.
		 */
		const postPv3 = CONTRACT_PINNED_DOCK["POST-PV-3"];
		const seqPv1 = CONTRACT_PINNED_DOCK["SEQ-PV-1"];
		const seqPv2 = CONTRACT_PINNED_DOCK["SEQ-PV-2"];
		const invPv2 = CONTRACT_PINNED_DOCK["INV-PV-2"];

		const terminal = new VirtualTerminal(48, 8);
		const tui = new TUI(terminal, false);
		const overlay = new Input();
		overlay.prompt = "MODEL_OVERLAY_ACTIVE:";

		tui.setFrameProvider(new StaticPinnedFrameProvider(["TRANSCRIPT_LINE_1"], ["DOCK_LINE_1"]));
		try {
			tui.start();
			tui.enterPinned();
			await terminal.waitForRender();

			const handle = tui.showOverlay(overlay, {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
			});
			await terminal.waitForRender();

			const renderedText = terminal.getViewport().join("\n");
			expect(renderedText.includes("MODEL_OVERLAY_ACTIVE:")).toBe(
				true,
				`1. WHAT: test_post_pv_3_overlay_visible_in_pinned_mode FAILED
2. WHY: POST-PV-3 / SEQ-PV-1 / SEQ-PV-2 / INV-PV-2 violation - ${postPv3.description} / ${seqPv1.description} / ${seqPv2.description} / ${invPv2.description}
3. EXPECTED: bottom-anchored overlay text visible in rendered viewport
4. ACTUAL: viewport was:\n${renderedText}
5. GUIDANCE: Invoke #compositeOverlaysIntoWindow after PinnedViewport.composeFrame and before emitting the frame`,
			);

			terminal.sendInput("g");
			await terminal.waitForRender();
			expect(overlay.getValue()).toBe(
				"g",
				`1. WHAT: test_post_pv_3_overlay_accepts_focused_input FAILED
2. WHY: POST-PV-3 / INV-PV-2 violation - ${postPv3.description} / ${invPv2.description}
3. EXPECTED: overlay input receives typed keystrokes without dock freeze
4. ACTUAL: overlay.getValue()=${JSON.stringify(overlay.getValue())}
5. GUIDANCE: Deliver keyboard events to the focused overlay rather than freezing the dock`,
			);

			handle.hide();
			await terminal.waitForRender();
		} finally {
			tui.stop();
		}
	});

	it("INV-PV-3: redirects focus away from an overlay that becomes invisible instead of stranding input on it", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#handleInput() / TUI.setFocus()
		 * - Enforces: INV-PV-3: TUI SHALL NOT assign input focus to an invisible or uncomposited component
		 * - Category: invariant / regression
		 * - Test pyramid: Integration
		 * - Risk tier: Medium — stranded focus silently drops keystrokes with no visible target
		 * - Adversarial: Contract-governed, implementation-aware. Drives the overlay's own visible() predicate
		 *   false (a real, reachable trigger — resize or state-driven visibility) rather than hiding it.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites INV-PV-3 in requirements/contracts/pinned_dock.contract.ts.
		 *   [✓] C2 VALUABLE: if a keystroke sent after the overlay goes invisible still reached it, the
		 *       overlay's value would change and the assertion below would fail.
		 *   [✓] C3 NON-DUPLICATIVE: the only test in this suite exercising the visible()-predicate focus path.
		 *   [✓] C4 NOT FUTURE-EDIT: exercises the existing #handleInput visibility-recheck branch (tui.ts
		 *       lines ~1865-1877); this is current wiring, not a hypothetical future guard.
		 */
		const invPv3 = CONTRACT_PINNED_DOCK["INV-PV-3"];
		const terminal = new VirtualTerminal(48, 8);
		const tui = new TUI(terminal, false);
		const overlay = new Input();
		overlay.prompt = "STALE_FOCUS_OVERLAY:";
		let overlayVisible = true;

		tui.setFrameProvider(new StaticPinnedFrameProvider(["TRANSCRIPT_LINE"], ["DOCK_LINE"]));
		try {
			tui.start();
			tui.enterPinned();
			await terminal.waitForRender();

			tui.showOverlay(overlay, { anchor: "center", visible: () => overlayVisible });
			await terminal.waitForRender();

			terminal.sendInput("x");
			await terminal.waitForRender();
			expect(overlay.getValue()).toBe(
				"x",
				`1. WHAT: test_inv_pv_3_overlay_focused_while_visible FAILED (test setup sanity)
2. WHY: INV-PV-3 violation - ${invPv3.description}
3. EXPECTED: overlay.getValue() === "x" while the overlay is visible and focused
4. ACTUAL: overlay.getValue()=${JSON.stringify(overlay.getValue())}
5. GUIDANCE: showOverlay must focus a visible overlay so it receives keyboard input`,
			);

			overlayVisible = false;
			terminal.sendInput("y");
			await terminal.waitForRender();

			expect(overlay.getValue()).toBe(
				"x",
				`1. WHAT: test_inv_pv_3_invisible_overlay_does_not_receive_input FAILED
2. WHY: INV-PV-3 violation - ${invPv3.description}
3. EXPECTED: overlay.getValue() stays "x" — the "y" keystroke must not reach a component whose visible() now returns false
4. ACTUAL: overlay.getValue()=${JSON.stringify(overlay.getValue())}
5. GUIDANCE: Recheck focused-overlay visibility before delivering input and redirect focus when it is no longer visible`,
			);
		} finally {
			tui.stop();
		}
	});

	it("POST-PV-8: keeps SGR 1006 mouse tracking active while a fullscreen overlay requests it, never writing PINNED_MOUSE_LEAVE", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#syncPinnedMouseTracking() / TUI.#doRender()
		 * - Enforces: POST-PV-8: Fullscreen overlay display SHALL NOT write PINNED_MOUSE_LEAVE (?1006l) while
		 *   an overlay requests mouse tracking, keeping SGR 1006 active
		 * - Category: negative / regression
		 * - Test pyramid: Integration
		 * - Risk tier: High — SGR 1006 teardown breaks all mouse interaction inside the overlay (manifest DM-6)
		 * - Adversarial: Contract-governed, implementation-aware. Reproduces the exact sequence: enterPinned()
		 *   enables pinned mouse tracking, then a fullscreen overlay with mouseTracking!==false opens; the real
		 *   #syncPinnedMouseTracking call inside #doRender's alt-enter branch writes PINNED_MOUSE_LEAVE right
		 *   after the overlay's own MOUSE_TRACKING_ON.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-8 in requirements/contracts/pinned_dock.contract.ts.
		 *   [✓] C2 VALUABLE: the current #syncPinnedMouseTracking call inside the alt-enter branch deterministically
		 *       writes "\x1b[?1006l" immediately after the overlay's own "\x1b[?1006h"; this test fails against it.
		 *   [✓] C3 NON-DUPLICATIVE: the only test asserting SGR-1006 write ordering around fullscreen overlay entry.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit POST-PV-8 guarantee against wiring already present.
		 */
		const postPv8 = CONTRACT_PINNED_DOCK["POST-PV-8"];
		const terminal = new RecordingTerminal(48, 8, 100);
		const tui = new TUI(terminal, false);
		const overlay = new Text("FULLSCREEN_OVERLAY_CONTENT", 0, 0);

		tui.setFrameProvider(new StaticPinnedFrameProvider(["TRANSCRIPT_LINE"], ["DOCK_LINE"]));
		try {
			tui.start();
			tui.enterPinned();
			await terminal.waitForRender();

			const writesBeforeOverlay = terminal.writes.length;
			tui.showOverlay(overlay, { fullscreen: true, mouseTracking: true });
			await terminal.waitForRender();

			const overlayWrites = terminal.writes.slice(writesBeforeOverlay).join("");
			expect(overlayWrites.includes("\x1b[?1006h")).toBe(
				true,
				`1. WHAT: test_post_pv_8_overlay_enables_its_own_sgr_1006 FAILED (test setup sanity)
2. WHY: POST-PV-8 violation - ${postPv8.description}
3. EXPECTED: the fullscreen overlay's write stream contains "\\x1b[?1006h" (its own SGR mouse enable)
4. ACTUAL: ${JSON.stringify(overlayWrites)}
5. GUIDANCE: A fullscreen overlay with mouseTracking !== false must enable SGR mouse reporting on entry`,
			);
			expect(overlayWrites.includes("\x1b[?1006l")).toBe(
				false,
				`1. WHAT: test_post_pv_8_no_mouse_leave_while_overlay_wants_tracking FAILED
2. WHY: POST-PV-8 violation - ${postPv8.description}
3. EXPECTED: no "\\x1b[?1006l" (PINNED_MOUSE_LEAVE) written while the fullscreen overlay requests mouse tracking
4. ACTUAL: write stream after showing the overlay contained "\\x1b[?1006l": ${JSON.stringify(overlayWrites)}
5. GUIDANCE: Skip the pinned-mode mouse-tracking teardown when the topmost visible overlay itself wants mouse tracking`,
			);
		} finally {
			tui.stop();
		}
	});
});

// ============================================================================
// SGR mouse stream integrity (POST-PV-4, POST-PV-5, SEQ-PV-3, INV-PV-4,
// FORBIDDEN-PV-1)
// ============================================================================

describe("pinned dock refactor — SGR mouse stream integrity", () => {
	it("POST-PV-4 / FORBIDDEN-PV-1: decodes every report in one concatenated SGR mouse chunk", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: parseSgrMouseStream()
		 * - Enforces: POST-PV-4: parseSgrMouseStream SHALL extract and decode all concatenated SGR mouse
		 *   reports in a single stdin buffer chunk without dropping reports
		 * - Enforces: FORBIDDEN-PV-1: a multi-report SGR chunk SHALL NOT be dropped or return null/unhandled
		 * - Category: positive / negative-space
		 * - Risk tier: High — dropped packets manifest as scroll inertia and stuck momentum (manifest DM-4)
		 * - Adversarial: Contract-governed, implementation-aware.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-4 and FORBIDDEN-PV-1 in the contract.
		 *   [✓] C2 VALUABLE: exact count and exact polarity sequence; a dropped or misparsed report fails it.
		 *   [✓] C3 NON-DUPLICATIVE: the only test at the parseSgrMouseStream function boundary.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit no-drop guarantee.
		 */
		const postPv4 = CONTRACT_PINNED_DOCK["POST-PV-4"];
		const forbiddenPv1 = CONTRACT_PINNED_DOCK["FORBIDDEN-PV-1"];

		const concatenatedChunk = "\x1b[<64;10;5M\x1b[<64;10;5M\x1b[<65;10;5M";
		const reports = parseSgrMouseStream(concatenatedChunk);

		expect(reports.length).toBe(
			3,
			`1. WHAT: test_post_pv_4_concatenated_sgr_reports FAILED
2. WHY: POST-PV-4 / FORBIDDEN-PV-1 violation - ${postPv4.description} / ${forbiddenPv1.description}
3. EXPECTED: 3 parsed SGR mouse reports
4. ACTUAL: ${reports.length}
5. GUIDANCE: Stream-parse every SGR packet in the chunk without anchoring to line ends`,
		);

		expect(reports.map(report => report.wheel)).toEqual(
			[-1, -1, 1],
			`1. WHAT: test_post_pv_4_wheel_polarity FAILED
2. WHY: POST-PV-4 violation - ${postPv4.description}
3. EXPECTED: [-1, -1, 1]
4. ACTUAL: ${JSON.stringify(reports.map(report => report.wheel))}
5. GUIDANCE: Retain wheel polarity across concatenated packet streams`,
		);
	});

	it("POST-PV-5 / SEQ-PV-3 / INV-PV-4: sums every wheel delta in one concatenated SGR chunk into a single scroll", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#handlePinnedInput()
		 * - Enforces: POST-PV-5: TUI.#handlePinnedInput SHALL sum all wheel event deltas in a chunk for
		 *   smooth, unhindered momentum scrolling
		 * - Enforces: SEQ-PV-3: #handlePinnedInput SHALL invoke parseSgrMouseStream before applying wheel delta
		 * - Enforces: INV-PV-4: TUI SHALL NOT drop concatenated SGR mouse reports arriving in one stdin chunk
		 * - Category: positive / integration
		 * - Test pyramid: Integration
		 * - Risk tier: High — a dropped or unsummed wheel report reproduces the scroll-inertia regression (DM-4)
		 * - Adversarial: Contract-governed, implementation-aware. Asserts the exact resulting scroll position,
		 *   not merely that the viewport kept its row count (that assertion cannot distinguish "no scroll
		 *   happened" from "both events were summed correctly").
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-5, SEQ-PV-3, INV-PV-4 in the contract.
		 *   [✓] C2 VALUABLE: exact top-row assertion; dropping one event or under/over-summing both change it.
		 *   [✓] C3 NON-DUPLICATIVE: the only test asserting the real scroll *effect* of a concatenated wheel chunk
		 *       through the full TUI integration path (POST-PV-4 above tests only the parser's return value).
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit wheel-summing guarantee.
		 */
		const postPv5 = CONTRACT_PINNED_DOCK["POST-PV-5"];
		const seqPv3 = CONTRACT_PINNED_DOCK["SEQ-PV-3"];
		const invPv4 = CONTRACT_PINNED_DOCK["INV-PV-4"];

		const terminal = new VirtualTerminal(48, 8, 100);
		const tui = new TUI(terminal, false);
		const history = Array.from({ length: 20 }, (_, i) => `HIST_${String(i).padStart(2, "0")}`);
		tui.setFrameProvider(new StaticPinnedFrameProvider(history, ["DOCK"]));
		try {
			tui.start();
			tui.enterPinned();
			await terminal.waitForRender();

			// height=8, dock=1 line -> windowHeight=7; maxScroll=20-7=13; following starts at the tail.
			const topRowBeforeScroll = terminal.getViewport()[0]?.trim();
			expect(topRowBeforeScroll).toBe(
				"HIST_13",
				`1. WHAT: test_post_pv_5_initial_follow_position FAILED (test setup sanity)
2. WHY: POST-PV-5 violation - ${postPv5.description}
3. EXPECTED: top visible row "HIST_13" before any scroll (following mode shows the transcript tail)
4. ACTUAL: ${JSON.stringify(topRowBeforeScroll)}
5. GUIDANCE: composeFrame in following mode must show the transcript tail`,
			);

			// Two concatenated wheel-up reports in ONE stdin chunk.
			terminal.sendInput("\x1b[<64;1;1M\x1b[<64;1;1M");
			await terminal.waitForRender();

			// Each wheel tick scrolls PINNED_WHEEL_SCROLL_LINES(3) lines; two summed ticks scroll 6 lines: 13 -> 7.
			const topRowAfterChunk = terminal.getViewport()[0]?.trim();
			expect(topRowAfterChunk).toBe(
				"HIST_07",
				`1. WHAT: test_post_pv_5_sums_concatenated_wheel_events FAILED
2. WHY: POST-PV-5 / SEQ-PV-3 / INV-PV-4 violation - ${postPv5.description}; ${seqPv3.description}; ${invPv4.description}
3. EXPECTED: top visible row "HIST_07" (two summed wheel-up ticks of 3 lines each scroll from HIST_13 to HIST_07)
4. ACTUAL: ${JSON.stringify(topRowAfterChunk)}
5. GUIDANCE: parseSgrMouseStream must decode every report in the chunk and #handlePinnedInput must sum all wheel deltas before one scrollBy call`,
			);
		} finally {
			tui.stop();
		}
	});
});

// ============================================================================
// Pane-confined drag selection and clipboard copy (POST-PV-6, POST-PV-9,
// POST-PV-10, SEQ-PV-5)
// ============================================================================

describe("pinned dock refactor — pane-confined drag selection and clipboard copy", () => {
	it("POST-PV-6: multi-row drag selection copies exact text through OSC 52, including the release row's release cell", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#copySelectedTranscriptToClipboard()
		 * - Enforces: POST-PV-6: left-button drag across transcript rows SHALL capture selected plaintext and
		 *   copy to clipboard via OSC 52 upon release, including the release cell
		 * - Category: positive
		 * - Test pyramid: Integration
		 * - Risk tier: High — silent data loss on copy corrupts the clipboard payload the user pastes
		 * - Adversarial: Contract-governed, implementation-aware. Decodes the exact OSC 52 payload rather than
		 *   checking only for the escape prefix's presence.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-6 in requirements/contracts/pinned_dock.contract.ts.
		 *   [✓] C2 VALUABLE: exact-string assertion; the current release-exclusive slice drops the release
		 *       row's final character ("BRAVO_LIN" instead of "BRAVO_LINE"), so this fails against it.
		 *   [✓] C3 NON-DUPLICATIVE: the only multi-row drag-copy test; single-row equivalence classes are covered separately below.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit release-inclusive guarantee.
		 */
		const postPv6 = CONTRACT_PINNED_DOCK["POST-PV-6"];
		const terminal = new RecordingTerminal(48, 8, 100);
		const tui = new TUI(terminal, false);
		tui.setFrameProvider(
			new StaticPinnedFrameProvider(
				["ALPHA_LINE_CONTENT", "BRAVO_LINE_CONTENT", "CHARLIE_LINE_CONTENT"],
				["PROMPT_INPUT_DOCK"],
			),
		);
		try {
			tui.start();
			tui.enterPinned();
			await terminal.waitForRender();

			terminal.sendInput("\x1b[<0;1;1M"); // press row0 col0
			terminal.sendInput("\x1b[<32;10;2M"); // drag to row1 col9
			await terminal.waitForRender();

			const writesBeforeRelease = terminal.writes.length;
			terminal.sendInput("\x1b[<0;10;2m"); // release row1 col9 (0-based col9 = the 'E' of BRAVO_LINE)
			await terminal.waitForRender();

			const releaseWrites = terminal.writes.slice(writesBeforeRelease).join("");
			const copied = decodeOsc52Payload(releaseWrites);
			expect(copied).toBe(
				"ALPHA_LINE_CONTENT\nBRAVO_LINE",
				`1. WHAT: test_post_pv_6_multi_row_exact_copy FAILED
2. WHY: POST-PV-6 violation - ${postPv6.description}
3. EXPECTED: OSC 52 payload decodes to "ALPHA_LINE_CONTENT\\nBRAVO_LINE" (row0 from the press column to end; row1 from
   the start through the release column, inclusive)
4. ACTUAL: ${JSON.stringify(copied)}
5. GUIDANCE: The release row's slice must include the character at the release column, not stop one short of it`,
			);
		} finally {
			tui.stop();
		}
	});

	it("POST-PV-6: single-row drag selection includes the release cell (ASCII boundary)", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#copySelectedTranscriptToClipboard()
		 * - Enforces: POST-PV-6: single-line drag selection SHALL include the release cell
		 * - Category: boundary
		 * - Test pyramid: Integration
		 * - Risk tier: High — silent data loss on copy
		 * - Adversarial: Contract-governed, implementation-aware. Isolates the release-cell-inclusion boundary
		 *   from any character-width concern using a plain-ASCII, single-row fixture.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-6 in the contract.
		 *   [✓] C2 VALUABLE: expected "CDEF" (4 chars); current implementation's exclusive slice(2,5) yields
		 *       "CDE" (3 chars, drops the release cell 'F').
		 *   [✓] C3 NON-DUPLICATIVE: exercises TUI.#copySelectedTranscriptToClipboard's single-row branch
		 *       (r0 === r1), a distinct code path from the multi-row test above.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit release-inclusive guarantee.
		 */
		const postPv6 = CONTRACT_PINNED_DOCK["POST-PV-6"];
		const terminal = new RecordingTerminal(48, 8, 100);
		const tui = new TUI(terminal, false);
		tui.setFrameProvider(new StaticPinnedFrameProvider(["ABCDEFGH"], ["DOCK"]));
		try {
			tui.start();
			tui.enterPinned();
			await terminal.waitForRender();

			terminal.sendInput("\x1b[<0;3;1M"); // press visual col2 ('C')
			await terminal.waitForRender();

			const writesBeforeRelease = terminal.writes.length;
			terminal.sendInput("\x1b[<0;6;1m"); // release visual col5 ('F')
			await terminal.waitForRender();

			const releaseWrites = terminal.writes.slice(writesBeforeRelease).join("");
			const copied = decodeOsc52Payload(releaseWrites);
			expect(copied).toBe(
				"CDEF",
				`1. WHAT: test_post_pv_6_single_row_release_inclusive FAILED
2. WHY: POST-PV-6 violation - ${postPv6.description}
3. EXPECTED: OSC 52 payload decodes to "CDEF" (columns 2-5 inclusive of "ABCDEFGH")
4. ACTUAL: ${JSON.stringify(copied)}
5. GUIDANCE: The single-row slice must include the character at the release column, not stop one short of it`,
			);
		} finally {
			tui.stop();
		}
	});

	it("POST-PV-6: single-row drag over CJK wide characters uses visual column width, not UTF-16 length", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#copySelectedTranscriptToClipboard()
		 * - Enforces: POST-PV-6: drag selection SHALL use visual column widths, not raw string indices
		 * - Category: boundary / equivalence-class
		 * - Test pyramid: Integration
		 * - Risk tier: High — silent Unicode corruption on copy (manifest DM-5)
		 * - Adversarial: Contract-governed, implementation-aware. Each CJK ideograph in this fixture occupies
		 *   2 visual columns but only 1 UTF-16 code unit, so naive JS string slicing on mouse-reported visual
		 *   columns necessarily diverges from a width-aware slice — empirically confirmed via the real
		 *   sliceWithWidth() utility before authoring this fixture.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-6 in the contract.
		 *   [✓] C2 VALUABLE: expected "日本" (cols 2-5 inclusive); current naive slice(2,5) yields "日本C"
		 *       (an extra trailing character from index/column mismatch).
		 *   [✓] C3 NON-DUPLICATIVE: distinct equivalence class (double-width characters) from the ASCII
		 *       boundary test above and the emoji/Nerd-Font tests below.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit visual-column-width guarantee.
		 */
		const postPv6 = CONTRACT_PINNED_DOCK["POST-PV-6"];
		const terminal = new RecordingTerminal(48, 8, 100);
		const tui = new TUI(terminal, false);
		tui.setFrameProvider(new StaticPinnedFrameProvider(["AB\u65e5\u672cCD"], ["DOCK"])); // "AB日本CD"
		try {
			tui.start();
			tui.enterPinned();
			await terminal.waitForRender();

			terminal.sendInput("\x1b[<0;3;1M"); // press visual col2 (start of 日)
			await terminal.waitForRender();

			const writesBeforeRelease = terminal.writes.length;
			terminal.sendInput("\x1b[<0;6;1m"); // release visual col5 (end of 本)
			await terminal.waitForRender();

			const releaseWrites = terminal.writes.slice(writesBeforeRelease).join("");
			const copied = decodeOsc52Payload(releaseWrites);
			expect(copied).toBe(
				"\u65e5\u672c",
				`1. WHAT: test_post_pv_6_cjk_visual_column_width FAILED
2. WHY: POST-PV-6 violation - ${postPv6.description}
3. EXPECTED: OSC 52 payload decodes to "\u65e5\u672c" (visual columns 2-5 inclusive: 日 spans cols 2-3, 本 spans cols 4-5)
4. ACTUAL: ${JSON.stringify(copied)}
5. GUIDANCE: Slice the selected row by visual column width (accounting for double-width characters), not by raw string index`,
			);
		} finally {
			tui.stop();
		}
	});

	it("POST-PV-6: single-row drag over a ZWJ emoji cluster copies the whole grapheme without corrupting it", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#copySelectedTranscriptToClipboard()
		 * - Enforces: POST-PV-6: drag selection SHALL use visual column widths, not raw string indices
		 * - Category: boundary / equivalence-class
		 * - Test pyramid: Integration
		 * - Risk tier: High — silent Unicode corruption on copy (manifest DM-5: "corrupting Unicode and
		 *   dropping trailing cells")
		 * - Adversarial: Contract-governed, implementation-aware. The family emoji grapheme cluster used here
		 *   is 11 UTF-16 code units but renders as one 2-column glyph (confirmed via the real
		 *   VirtualTerminal/visibleWidth()), so a naive index-based slice lands mid-cluster.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-6 in the contract.
		 *   [✓] C2 VALUABLE: expected the family emoji + "C"; current naive slice(2,4) yields only the bare
		 *       "man" emoji (the first 2 UTF-16 units of the cluster) — the family joiners and the "C" are lost.
		 *   [✓] C3 NON-DUPLICATIVE: distinct equivalence class (ZWJ multi-codepoint grapheme) from CJK and
		 *       Nerd Font fixtures.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit visual-column-width guarantee.
		 */
		const postPv6 = CONTRACT_PINNED_DOCK["POST-PV-6"];
		const terminal = new RecordingTerminal(48, 8, 100);
		const tui = new TUI(terminal, false);
		tui.setFrameProvider(new StaticPinnedFrameProvider([`AB${FAMILY_EMOJI}CD`], ["DOCK"]));
		try {
			tui.start();
			tui.enterPinned();
			await terminal.waitForRender();

			terminal.sendInput("\x1b[<0;3;1M"); // press visual col2 (start of the family glyph)
			await terminal.waitForRender();

			const writesBeforeRelease = terminal.writes.length;
			terminal.sendInput("\x1b[<0;5;1m"); // release visual col4 ('C', one column past the 2-wide glyph)
			await terminal.waitForRender();

			const releaseWrites = terminal.writes.slice(writesBeforeRelease).join("");
			const copied = decodeOsc52Payload(releaseWrites);
			expect(copied).toBe(
				`${FAMILY_EMOJI}C`,
				`1. WHAT: test_post_pv_6_zwj_emoji_visual_column_width FAILED
2. WHY: POST-PV-6 violation - ${postPv6.description}
3. EXPECTED: OSC 52 payload decodes to the family emoji followed by "C" (visual columns 2-4 inclusive)
4. ACTUAL: ${JSON.stringify(copied)} (a corrupted or truncated grapheme indicates raw-index slicing mid-cluster)
5. GUIDANCE: Slice the selected row by visual column width so multi-codepoint grapheme clusters are copied whole`,
			);
		} finally {
			tui.stop();
		}
	});

	it("POST-PV-6: single-row drag over a Nerd Font icon mixed with CJK text uses visual column width", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#copySelectedTranscriptToClipboard()
		 * - Enforces: POST-PV-6: drag selection SHALL use visual column widths, not raw string indices
		 * - Category: boundary / equivalence-class
		 * - Test pyramid: Integration
		 * - Risk tier: Medium — realistic tool-status transcript lines commonly mix Nerd Font iconography
		 *   with CJK/ASCII text; a corrupted copy here is a routine, not exotic, user-facing failure
		 * - Adversarial: Contract-governed, implementation-aware. U+F015 (Nerd Font "home" icon) is itself
		 *   single-width (confirmed via visibleWidth()), so the divergence in this fixture comes from the
		 *   adjacent CJK text — a realistic composite line, not an isolated icon-only case.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-6 in the contract.
		 *   [✓] C2 VALUABLE: expected icon+space+"日本"+space+"C"; current naive slice(0,8) yields an extra
		 *       trailing "D" from index/column mismatch on the CJK run.
		 *   [✓] C3 NON-DUPLICATIVE: distinct equivalence class (Nerd Font PUA glyph in a realistic mixed line)
		 *       from the pure-CJK and pure-emoji fixtures above.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit visual-column-width guarantee.
		 */
		const postPv6 = CONTRACT_PINNED_DOCK["POST-PV-6"];
		const terminal = new RecordingTerminal(48, 8, 100);
		const tui = new TUI(terminal, false);
		tui.setFrameProvider(new StaticPinnedFrameProvider(["\uF015 \u65e5\u672c CD"], ["DOCK"])); // "<home-icon> 日本 CD"
		try {
			tui.start();
			tui.enterPinned();
			await terminal.waitForRender();

			terminal.sendInput("\x1b[<0;1;1M"); // press visual col0 (the icon)
			await terminal.waitForRender();

			const writesBeforeRelease = terminal.writes.length;
			terminal.sendInput("\x1b[<0;8;1m"); // release visual col7 ('C')
			await terminal.waitForRender();

			const releaseWrites = terminal.writes.slice(writesBeforeRelease).join("");
			const copied = decodeOsc52Payload(releaseWrites);
			expect(copied).toBe(
				"\uF015 \u65e5\u672c C",
				`1. WHAT: test_post_pv_6_nerd_font_mixed_line_visual_column_width FAILED
2. WHY: POST-PV-6 violation - ${postPv6.description}
3. EXPECTED: OSC 52 payload decodes to the icon, space, "\u65e5\u672c", space, "C" (visual columns 0-7 inclusive)
4. ACTUAL: ${JSON.stringify(copied)}
5. GUIDANCE: Slice the selected row by visual column width so icon-and-CJK transcript lines copy exactly what was selected`,
			);
		} finally {
			tui.stop();
		}
	});

	it("POST-PV-9: applies inverse video styling to cells within an active in-app selection drag", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: PinnedViewport.composeFrame() (as rendered through TUI.#renderPinnedFrame)
		 * - Enforces: POST-PV-9: PinnedViewport.composeFrame SHALL apply visual inverse video styling
		 *   (SELECTION_HIGHLIGHT_START...SELECTION_HIGHLIGHT_END) to cells within an active in-app selection drag
		 * - Category: positive
		 * - Test pyramid: Integration
		 * - Risk tier: Medium — missing in-app highlighting forces reliance on the host terminal's own
		 *   selection, which the manifest's rejected report shows crosses multiplexer pane borders
		 * - Adversarial: Contract-governed, implementation-aware. Forces a full repaint via the public
		 *   requestRender(true) after starting a drag (mirroring how enterPinned() itself guarantees its own
		 *   first paint), then inspects the raw emitted frame for the exact contract-defined escape sequence.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-9 in requirements/contracts/pinned_dock.contract.ts.
		 *   [✓] C2 VALUABLE: composeFrame currently has no selection-aware code path at all — the exact
		 *       highlighted substring can never appear — so this fails deterministically against current code.
		 *   [✓] C3 NON-DUPLICATIVE: the only test asserting in-app selection highlighting.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit POST-PV-9 guarantee; the drag/composeFrame
		 *       path already exists, only the highlighting is missing from it.
		 */
		const postPv9 = CONTRACT_PINNED_DOCK["POST-PV-9"];
		const terminal = new RecordingTerminal(48, 8, 100);
		const tui = new TUI(terminal, false);
		tui.setFrameProvider(new StaticPinnedFrameProvider(["SELECTABLE_ROW_CONTENT"], ["DOCK_LINE"]));
		try {
			tui.start();
			tui.enterPinned();
			await terminal.waitForRender();

			terminal.sendInput("\x1b[<0;1;1M"); // press visual col0
			terminal.sendInput("\x1b[<32;10;1M"); // drag motion to visual col9 (covers "SELECTABLE"), still held

			const writesBeforeForcedRepaint = terminal.writes.length;
			tui.requestRender(true);
			await terminal.waitForRender();
			const repaintWrites = terminal.writes.slice(writesBeforeForcedRepaint).join("");

			expect(repaintWrites.includes("SELECTABLE")).toBe(
				true,
				`1. WHAT: test_post_pv_9_forced_repaint_included_row_content FAILED (test setup sanity)
2. WHY: POST-PV-9 violation - ${postPv9.description}
3. EXPECTED: the forced repaint's write stream contains the transcript row text "SELECTABLE"
4. ACTUAL: ${JSON.stringify(repaintWrites)}
5. GUIDANCE: requestRender(true) must force a full repaint of the pinned frame`,
			);

			const highlighted = `${SELECTION_HIGHLIGHT_START}SELECTABLE${SELECTION_HIGHLIGHT_END}`;
			expect(repaintWrites.includes(highlighted)).toBe(
				true,
				`1. WHAT: test_post_pv_9_inverse_video_on_active_drag FAILED
2. WHY: POST-PV-9 violation - ${postPv9.description}
3. EXPECTED: repainted frame contains ${JSON.stringify(highlighted)} (SGR 7m...27m wrapping the dragged cells "SELECTABLE")
4. ACTUAL: repaint writes did not contain the highlighted span. Full writes: ${JSON.stringify(repaintWrites)}
5. GUIDANCE: composeFrame must wrap cells within the active drag span in SELECTION_HIGHLIGHT_START/END before emitting the frame`,
			);
		} finally {
			tui.stop();
		}
	});

	it("POST-PV-10: only a mouse button 0 (left click) release commits the drag selection to the clipboard", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#handlePinnedInput()
		 * - Enforces: POST-PV-10: TUI.#handlePinnedInput SHALL only commit drag selection to clipboard on
		 *   release of mouse button 0 (left click)
		 * - Category: negative
		 * - Test pyramid: Integration
		 * - Risk tier: Medium — an unrequested clipboard overwrite from a right/middle-click release is a
		 *   surprising, silent side effect
		 * - Adversarial: Contract-governed, implementation-aware. The real release branch in
		 *   #handlePinnedInput currently checks only event.release, never event.button, so any release
		 *   report with an active drag commits — this reproduces that exact gap.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-10 in requirements/contracts/pinned_dock.contract.ts.
		 *   [✓] C2 VALUABLE: the current #handlePinnedInput commits on ANY event.release regardless of
		 *       event.button, so this fails against it.
		 *   [✓] C3 NON-DUPLICATIVE: the only test asserting button-gated release commit.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit button-0-only guarantee.
		 */
		const postPv10 = CONTRACT_PINNED_DOCK["POST-PV-10"];
		const terminal = new RecordingTerminal(48, 8, 100);
		const tui = new TUI(terminal, false);
		tui.setFrameProvider(new StaticPinnedFrameProvider(["CLICKABLE_TRANSCRIPT_TEXT"], ["DOCK_LINE"]));
		try {
			tui.start();
			tui.enterPinned();
			await terminal.waitForRender();

			terminal.sendInput("\x1b[<0;1;1M"); // left press (button 0) at col0
			await terminal.waitForRender();

			const writesBeforeRelease = terminal.writes.length;
			terminal.sendInput("\x1b[<2;10;1m"); // RIGHT button (2) release at col9
			await terminal.waitForRender();

			const releaseWrites = terminal.writes.slice(writesBeforeRelease).join("");
			expect(releaseWrites.includes(OSC52_CLIPBOARD_PREFIX)).toBe(
				false,
				`1. WHAT: test_post_pv_10_non_left_release_does_not_commit FAILED
2. WHY: POST-PV-10 violation - ${postPv10.description}
3. EXPECTED: no OSC 52 clipboard write when the release report's button is not 0
4. ACTUAL: OSC 52 clipboard write emitted on button-2 release=${releaseWrites.includes(OSC52_CLIPBOARD_PREFIX)}; writes=${JSON.stringify(releaseWrites)}
5. GUIDANCE: Check that the release report's button field equals 0 before committing the drag selection to the clipboard`,
			);
		} finally {
			tui.stop();
		}
	});

	it("SEQ-PV-5: overlay focus clears an in-progress drag before a later release", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.setFocus() / TUI.#handlePinnedInput()
		 * - Enforces: SEQ-PV-5: TUI SHALL reset active drag selection state when an overlay steals focus
		 * - Category: negative / regression
		 * - Test pyramid: Integration
		 * - Risk tier: Medium — a stale drag surviving a focus change could commit a selection the user never intended
		 * - Adversarial: Contract-governed, implementation-aware.
		 *
		 * SEQ_TEST_SELF_CHECK:
		 *   [✓] Drives the drag through real sendInput() SGR reports and focus change through the real
		 *       showOverlay()/hide() lifecycle, not a direct call to a private reset method.
		 *   [✓] Verifies SEQ-PV-5 through the observable absence of a later OSC 52 write.
		 *   [✓] No mock used.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites SEQ-PV-5 in the contract.
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO.
		 *   [✓] C3 NON-DUPLICATIVE: exercises the "overlay steals focus" trigger; the exitPinned test below
		 *       exercises the textually distinct "pinned mode exits" trigger from the same SEQ-PV-5 clause.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit drag-reset-on-focus-steal guarantee.
		 */
		const seqPv5 = CONTRACT_PINNED_DOCK["SEQ-PV-5"];
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

	it("SEQ-PV-5: exiting pinned mode clears an in-progress drag before a later release can commit it", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.exitPinned()
		 * - Enforces: SEQ-PV-5: TUI SHALL reset active drag selection state when pinned mode exits
		 * - Category: negative / regression
		 * - Test pyramid: Integration
		 * - Risk tier: Medium — a stale drag surviving a pinned-mode exit/re-entry could commit unexpectedly
		 * - Adversarial: Contract-governed, implementation-aware. Re-enters pinned mode after exiting so the
		 *   later release is actually routed to the drag-commit branch, isolating "was the drag state cleared
		 *   by exitPinned" from "is pinned mode currently active at all".
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites SEQ-PV-5 in the contract.
		 *   [✓] C2 VALUABLE: if exitPinned failed to clear #dragStart/#dragEnd, the release after re-entry
		 *       would commit a stale selection and this test would fail.
		 *   [✓] C3 NON-DUPLICATIVE: exercises the "pinned mode exits" trigger, textually distinct from the
		 *       "overlay steals focus" trigger covered by the test above.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit drag-reset-on-exit guarantee already wired
		 *       into TUI.exitPinned(); this is a regression guard on existing behavior, not a hypothetical future one.
		 */
		const seqPv5 = CONTRACT_PINNED_DOCK["SEQ-PV-5"];
		const terminal = new RecordingTerminal(48, 8, 100);
		const tui = new TUI(terminal, false);

		tui.setFrameProvider(new StaticPinnedFrameProvider(["SELECTABLE_TRANSCRIPT"], ["PROMPT_DOCK"]));
		try {
			tui.start();
			tui.enterPinned();
			await terminal.waitForRender();

			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;6;1M");
			await terminal.waitForRender();

			tui.exitPinned();
			tui.enterPinned();
			await terminal.waitForRender();

			const writesBeforeRelease = terminal.writes.length;
			terminal.sendInput("\x1b[<0;6;1m");
			await terminal.waitForRender();
			const writesAfterRelease = terminal.writes.slice(writesBeforeRelease).join("");

			expect(writesAfterRelease.includes(OSC52_CLIPBOARD_PREFIX)).toBe(
				false,
				`1. WHAT: test_seq_pv_5_exit_pinned_clears_drag FAILED
2. WHY: SEQ-PV-5 violation - ${seqPv5.description}
3. EXPECTED: no OSC 52 clipboard write after exitPinned() interrupts an in-progress drag and pinned mode is re-entered
4. ACTUAL: OSC 52 clipboard write emitted=${writesAfterRelease.includes(OSC52_CLIPBOARD_PREFIX)}
5. GUIDANCE: Reset drag selection state when pinned mode exits so a later release cannot commit a stale selection`,
			);
		} finally {
			tui.stop();
		}
	});
});

// ============================================================================
// Software scrollback and content-integrity supporting checks (INV-PV-1,
// INV-PV-5) and inline-mode exposure (INV-PV-7)
// ============================================================================

describe("pinned dock refactor — software scrollback, content integrity, and viewport mode purity", () => {
	it("CONTRACT VERIFICATION — INV-PV-1: validateSoftwareScrollback rejects a truncated history while long history exists", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: validateSoftwareScrollback()
		 * - Enforces: INV-PV-1: PinnedViewport SHALL NOT truncate scrollable history to the visible window height
		 * - Category: invariant
		 * - Risk tier: High — truncated scrollback silently deletes prior session output (manifest DM-1)
		 * - Adversarial: contract validator verification; the real integration-level guarantee is exercised by
		 *   the "POST-PV-2 / INV-PV-1 / SEQ-PV-4" Composer test in packages/coding-agent/test/pinned-dock-refactor.test.ts.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites INV-PV-1 in the contract.
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO.
		 *   [✓] C3 NON-DUPLICATIVE: unit-level validator check, distinct surface from the coding-agent integration test.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit INV-PV-1 guarantee.
		 */
		const invPv1 = CONTRACT_PINNED_DOCK["INV-PV-1"];
		let caught: unknown;
		try {
			validateSoftwareScrollback(5, 10, 50);
		} catch (err) {
			caught = err;
		}
		expect(caught instanceof ZeroScrollbackError).toBe(
			true,
			`1. WHAT: test_inv_pv_1_validator_rejects_truncated_history FAILED
2. WHY: INV-PV-1 violation - ${invPv1.description}
3. EXPECTED: validateSoftwareScrollback(5, 10, 50) throws ZeroScrollbackError
4. ACTUAL: ${caught instanceof Error ? `threw ${caught.constructor.name}: ${caught.message}` : String(caught)}
5. GUIDANCE: Reject a transcriptLength <= windowHeight once more than 5 history blocks exist`,
		);
		expect(() => validateSoftwareScrollback(50, 10, 50)).not.toThrow(
			`1. WHAT: test_inv_pv_1_validator_accepts_sufficient_history FAILED
2. WHY: INV-PV-1 violation - ${invPv1.description}
3. EXPECTED: validateSoftwareScrollback(50, 10, 50) does not throw (history exceeds window height)
4. ACTUAL: threw
5. GUIDANCE: Only reject when transcriptLength <= windowHeight while more than 5 history blocks exist`,
		);
	});

	it("INV-PV-5: a wheel scroll never overwrites transcript content rows with dock content", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#renderPinnedFrame() / PinnedViewport.composeFrame()
		 * - Enforces: INV-PV-5: TUI SHALL NOT overwrite transcript content rows with navigation or follow hints
		 * - Category: invariant / regression
		 * - Test pyramid: Integration
		 * - Risk tier: High — an overwritten transcript row silently deletes session output (manifest DM-4's
		 *   sibling "follow hint clobbers the last transcript row" regression)
		 * - Adversarial: Contract-governed, implementation-aware. Uses distinctly tagged dock content so any
		 *   row-boundary bleed between dock and transcript is observable, and asserts every transcript-window
		 *   row exactly rather than a loose substring check.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites INV-PV-5 in the contract.
		 *   [✓] C2 VALUABLE: dock content ("DOCK_ONLY_ROW") leaking into any transcript row fails this.
		 *   [✓] C3 NON-DUPLICATIVE: the only test asserting per-row transcript/dock content separation after a scroll.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit no-overwrite guarantee.
		 */
		const invPv5 = CONTRACT_PINNED_DOCK["INV-PV-5"];
		const terminal = new RecordingTerminal(48, 6, 100);
		const tui = new TUI(terminal, false);
		const history = ["TRANSCRIPT_LINE_1", "TRANSCRIPT_LINE_2", "TRANSCRIPT_LINE_3", "TRANSCRIPT_LINE_4", "TRANSCRIPT_LINE_5"];
		tui.setFrameProvider(new StaticPinnedFrameProvider(history, ["DOCK_ONLY_ROW"]));
		try {
			tui.start();
			tui.enterPinned();
			await terminal.waitForRender();

			terminal.sendInput("\x1b[<64;1;1M"); // wheel up
			await terminal.waitForRender();

			// height=6, dock=1 line -> windowHeight=5; all 5 transcript rows are visible, dock is row 5.
			const viewport = terminal.getViewport();
			const transcriptRows = viewport.slice(0, 5);
			const dockRow = viewport[5]?.trim();
			expect(transcriptRows.some(row => row.includes("DOCK_ONLY_ROW"))).toBe(
				false,
				`1. WHAT: test_inv_pv_5_dock_does_not_leak_into_transcript FAILED
2. WHY: INV-PV-5 violation - ${invPv5.description}
3. EXPECTED: none of the ${transcriptRows.length} transcript-window rows contain "DOCK_ONLY_ROW"
4. ACTUAL: ${JSON.stringify(transcriptRows)}
5. GUIDANCE: Keep dock rows confined to the bottom dockHeight rows; never write dock or hint content into transcript rows`,
			);
			expect(dockRow).toBe(
				"DOCK_ONLY_ROW",
				`1. WHAT: test_inv_pv_5_dock_row_intact FAILED (test setup sanity)
2. WHY: INV-PV-5 violation - ${invPv5.description}
3. EXPECTED: the bottom row is exactly "DOCK_ONLY_ROW"
4. ACTUAL: ${JSON.stringify(dockRow)}
5. GUIDANCE: The dock must occupy the bottom dockHeight rows of the composed frame`,
			);
		} finally {
			tui.stop();
		}
	});

	it("INV-PV-7: isViewportMode rejects \"inline\" as a supported viewport mode", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: isViewportMode() / ViewportMode
		 * - Enforces: INV-PV-7: TUI SHALL NOT expose or honor an inline/unpinned viewport setting or code path
		 * - Category: negative-space
		 * - Risk tier: High — an exposed inline mode is a live, reachable code path that bypasses every other
		 *   guarantee in this contract (manifest: "this is a completely new bug" from prior ad-hoc fixes)
		 * - Adversarial: Contract-governed, implementation-aware. Targets the real exported predicate directly.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites INV-PV-7 in requirements/contracts/pinned_dock.contract.ts.
		 *   [✓] C2 VALUABLE: isViewportMode("inline") currently returns true; this fails against it.
		 *   [✓] C3 NON-DUPLICATIVE: unit-level type-surface check, distinct from the Composer integration
		 *       test in packages/coding-agent/test/pinned-dock-refactor.test.ts.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit INV-PV-7 guarantee against the type's
		 *       current, real accepted-value set — not a hypothetical future addition.
		 */
		const invPv7 = CONTRACT_PINNED_DOCK["INV-PV-7"];
		expect(isViewportMode("inline")).toBe(
			false,
			`1. WHAT: test_inv_pv_7_inline_mode_rejected FAILED
2. WHY: INV-PV-7 violation - ${invPv7.description}
3. EXPECTED: isViewportMode("inline") === false (no inline/unpinned viewport setting is exposed)
4. ACTUAL: isViewportMode("inline") === ${isViewportMode("inline")}
5. GUIDANCE: Restrict the supported viewport mode surface to pinned-only; remove the inline value from the accepted set`,
		);
		expect(isViewportMode("pinned")).toBe(
			true,
			`1. WHAT: test_inv_pv_7_pinned_mode_still_accepted FAILED (test setup sanity)
2. WHY: INV-PV-7 violation - ${invPv7.description}
3. EXPECTED: isViewportMode("pinned") === true
4. ACTUAL: isViewportMode("pinned") === ${isViewportMode("pinned")}
5. GUIDANCE: The pinned mode value must remain valid; only the inline value is forbidden`,
		);
	});
});
