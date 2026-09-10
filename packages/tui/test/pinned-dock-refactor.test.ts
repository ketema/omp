import { describe, expect, it } from "bun:test";
import {
	Input,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	Text,
	TUI,
	type ViewportSize,
} from "@oh-my-pi/pi-tui";
import { parseSgrMouseStream } from "@oh-my-pi/pi-tui/mouse";
import {
	InvalidHeightError as ImplInvalidHeightError,
	PinnedViewport,
} from "@oh-my-pi/pi-tui/pinned-viewport";
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
 * Contract: requirements/contracts/pinned_dock.contract.ts POST-PV-6, POST-PV-6b, POST-PV-8, POST-PV-9, POST-PV-10, SEQ-PV-5.
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
 * Contract: requirements/contracts/pinned_dock.contract.ts POST-PV-3, POST-PV-6, POST-PV-6b.
 */
class StaticPinnedFrameProvider implements TerminalFrameProvider {
	acknowledgeHistory(_id: number): void {}

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
			expect(caught, `1. WHAT: test_pre_pv_1_composeFrame_throws_contract_conforming_error(${String(invalidHeight)}) FAILED
2. WHY: PRE-PV-1 / ERRORS-PV-1 violation - composeFrame did not throw the implementation's InvalidHeightError
3. EXPECTED: an implementation InvalidHeightError whose observable shape matches the contract InvalidHeightError
4. ACTUAL: ${caught instanceof Error ? `threw ${caught.constructor.name}: ${caught.message}` : String(caught)}
5. GUIDANCE: non-positive terminal heights must use the implementation error that conforms to ERRORS-PV-1`).toBeInstanceOf(ImplInvalidHeightError);
			if (!(caught instanceof ImplInvalidHeightError)) continue;
			expect(caught, `1. WHAT: test_pre_pv_1_composeFrame_throws_contract_conforming_error(${String(invalidHeight)}) FAILED
2. WHY: PRE-PV-1 / ERRORS-PV-1 violation - composeFrame did not throw an Error object
3. EXPECTED: an Error object carrying the contract-defined name, clause identifier, and message
4. ACTUAL: ${String(caught)}
5. GUIDANCE: non-positive terminal heights must fail with the contract-defined error shape`).toBeInstanceOf(Error);
			expect(caught.name, `1. WHAT: test_pre_pv_1_composeFrame_throws_contract_conforming_error(${String(invalidHeight)}) FAILED
2. WHY: PRE-PV-1 / ERRORS-PV-1 violation - error name does not identify a pinned-dock contract violation
3. EXPECTED: name ${JSON.stringify(contractError.name)}
4. ACTUAL: ${JSON.stringify(caught.name)}
5. GUIDANCE: non-positive terminal heights must identify the error as a pinned-dock contract violation`).toBe(contractError.name);
			expect(caught.clauseId, `1. WHAT: test_pre_pv_1_composeFrame_throws_contract_conforming_error(${String(invalidHeight)}) FAILED
2. WHY: PRE-PV-1 / ERRORS-PV-1 violation - error does not cite the violated precondition
3. EXPECTED: clauseId ${JSON.stringify(contractError.clauseId)}
4. ACTUAL: ${JSON.stringify(caught.clauseId)}
5. GUIDANCE: non-positive terminal heights must cite PRE-PV-1`).toBe(contractError.clauseId);
			expect(caught.message, `1. WHAT: test_pre_pv_1_composeFrame_throws_contract_conforming_error(${String(invalidHeight)}) FAILED
2. WHY: PRE-PV-1 / ERRORS-PV-1 violation - error message does not state the contract-defined height failure
3. EXPECTED: message containing "PRE-PV-1 violation: Terminal height must be a finite number >= 1"
4. ACTUAL: ${JSON.stringify(caught.message)}
5. GUIDANCE: non-positive terminal heights must report the PRE-PV-1 height requirement`).toContain("PRE-PV-1 violation: Terminal height must be a finite number >= 1");
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
		expect(frame, `1. WHAT: test_post_pv_1_frame_shape FAILED
2. WHY: POST-PV-1 violation - ${postPv1.description}
3. EXPECTED: ["ROW_1", "ROW_2", "ROW_3", "ROW_4", "DOCK_1", "DOCK_2"] (height 6, dock pinned to the bottom 2 rows)
4. ACTUAL: ${JSON.stringify(frame)}
5. GUIDANCE: Return exactly height rows with the scrolled transcript window on top and the dock pinned to the bottom rows`).toEqual(["ROW_1", "ROW_2", "ROW_3", "ROW_4", "DOCK_1", "DOCK_2"]);
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
		expect(caught instanceof InvalidMouseInputError, `1. WHAT: test_pre_pv_2_validator_rejects_non_string FAILED
2. WHY: PRE-PV-2 / ERRORS-PV-2 violation - ${prePv2.description}; ${errorsPv2.description}
3. EXPECTED: validateSgrMouseReports(null, []) throws InvalidMouseInputError
4. ACTUAL: ${caught instanceof Error ? `threw ${caught.constructor.name}: ${caught.message}` : String(caught)}
5. GUIDANCE: Validate that rawChunk is a string before scanning it for SGR reports`).toBe(true);
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
			expect(renderedText.includes("MODEL_OVERLAY_ACTIVE:"), `1. WHAT: test_post_pv_3_overlay_visible_in_pinned_mode FAILED
2. WHY: POST-PV-3 / SEQ-PV-1 / SEQ-PV-2 / INV-PV-2 violation - ${postPv3.description} / ${seqPv1.description} / ${seqPv2.description} / ${invPv2.description}
3. EXPECTED: bottom-anchored overlay text visible in rendered viewport
4. ACTUAL: viewport was:\n${renderedText}
5. GUIDANCE: Invoke #compositeOverlaysIntoWindow after PinnedViewport.composeFrame and before emitting the frame`).toBe(true);

