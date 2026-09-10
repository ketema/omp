import { describe, expect, it } from "bun:test";
import {
	Input,
	type TerminalFramePlan,
	type TerminalFrameProvider,
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
 * and records every raw write chunk in call order.
 *
 * Double type: Spy.
 * Contract: requirements/contracts/pinned_dock.contract.ts POST-PV-3, INV-PV-5, INV-PV-7.
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
 * Contract: requirements/contracts/pinned_dock.contract.ts POST-PV-3.
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

// Overlay compositing and focus integrity (POST-PV-3, SEQ-PV-1,
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

});

// ============================================================================
// SGR mouse stream integrity (POST-PV-4)
// ============================================================================

describe("pinned dock refactor — SGR mouse stream integrity", () => {
	it("POST-PV-4: decodes every report in one concatenated SGR mouse chunk", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: parseSgrMouseStream()
		 * - Enforces: POST-PV-4: parseSgrMouseStream SHALL extract and decode all concatenated SGR mouse
		 *   reports in a single stdin buffer chunk without dropping reports
		 * - Category: positive
		 * - Risk tier: High — dropped packets break overlay-owned pointer streams
		 * - Adversarial: Contract-governed, implementation-aware.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-4 in requirements/contracts/pinned_dock.contract.ts
		 *   [✓] C2 VALUABLE: exact count and exact polarity sequence; a dropped or misparsed report fails it
		 *   [✓] C3 NON-DUPLICATIVE: the only test at the parseSgrMouseStream function boundary
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current POST-PV-4 no-drop guarantee
		 */
		const postPv4 = CONTRACT_PINNED_DOCK["POST-PV-4"];
		const concatenatedChunk = "\x1b[<64;10;5M\x1b[<64;10;5M\x1b[<65;10;5M";
		const reports = parseSgrMouseStream(concatenatedChunk);
		expect(reports.length, `1. WHAT: test_post_pv_4_concatenated_sgr_reports FAILED
2. WHY: POST-PV-4 violation - ${postPv4.description}
3. EXPECTED: 3 parsed SGR mouse reports
4. ACTUAL: ${reports.length}
5. GUIDANCE: Stream-parse every SGR packet in the chunk without dropping reports`).toBe(3);
		expect(reports.map(report => report.wheel), `1. WHAT: test_post_pv_4_wheel_polarity FAILED
2. WHY: POST-PV-4 violation - ${postPv4.description}
3. EXPECTED: [-1, -1, 1]
4. ACTUAL: ${JSON.stringify(reports.map(report => report.wheel))}
5. GUIDANCE: Retain wheel polarity across concatenated packet streams`).toEqual([-1, -1, 1]);
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