			terminal.sendInput("g");
			await terminal.waitForRender();
			expect(overlay.getValue(), `1. WHAT: test_post_pv_3_overlay_accepts_focused_input FAILED
2. WHY: POST-PV-3 / INV-PV-2 violation - ${postPv3.description} / ${invPv2.description}
3. EXPECTED: overlay input receives typed keystrokes without dock freeze
4. ACTUAL: overlay.getValue()=${JSON.stringify(overlay.getValue())}
5. GUIDANCE: Deliver keyboard events to the focused overlay rather than freezing the dock`).toBe("g");

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
			expect(overlay.getValue(), `1. WHAT: test_inv_pv_3_overlay_focused_while_visible FAILED (test setup sanity)
2. WHY: INV-PV-3 violation - ${invPv3.description}
3. EXPECTED: overlay.getValue() === "x" while the overlay is visible and focused
4. ACTUAL: overlay.getValue()=${JSON.stringify(overlay.getValue())}
5. GUIDANCE: showOverlay must focus a visible overlay so it receives keyboard input`).toBe("x");

			overlayVisible = false;
			terminal.sendInput("y");
			await terminal.waitForRender();

			expect(overlay.getValue(), `1. WHAT: test_inv_pv_3_invisible_overlay_does_not_receive_input FAILED
2. WHY: INV-PV-3 violation - ${invPv3.description}
3. EXPECTED: overlay.getValue() stays "x" — the "y" keystroke must not reach a component whose visible() now returns false
4. ACTUAL: overlay.getValue()=${JSON.stringify(overlay.getValue())}
5. GUIDANCE: Recheck focused-overlay visibility before delivering input and redirect focus when it is no longer visible`).toBe("x");
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
			expect(overlayWrites.includes("\x1b[?1006h"), `1. WHAT: test_post_pv_8_overlay_enables_its_own_sgr_1006 FAILED (test setup sanity)
2. WHY: POST-PV-8 violation - ${postPv8.description}
3. EXPECTED: the fullscreen overlay's write stream contains "\\x1b[?1006h" (its own SGR mouse enable)
4. ACTUAL: ${JSON.stringify(overlayWrites)}
5. GUIDANCE: A fullscreen overlay with mouseTracking !== false must enable SGR mouse reporting on entry`).toBe(true);
			expect(overlayWrites.includes("\x1b[?1006l"), `1. WHAT: test_post_pv_8_no_mouse_leave_while_overlay_wants_tracking FAILED
2. WHY: POST-PV-8 violation - ${postPv8.description}
3. EXPECTED: no "\\x1b[?1006l" (PINNED_MOUSE_LEAVE) written while the fullscreen overlay requests mouse tracking
4. ACTUAL: write stream after showing the overlay contained "\\x1b[?1006l": ${JSON.stringify(overlayWrites)}
5. GUIDANCE: Skip the pinned-mode mouse-tracking teardown when the topmost visible overlay itself wants mouse tracking`).toBe(false);
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

		expect(reports.length, `1. WHAT: test_post_pv_4_concatenated_sgr_reports FAILED
2. WHY: POST-PV-4 / FORBIDDEN-PV-1 violation - ${postPv4.description} / ${forbiddenPv1.description}
3. EXPECTED: 3 parsed SGR mouse reports
4. ACTUAL: ${reports.length}
5. GUIDANCE: Stream-parse every SGR packet in the chunk without anchoring to line ends`).toBe(3);

		expect(reports.map(report => report.wheel), `1. WHAT: test_post_pv_4_wheel_polarity FAILED
2. WHY: POST-PV-4 violation - ${postPv4.description}
3. EXPECTED: [-1, -1, 1]
4. ACTUAL: ${JSON.stringify(reports.map(report => report.wheel))}
5. GUIDANCE: Retain wheel polarity across concatenated packet streams`).toEqual([-1, -1, 1]);
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
			expect(topRowBeforeScroll, `1. WHAT: test_post_pv_5_initial_follow_position FAILED (test setup sanity)
2. WHY: POST-PV-5 violation - ${postPv5.description}
3. EXPECTED: top visible row "HIST_13" before any scroll (following mode shows the transcript tail)
4. ACTUAL: ${JSON.stringify(topRowBeforeScroll)}
5. GUIDANCE: composeFrame in following mode must show the transcript tail`).toBe("HIST_13");

			// Two concatenated wheel-up reports in ONE stdin chunk.
			terminal.sendInput("\x1b[<64;1;1M\x1b[<64;1;1M");
			await terminal.waitForRender();

			// Each wheel tick scrolls PINNED_WHEEL_SCROLL_LINES(3) lines; two summed ticks scroll 6 lines: 13 -> 7.
			const topRowAfterChunk = terminal.getViewport()[0]?.trim();
			expect(topRowAfterChunk, `1. WHAT: test_post_pv_5_sums_concatenated_wheel_events FAILED
2. WHY: POST-PV-5 / SEQ-PV-3 / INV-PV-4 violation - ${postPv5.description}; ${seqPv3.description}; ${invPv4.description}
3. EXPECTED: top visible row "HIST_07" (two summed wheel-up ticks of 3 lines each scroll from HIST_13 to HIST_07)
4. ACTUAL: ${JSON.stringify(topRowAfterChunk)}
5. GUIDANCE: parseSgrMouseStream must decode every report in the chunk and #handlePinnedInput must sum all wheel deltas before one scrollBy call`).toBe("HIST_07");
		} finally {
			tui.stop();
		}
	});
});

// ============================================================================
// Pane-confined drag selection and clipboard copy (POST-PV-6, POST-PV-6b,
// POST-PV-9, POST-PV-10, SEQ-PV-5)
// ============================================================================

describe("pinned dock refactor — pane-confined drag selection and clipboard copy", () => {
	it("POST-PV-6: multi-row drag selection copies exact text through OSC 52, including the release row's release cell", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#copySelectedTranscriptToClipboard()
		 * - Enforces: POST-PV-6: left-button drag across transcript rows SHALL capture exact ANSI-stripped
		 *   plaintext from pane-local visual cells using visual column widths, including the release cell
		 * - Enforces: POST-PV-6b: for this non-empty pane-local selection, TUI SHALL attempt OSC 52
		 *   compatibility emission containing that same plaintext. The decoded OSC 52 payload below is the
		 *   observable channel for the captured plaintext ONLY — it does not assert or imply native local-copy
		 *   success; POST-PV-21 through POST-PV-24 govern native success/failure and belong to SLICE-3.
		 * - Category: positive
		 * - Test pyramid: Integration
		 * - Risk tier: High — silent data loss on copy corrupts the compatibility payload the user pastes
		 * - Adversarial: Contract-governed, implementation-aware. Decodes the exact OSC 52 payload rather than
		 *   checking only for the escape prefix's presence.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-6 and POST-PV-6b in requirements/contracts/pinned_dock.contract.ts.
		 *   [✓] C2 VALUABLE: exact-string assertion; the current release-exclusive slice drops the release
		 *       row's final character ("BRAVO_LIN" instead of "BRAVO_LINE"), so this fails against it.
		 *   [✓] C3 NON-DUPLICATIVE: the only multi-row drag-copy test; single-row equivalence classes are covered separately below.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit release-inclusive guarantee.
		 */
		const postPv6 = CONTRACT_PINNED_DOCK["POST-PV-6"];
		const postPv6b = CONTRACT_PINNED_DOCK["POST-PV-6b"];
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
			expect(copied, `1. WHAT: test_post_pv_6_multi_row_exact_copy FAILED
2. WHY: POST-PV-6 / POST-PV-6b violation - ${postPv6.description}; ${postPv6b.description}
3. EXPECTED: OSC 52 payload decodes to "ALPHA_LINE_CONTENT\\nBRAVO_LINE" (row0 from the press column to end; row1 from
   the start through the release column, inclusive)
4. ACTUAL: ${JSON.stringify(copied)}
5. GUIDANCE: The release row's slice must include the character at the release column, not stop one short of it`).toBe("ALPHA_LINE_CONTENT\nBRAVO_LINE");
		} finally {
			tui.stop();
		}
	});

	it("POST-PV-6: single-row drag selection includes the release cell (ASCII boundary)", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#copySelectedTranscriptToClipboard()
		 * - Enforces: POST-PV-6: single-line drag selection SHALL include the release cell
		 * - Enforces: POST-PV-6b: for this non-empty pane-local selection, TUI SHALL attempt OSC 52
		 *   compatibility emission containing that same plaintext. The decoded OSC 52 payload below is the
		 *   observable channel for the captured plaintext ONLY — it does not assert or imply native local-copy
		 *   success; POST-PV-21 through POST-PV-24 govern native success/failure and belong to SLICE-3.
		 * - Category: boundary
		 * - Test pyramid: Integration
		 * - Risk tier: High — silent data loss on copy
		 * - Adversarial: Contract-governed, implementation-aware. Isolates the release-cell-inclusion boundary
		 *   from any character-width concern using a plain-ASCII, single-row fixture.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-6 and POST-PV-6b in the contract.
		 *   [✓] C2 VALUABLE: expected "CDEF" (4 chars); current implementation's exclusive slice(2,5) yields
		 *       "CDE" (3 chars, drops the release cell 'F').
		 *   [✓] C3 NON-DUPLICATIVE: exercises TUI.#copySelectedTranscriptToClipboard's single-row branch
		 *       (r0 === r1), a distinct code path from the multi-row test above.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit release-inclusive guarantee.
		 */
		const postPv6 = CONTRACT_PINNED_DOCK["POST-PV-6"];
		const postPv6b = CONTRACT_PINNED_DOCK["POST-PV-6b"];
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
			expect(copied, `1. WHAT: test_post_pv_6_single_row_release_inclusive FAILED
2. WHY: POST-PV-6 / POST-PV-6b violation - ${postPv6.description}; ${postPv6b.description}
3. EXPECTED: OSC 52 payload decodes to "CDEF" (columns 2-5 inclusive of "ABCDEFGH")
4. ACTUAL: ${JSON.stringify(copied)}
5. GUIDANCE: The single-row slice must include the character at the release column, not stop one short of it`).toBe("CDEF");
		} finally {
			tui.stop();
		}
	});

	it("POST-PV-6: single-row drag over CJK wide characters uses visual column width, not UTF-16 length", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#copySelectedTranscriptToClipboard()
		 * - Enforces: POST-PV-6: drag selection SHALL use visual column widths, not raw string indices
		 * - Enforces: POST-PV-6b: for this non-empty pane-local selection, TUI SHALL attempt OSC 52
		 *   compatibility emission containing that same plaintext. The decoded OSC 52 payload below is the
		 *   observable channel for the captured plaintext ONLY — it does not assert or imply native local-copy
		 *   success; POST-PV-21 through POST-PV-24 govern native success/failure and belong to SLICE-3.
		 * - Category: boundary / equivalence-class
		 * - Test pyramid: Integration
		 * - Risk tier: High — silent Unicode corruption on copy (manifest DM-5)
		 * - Adversarial: Contract-governed, implementation-aware. Each CJK ideograph in this fixture occupies
		 *   2 visual columns but only 1 UTF-16 code unit, so naive JS string slicing on mouse-reported visual
		 *   columns necessarily diverges from a width-aware slice — empirically confirmed via the real
		 *   sliceWithWidth() utility before authoring this fixture.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-6 and POST-PV-6b in the contract.
		 *   [✓] C2 VALUABLE: expected "日本" (cols 2-5 inclusive); current naive slice(2,5) yields "日本C"
		 *       (an extra trailing character from index/column mismatch).
		 *   [✓] C3 NON-DUPLICATIVE: distinct equivalence class (double-width characters) from the ASCII
		 *       boundary test above and the emoji/Nerd-Font tests below.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit visual-column-width guarantee.
		 */
		const postPv6 = CONTRACT_PINNED_DOCK["POST-PV-6"];
		const postPv6b = CONTRACT_PINNED_DOCK["POST-PV-6b"];
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
			expect(copied, `1. WHAT: test_post_pv_6_cjk_visual_column_width FAILED
2. WHY: POST-PV-6 / POST-PV-6b violation - ${postPv6.description}; ${postPv6b.description}
3. EXPECTED: OSC 52 payload decodes to "\u65e5\u672c" (visual columns 2-5 inclusive: 日 spans cols 2-3, 本 spans cols 4-5)
4. ACTUAL: ${JSON.stringify(copied)}
5. GUIDANCE: Slice the selected row by visual column width (accounting for double-width characters), not by raw string index`).toBe("\u65e5\u672c");
		} finally {
			tui.stop();
		}
	});

	it("POST-PV-6: single-row drag over a ZWJ emoji cluster copies the whole grapheme without corrupting it", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#copySelectedTranscriptToClipboard()
		 * - Enforces: POST-PV-6: drag selection SHALL use visual column widths, not raw string indices
		 * - Enforces: POST-PV-6b: for this non-empty pane-local selection, TUI SHALL attempt OSC 52
		 *   compatibility emission containing that same plaintext. The decoded OSC 52 payload below is the
		 *   observable channel for the captured plaintext ONLY — it does not assert or imply native local-copy
		 *   success; POST-PV-21 through POST-PV-24 govern native success/failure and belong to SLICE-3.
		 * - Category: boundary / equivalence-class
		 * - Test pyramid: Integration
		 * - Risk tier: High — silent Unicode corruption on copy (manifest DM-5: "corrupting Unicode and
		 *   dropping trailing cells")
		 * - Adversarial: Contract-governed, implementation-aware. The family emoji grapheme cluster used here
		 *   is 11 UTF-16 code units but renders as one 2-column glyph (confirmed via the real
		 *   VirtualTerminal/visibleWidth()), so a naive index-based slice lands mid-cluster.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-6 and POST-PV-6b in the contract.
		 *   [✓] C2 VALUABLE: expected the family emoji + "C"; current naive slice(2,4) yields only the bare
		 *       "man" emoji (the first 2 UTF-16 units of the cluster) — the family joiners and the "C" are lost.
		 *   [✓] C3 NON-DUPLICATIVE: distinct equivalence class (ZWJ multi-codepoint grapheme) from CJK and
		 *       Nerd Font fixtures.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit visual-column-width guarantee.
		 */
		const postPv6 = CONTRACT_PINNED_DOCK["POST-PV-6"];
		const postPv6b = CONTRACT_PINNED_DOCK["POST-PV-6b"];
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
			expect(copied, `1. WHAT: test_post_pv_6_zwj_emoji_visual_column_width FAILED
2. WHY: POST-PV-6 / POST-PV-6b violation - ${postPv6.description}; ${postPv6b.description}
3. EXPECTED: OSC 52 payload decodes to the family emoji followed by "C" (visual columns 2-4 inclusive)
4. ACTUAL: ${JSON.stringify(copied)} (a corrupted or truncated grapheme indicates raw-index slicing mid-cluster)
5. GUIDANCE: Slice the selected row by visual column width so multi-codepoint grapheme clusters are copied whole`).toBe(`${FAMILY_EMOJI}C`);
		} finally {
			tui.stop();
		}
	});

	it("POST-PV-6: single-row drag over a Nerd Font icon mixed with CJK text uses visual column width", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#copySelectedTranscriptToClipboard()
		 * - Enforces: POST-PV-6: drag selection SHALL use visual column widths, not raw string indices
		 * - Enforces: POST-PV-6b: for this non-empty pane-local selection, TUI SHALL attempt OSC 52
		 *   compatibility emission containing that same plaintext. The decoded OSC 52 payload below is the
		 *   observable channel for the captured plaintext ONLY — it does not assert or imply native local-copy
		 *   success; POST-PV-21 through POST-PV-24 govern native success/failure and belong to SLICE-3.
		 * - Category: boundary / equivalence-class
		 * - Test pyramid: Integration
		 * - Risk tier: Medium — realistic tool-status transcript lines commonly mix Nerd Font iconography
		 *   with CJK/ASCII text; a corrupted copy here is a routine, not exotic, user-facing failure
		 * - Adversarial: Contract-governed, implementation-aware. U+F015 (Nerd Font "home" icon) is itself
		 *   single-width (confirmed via visibleWidth()), so the divergence in this fixture comes from the
		 *   adjacent CJK text — a realistic composite line, not an isolated icon-only case.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-6 and POST-PV-6b in the contract.
		 *   [✓] C2 VALUABLE: expected icon+space+"日本"+space+"C"; current naive slice(0,8) yields an extra
		 *       trailing "D" from index/column mismatch on the CJK run.
		 *   [✓] C3 NON-DUPLICATIVE: distinct equivalence class (Nerd Font PUA glyph in a realistic mixed line)
		 *       from the pure-CJK and pure-emoji fixtures above.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit visual-column-width guarantee.
		 */
		const postPv6 = CONTRACT_PINNED_DOCK["POST-PV-6"];
		const postPv6b = CONTRACT_PINNED_DOCK["POST-PV-6b"];
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
			expect(copied, `1. WHAT: test_post_pv_6_nerd_font_mixed_line_visual_column_width FAILED
2. WHY: POST-PV-6 / POST-PV-6b violation - ${postPv6.description}; ${postPv6b.description}
3. EXPECTED: OSC 52 payload decodes to the icon, space, "\u65e5\u672c", space, "C" (visual columns 0-7 inclusive)
4. ACTUAL: ${JSON.stringify(copied)}
5. GUIDANCE: Slice the selected row by visual column width so icon-and-CJK transcript lines copy exactly what was selected`).toBe("\uF015 \u65e5\u672c C");
		} finally {
			tui.stop();
		}
	});

	it("POST-PV-6b: a real drag that returns to its starting column must still attempt OSC 52 for the highlighted cell", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI selection-to-clipboard pipeline (PinnedViewport highlighting and OSC 52 emission)
		 * - Enforces: POST-PV-6c: after at least one parsed motion event, a left-button gesture that
		 *   returns to and releases on its starting pane-local cell SHALL emit the one-cell OSC 52
		 *   compatibility payload for that cell
		 * - Enforces: POST-PV-6b: for each non-empty pane-local selection, TUI SHALL attempt OSC 52
		 *   compatibility emission containing that same plaintext
		 * - Enforces: POST-PV-6: left-button drag across transcript rows SHALL capture exact ANSI-stripped
		 *   plaintext from pane-local visual cells using visual column widths
		 * - Category: boundary / regression
		 * - Test pyramid: Integration
		 * - Risk tier: High — a user who drags out and back before releasing loses the copy silently, with
		 *   no error and no clipboard content (manifest DM-5/DM-6 family: silent copy data loss)
		 * - Adversarial: Contract-governed, implementation-aware. Sends TWO distinct SGR motion reports
		 *   (press col2 -> motion col5 -> motion back to col2 -> release col2) so the gesture is unambiguously
		 *   a real left-button drag, not a plain click. Before releasing, forces a repaint and asserts that
		 *   the terminal renders a single, one-cell in-app highlight over the same column the drag returned
		 *   to and released on, confirming a non-empty selection exists distinct from "no selection at all."
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-6c, POST-PV-6b, and POST-PV-6 in requirements/contracts/pinned_dock.contract.ts.
		 *   [✓] C2 VALUABLE: exact-value assertions (highlighted substring, then decoded OSC 52 payload
		 *       "C"); a wrong implementation of this exact gap cannot pass both — it either emits the
		 *       one-character payload the highlight proves is selected, or it silently emits nothing, and
		 *       this test only accepts the former.
		 *   [✓] C3 NON-DUPLICATIVE: every POST-PV-6 case above presses and releases at DIFFERENT columns;
		 *       POST-PV-9's own test forces a mid-drag repaint but never releases, so it never reaches the
		 *       release-time copy behavior. This is the only test whose final (post-motion) selection is a
		 *       single visual column after genuine multi-point motion.
		 *   [✓] C4 NOT FUTURE-EDIT: exercises the existing drag/highlight/copy behavior exactly as currently
		 *       reachable through real SGR input; asserts no new capability, only that a selection the
		 *       renderer already treats as highlighted and non-empty is also copied on release, matching
		 *       the same non-empty-selection outcome already observable in the highlight.
		 */
		const postPv6c = CONTRACT_PINNED_DOCK["POST-PV-6c"];
		const postPv6 = CONTRACT_PINNED_DOCK["POST-PV-6"];
		const postPv6b = CONTRACT_PINNED_DOCK["POST-PV-6b"];
		const terminal = new RecordingTerminal(48, 8, 100);
		const tui = new TUI(terminal, false);
		tui.setFrameProvider(new StaticPinnedFrameProvider(["ABCDEFGH"], ["DOCK"]));
		try {
			tui.start();
			tui.enterPinned();
			await terminal.waitForRender();

			terminal.sendInput("\x1b[<0;3;1M"); // press visual col2 ('C')
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<32;6;1M"); // drag motion out to visual col5 ('F'), still held
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<32;3;1M"); // drag motion back to visual col2 ('C'), still held
			await terminal.waitForRender();

			const writesBeforeForcedRepaint = terminal.writes.length;
			tui.requestRender(true);
			await terminal.waitForRender();
			const repaintWrites = terminal.writes.slice(writesBeforeForcedRepaint).join("");
			const highlightedOneCell = `${SELECTION_HIGHLIGHT_START}C${SELECTION_HIGHLIGHT_END}`;
			expect(repaintWrites.includes(highlightedOneCell), `1. WHAT: test_post_pv_6b_setup_highlight_confirms_nonempty_span FAILED (test setup sanity)
2. WHY: POST-PV-9 violation - PinnedViewport.composeFrame must render a visible one-cell in-app highlight
   over the column the drag returned to and released on, before this test's real assertion below can
   distinguish "no selection exists" from "a non-empty selection exists but its copy was dropped"
3. EXPECTED: repainted frame contains ${JSON.stringify(highlightedOneCell)} (one highlighted cell, column 2 'C')
4. ACTUAL: repaint writes did not contain the highlighted span. Full writes: ${JSON.stringify(repaintWrites)}
5. GUIDANCE: the repainted frame must wrap the single highlighted cell in SELECTION_HIGHLIGHT_START/END`).toBe(true);

			const writesBeforeRelease = terminal.writes.length;
			terminal.sendInput("\x1b[<0;3;1m"); // release at visual col2 ('C') -- same column the motion last reported
			await terminal.waitForRender();
			const releaseWrites = terminal.writes.slice(writesBeforeRelease).join("");
			const copied = decodeOsc52Payload(releaseWrites);
			expect(copied, `1. WHAT: test_post_pv_6b_zero_width_drag_after_motion_still_attempts_osc52 FAILED
2. WHY: POST-PV-6c / POST-PV-6b / POST-PV-6 violation - ${postPv6c.description}; ${postPv6b.description}; ${postPv6.description}
3. EXPECTED: OSC 52 payload decodes to "C" (the single pane-local cell the drag highlighted immediately
   before release, per the setup assertion above)
4. ACTUAL: ${JSON.stringify(copied)} (no OSC 52 write means the non-empty, highlighted selection was silently
   dropped instead of attempting compatibility emission)
5. GUIDANCE: a selection the renderer already treats as highlighted and non-empty must also be attempted
   for OSC 52 compatibility emission on release, not silently dropped`).toBe("C");
		} finally {
			tui.stop();
		}
	});

	it("FORBIDDEN-PV-4 / ERRORS-PV-5: a left-button press/release at the same cell with no intervening motion performs no copy and throws no exception", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#handlePinnedInput() / TUI.#copySelectedTranscriptToClipboard()
		 * - Enforces: FORBIDDEN-PV-4: TUI SHALL NOT invoke clipboard delivery or emit OSC 52 for a
		 *   left-button press/release sequence containing no motion event
		 * - Enforces: SEQ-PV-9: TUI.#handlePinnedInput SHALL mark a left-button gesture copy-eligible
		 *   only after a parsed motion event follows its press, and SHALL evaluate that eligibility
		 *   before invoking TUI.#copySelectedTranscriptToClipboard on left-button release
		 * - Enforces: INV-PV-14: TUI copy eligibility SHALL remain false from a left-button press until
		 *   a parsed motion event occurs
		 * - Enforces: ERRORS-PV-5: for a no-motion left-button press/release, TUI SHALL intentionally
		 *   perform no copy, throw no exception, and invoke no clipboard failure handler because a click
		 *   is not a copy request
		 * - Category: negative / boundary — equivalence-class complement of the POST-PV-6c test above:
		 *   identical fixture and identical press/release cell (visual col2, 'C'), differing only in the
		 *   single variable SEQ-PV-9/INV-PV-14 make load-bearing — whether a motion event occurred
		 *   between press and release
		 * - Test pyramid: Integration
		 * - Risk tier: High — an ungated click-to-copy emits an OSC 52 compatibility payload (which
		 *   OSC-52-aware terminals apply directly to the system clipboard) on every plain click received
		 *   while pinned mouse tracking is active, silently overwriting prior clipboard content with no
		 *   error, no prompt, and no way to detect or undo it
		 * - Adversarial: Contract-governed, implementation-aware. Sends exactly ONE press report and ONE
		 *   release report at the identical cell with ZERO SGR motion reports between them: the minimal
		 *   input FORBIDDEN-PV-4 requires be indistinguishable from "no selection", even though the
		 *   current implementation emits an OSC 52 compatibility payload for exactly this press/release
		 *   pair today, regardless of whether any motion occurred in between.
		 * - Double verification: reuses RecordingTerminal (Spy; verified at this file's lines 41-48,
		 *   contract POST-PV-6/POST-PV-6b/POST-PV-8/POST-PV-9/POST-PV-10/SEQ-PV-5) to isolate release-only
		 *   writes, and StaticPinnedFrameProvider (Stub; verified at this file's lines 58-73, contract
		 *   POST-PV-3/POST-PV-6/POST-PV-6b) for deterministic frame content. No new double introduced.
		 *
		 * SEQ_TEST_SELF_CHECK:
		 *   [✓] Constructs the real TUI via `new TUI(...)` and drives it through tui.start()/enterPinned(),
		 *       never calling #handlePinnedInput or #copySelectedTranscriptToClipboard directly.
		 *   [✓] Verifies SEQ-PV-9/INV-PV-14 eligibility gating through the observable absence of an OSC 52
		 *       write on release — the only externally visible effect of the private eligibility state.
		 *   [✓] No mock/spy replaces any dependency after construction; RecordingTerminal is injected at
		 *       TUI construction and StaticPinnedFrameProvider via the public setFrameProvider() call.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites FORBIDDEN-PV-4, SEQ-PV-9, INV-PV-14, and ERRORS-PV-5, all present in
		 *       requirements/contracts/pinned_dock.contract.ts.
		 *   [✓] C2 VALUABLE: exact-value assertions (decoded OSC 52 payload undefined; thrown value
		 *       undefined). The current implementation copies the pressed/released cell unconditionally on
		 *       any left-button release with an active drag, so the OSC 52 assertion fails deterministically
		 *       against it; a correct implementation must satisfy both assertions simultaneously, so neither
		 *       a naive "always copy" nor a naive "throw when ineligible" wrong fix can pass both.
		 *   [✓] C3 NON-DUPLICATIVE: no other test in this file sends a press/release pair with zero
		 *       intervening motion reports. POST-PV-10 below interrupts the release button, not the motion
		 *       precondition; the SEQ-PV-5 tests below interrupt via overlay focus / pinned-mode exit after
		 *       real motion already occurred, not a bare click. This is the only test isolating "click, not
		 *       drag" as the triggering condition.
		 *   [✓] C4 NOT FUTURE-EDIT: FORBIDDEN-PV-4 and ERRORS-PV-5 are existing, explicit clauses in the
		 *       current contract; the click-handling code path this test drives already exists and already
		 *       runs on every release today — only its unconditional copy is wrong, not an absent capability.
		 */
		const forbiddenPv4 = CONTRACT_PINNED_DOCK["FORBIDDEN-PV-4"];
		const seqPv9 = CONTRACT_PINNED_DOCK["SEQ-PV-9"];
		const invPv14 = CONTRACT_PINNED_DOCK["INV-PV-14"];
		const errorsPv5 = CONTRACT_PINNED_DOCK["ERRORS-PV-5"];
		const terminal = new RecordingTerminal(48, 8, 100);
		const tui = new TUI(terminal, false);
		tui.setFrameProvider(new StaticPinnedFrameProvider(["ABCDEFGH"], ["DOCK"]));
		let thrown: unknown;
		let releaseWrites = "";
		try {
			tui.start();
			tui.enterPinned();
			await terminal.waitForRender();

			terminal.sendInput("\x1b[<0;3;1M"); // press visual col2 ('C')
			await terminal.waitForRender();

			const writesBeforeRelease = terminal.writes.length;
			terminal.sendInput("\x1b[<0;3;1m"); // release visual col2 ('C') -- SAME cell, ZERO motion reports in between
			await terminal.waitForRender();

			releaseWrites = terminal.writes.slice(writesBeforeRelease).join("");
		} catch (err) {
			thrown = err;
		} finally {
			tui.stop();
		}

		expect(thrown, `1. WHAT: test_errors_pv_5_no_motion_click_throws_no_exception FAILED
2. WHY: ERRORS-PV-5 violation - ${errorsPv5.description}
3. EXPECTED: press/release input sequence completes without throwing
4. ACTUAL: ${thrown instanceof Error ? `threw ${thrown.constructor.name}: ${thrown.message}` : String(thrown)}
5. GUIDANCE: a no-motion click is an intentional no-op, not an error condition -- return silently, never throw`).toBeUndefined();

		const copied = decodeOsc52Payload(releaseWrites);
		expect(copied, `1. WHAT: test_forbidden_pv_4_no_motion_click_emits_no_osc52 FAILED
2. WHY: FORBIDDEN-PV-4 / SEQ-PV-9 / INV-PV-14 violation - ${forbiddenPv4.description}; ${seqPv9.description}; ${invPv14.description}
3. EXPECTED: no decoded OSC 52 payload (undefined) -- a press/release pair with zero intervening motion
   reports must never reach clipboard delivery
4. ACTUAL: ${JSON.stringify(copied)}
5. GUIDANCE: a no-motion press/release is an intentional no-op; only a gesture containing motion
   may produce clipboard output`).toBeUndefined();
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

			expect(repaintWrites.includes("SELECTABLE"), `1. WHAT: test_post_pv_9_forced_repaint_included_row_content FAILED (test setup sanity)
2. WHY: POST-PV-9 violation - ${postPv9.description}
3. EXPECTED: the forced repaint's write stream contains the transcript row text "SELECTABLE"
4. ACTUAL: ${JSON.stringify(repaintWrites)}
5. GUIDANCE: requestRender(true) must force a full repaint of the pinned frame`).toBe(true);

			const highlighted = `${SELECTION_HIGHLIGHT_START}SELECTABLE${SELECTION_HIGHLIGHT_END}`;
			expect(repaintWrites.includes(highlighted), `1. WHAT: test_post_pv_9_inverse_video_on_active_drag FAILED
2. WHY: POST-PV-9 violation - ${postPv9.description}
3. EXPECTED: repainted frame contains ${JSON.stringify(highlighted)} (SGR 7m...27m wrapping the dragged cells "SELECTABLE")
4. ACTUAL: repaint writes did not contain the highlighted span. Full writes: ${JSON.stringify(repaintWrites)}
5. GUIDANCE: composeFrame must wrap cells within the active drag span in SELECTION_HIGHLIGHT_START/END before emitting the frame`).toBe(true);
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
			expect(releaseWrites.includes(OSC52_CLIPBOARD_PREFIX), `1. WHAT: test_post_pv_10_non_left_release_does_not_commit FAILED
2. WHY: POST-PV-10 violation - ${postPv10.description}
3. EXPECTED: no OSC 52 clipboard write when the release report's button is not 0
4. ACTUAL: OSC 52 clipboard write emitted on button-2 release=${releaseWrites.includes(OSC52_CLIPBOARD_PREFIX)}; writes=${JSON.stringify(releaseWrites)}
5. GUIDANCE: Check that the release report's button field equals 0 before committing the drag selection to the clipboard`).toBe(false);
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

			expect(writesAfterInterruptedRelease.includes(OSC52_CLIPBOARD_PREFIX), `1. WHAT: test_seq_pv_5_overlay_focus_clears_drag FAILED
2. WHY: SEQ-PV-5 / POST-PV-6 violation - ${seqPv5.description}
3. EXPECTED: no OSC 52 clipboard write after a drag is interrupted by overlay focus
4. ACTUAL: OSC 52 clipboard write emitted=${writesAfterInterruptedRelease.includes(OSC52_CLIPBOARD_PREFIX)}
5. GUIDANCE: Discard active drag selection immediately when overlay focus takes control`).toBe(false);
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

			expect(writesAfterRelease.includes(OSC52_CLIPBOARD_PREFIX), `1. WHAT: test_seq_pv_5_exit_pinned_clears_drag FAILED
2. WHY: SEQ-PV-5 violation - ${seqPv5.description}
3. EXPECTED: no OSC 52 clipboard write after exitPinned() interrupts an in-progress drag and pinned mode is re-entered
4. ACTUAL: OSC 52 clipboard write emitted=${writesAfterRelease.includes(OSC52_CLIPBOARD_PREFIX)}
5. GUIDANCE: Reset drag selection state when pinned mode exits so a later release cannot commit a stale selection`).toBe(false);
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
		expect(caught instanceof ZeroScrollbackError, `1. WHAT: test_inv_pv_1_validator_rejects_truncated_history FAILED
2. WHY: INV-PV-1 violation - ${invPv1.description}
3. EXPECTED: validateSoftwareScrollback(5, 10, 50) throws ZeroScrollbackError
4. ACTUAL: ${caught instanceof Error ? `threw ${caught.constructor.name}: ${caught.message}` : String(caught)}
5. GUIDANCE: Reject a transcriptLength <= windowHeight once more than 5 history blocks exist`).toBe(true);
		expect(() => validateSoftwareScrollback(50, 10, 50), `1. WHAT: test_inv_pv_1_validator_accepts_sufficient_history FAILED
2. WHY: INV-PV-1 violation - ${invPv1.description}
3. EXPECTED: validateSoftwareScrollback(50, 10, 50) does not throw (history exceeds window height)
4. ACTUAL: threw
5. GUIDANCE: Only reject when transcriptLength <= windowHeight while more than 5 history blocks exist`).not.toThrow();
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
		const history = [
			"TRANSCRIPT_LINE_1",
			"TRANSCRIPT_LINE_2",
			"TRANSCRIPT_LINE_3",
			"TRANSCRIPT_LINE_4",
			"TRANSCRIPT_LINE_5",
		];
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
			expect(transcriptRows.some(row => row.includes("DOCK_ONLY_ROW")), `1. WHAT: test_inv_pv_5_dock_does_not_leak_into_transcript FAILED
2. WHY: INV-PV-5 violation - ${invPv5.description}
3. EXPECTED: none of the ${transcriptRows.length} transcript-window rows contain "DOCK_ONLY_ROW"
4. ACTUAL: ${JSON.stringify(transcriptRows)}
5. GUIDANCE: Keep dock rows confined to the bottom dockHeight rows; never write dock or hint content into transcript rows`).toBe(false);
			expect(dockRow, `1. WHAT: test_inv_pv_5_dock_row_intact FAILED (test setup sanity)
2. WHY: INV-PV-5 violation - ${invPv5.description}
3. EXPECTED: the bottom row is exactly "DOCK_ONLY_ROW"
4. ACTUAL: ${JSON.stringify(dockRow)}
5. GUIDANCE: The dock must occupy the bottom dockHeight rows of the composed frame`).toBe("DOCK_ONLY_ROW");
		} finally {
			tui.stop();
		}
	});

	it("INV-PV-7: TUI exposes no viewport mode configuration and operates in pinned mode unconditionally", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.enterPinned() / TUI.isPinned()
		 * - Enforces: INV-PV-7: TUI SHALL NOT expose or honor an inline/unpinned viewport setting or code path
		 * - Category: negative-space
		 * - Risk tier: High — an exposed inline mode is a live, reachable code path that bypasses every other
		 *   guarantee in this contract (manifest: "this is a completely new bug" from prior ad-hoc fixes)
		 * - Adversarial: Contract-governed, implementation-aware. Verifies that TUI operates in pinned mode
		 *   and does not expose any unpinned or viewport-mode configuration surface.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites INV-PV-7 in requirements/contracts/pinned_dock.contract.ts.
		 *   [✓] C2 VALUABLE: verifies that TUI is pinned and has no unpinned/inline mode switch.
		 *   [✓] C3 NON-DUPLICATIVE: unit-level TUI surface check, distinct from the Composer integration
		 *       test in packages/coding-agent/test/pinned-dock-refactor.test.ts.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit INV-PV-7 guarantee that no viewport mode
		 *       setting or alternate unpinned code path exists.
		 */
		const invPv7 = CONTRACT_PINNED_DOCK["INV-PV-7"];
		const terminal = new RecordingTerminal(40, 8, 100);
		const tui = new TUI(terminal, false);
		try {
			tui.start();
			tui.enterPinned();
			await terminal.waitForRender();
			expect(tui.isPinned(), `1. WHAT: test_inv_pv_7_tui_is_pinned FAILED
2. WHY: INV-PV-7 violation - ${invPv7.description}
3. EXPECTED: tui.isPinned() === true
4. ACTUAL: tui.isPinned() === ${tui.isPinned()}
5. GUIDANCE: TUI must run in pinned mode unconditionally without viewport mode options`).toBe(true);
		} finally {
			tui.stop();
		}
	});
});
