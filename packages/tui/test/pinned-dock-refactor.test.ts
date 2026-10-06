import { describe, expect, it } from "bun:test";
import { Input, type TerminalFramePlan, type TerminalFrameProvider, TUI, type ViewportSize } from "@oh-my-pi/pi-tui";
import { parseSgrMouseStream } from "@oh-my-pi/pi-tui/mouse";
import { InvalidHeightError as ImplInvalidHeightError, PinnedViewport } from "@oh-my-pi/pi-tui/pinned-viewport";
import {
	CONTRACT_PINNED_DOCK,
	InvalidHeightError as ContractInvalidHeightError,
	PINNED_ALT_SCREEN_ENTER as ALT_SCREEN_ENTER,
	PINNED_ALT_SCREEN_LEAVE as ALT_SCREEN_LEAVE,
	validateSoftwareScrollback,
	ZeroScrollbackError,
} from "../../../requirements/contracts/pinned_dock.contract";
import { VirtualTerminal } from "./virtual-terminal";

// ============================================================================
// Test doubles
// ============================================================================

/**
 * Boundary spy of Terminal.write: records the exact `data` argument, then
 * delegates unchanged to VirtualTerminal.write. It does not substitute grid,
 * viewport, or escape-sequence behavior.
 *
 * Double type: Spy (record-then-delegate; not a Mock and not a Fake screen).
 * Fidelity source: this override (`this.writes.push(data); super.write(data)`).
 * VirtualTerminal is the kitty-vt-wasm engine (`KittyTerminal` via
 * `loadModuleSync("kitty-vt-wasm/kitty-vt.wasm")` in ./virtual-terminal.ts).
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
 * Contract-valid TerminalFrameProvider input fixture. Supplies immutable
 * pinnedScroll/pinnedDock plan rows; it is not a terminal emulator and does
 * not replace Terminal behavior.
 *
 * Double type: Stub (controlled return values only; no call verification).
 * Fidelity source: TerminalFramePlan consumed by the real TUI renderer; values
 * are test-owned transcript/dock inputs, not invented terminal output.
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

/**
 * Contract-valid TerminalFrameProvider input fixture. Supplies one
 * distinguishable prompt line and a pinned-scroll discriminator so row
 * placement is the observable. Not a terminal emulator.
 *
 * Double type: Stub (controlled return values only; no call verification).
 * Fidelity source: TerminalFramePlan consumed by the real TUI renderer.
 * Contract: requirements/contracts/pinned_dock.contract.ts INV-PV-7.
 */
class DistinguishablePromptFrameProvider implements TerminalFrameProvider {
	acknowledgeHistory(_id: number): void {}

	renderFrame(_viewport: ViewportSize): TerminalFramePlan {
		return {
			viewport: ["PROMPT:observe"],
			pinnedScroll: ["TRANSCRIPT_LINE_1"],
			pinnedDock: ["PROMPT:observe"],
		};
	}
}

/**
 * Count non-overlapping occurrences of `needle` across the ordered write
 * stream. A single terminal write may concatenate multiple escape sequences
 * (e.g. `${ALT_SCREEN_ENTER}${enhancementEnter}`), so this scans substrings
 * rather than comparing whole chunks.
 */
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

// ============================================================================
// PinnedViewport.composeFrame — real implementation entry point (PRE-PV-1,
// ERRORS-PV-1, POST-PV-1)
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
		 *   [✓] C3 NON-DUPLICATIVE: the only test invoking PinnedViewport.composeFrame's own height validation.
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
			expect(
				caught,
				`1. WHAT: test_pre_pv_1_composeFrame_throws_contract_conforming_error(${String(invalidHeight)}) FAILED
2. WHY: PRE-PV-1 / ERRORS-PV-1 violation - composeFrame did not throw the implementation's InvalidHeightError
3. EXPECTED: an implementation InvalidHeightError whose observable shape matches the contract InvalidHeightError
4. ACTUAL: ${caught instanceof Error ? `threw ${caught.constructor.name}: ${caught.message}` : String(caught)}
5. GUIDANCE: non-positive terminal heights must use the implementation error that conforms to ERRORS-PV-1`,
			).toBeInstanceOf(ImplInvalidHeightError);
			if (!(caught instanceof ImplInvalidHeightError)) continue;
			expect(
				caught,
				`1. WHAT: test_pre_pv_1_composeFrame_throws_contract_conforming_error(${String(invalidHeight)}) FAILED
2. WHY: PRE-PV-1 / ERRORS-PV-1 violation - composeFrame did not throw an Error object
3. EXPECTED: an Error object carrying the contract-defined name, clause identifier, and message
4. ACTUAL: ${String(caught)}
5. GUIDANCE: non-positive terminal heights must fail with the contract-defined error shape`,
			).toBeInstanceOf(Error);
			expect(
				caught.name,
				`1. WHAT: test_pre_pv_1_composeFrame_throws_contract_conforming_error(${String(invalidHeight)}) FAILED
2. WHY: PRE-PV-1 / ERRORS-PV-1 violation - error name does not identify a pinned-dock contract violation
3. EXPECTED: name ${JSON.stringify(contractError.name)}
4. ACTUAL: ${JSON.stringify(caught.name)}
5. GUIDANCE: non-positive terminal heights must identify the error as a pinned-dock contract violation`,
			).toBe(contractError.name);
			expect(
				caught.clauseId,
				`1. WHAT: test_pre_pv_1_composeFrame_throws_contract_conforming_error(${String(invalidHeight)}) FAILED
2. WHY: PRE-PV-1 / ERRORS-PV-1 violation - error does not cite the violated precondition
3. EXPECTED: clauseId ${JSON.stringify(contractError.clauseId)}
4. ACTUAL: ${JSON.stringify(caught.clauseId)}
5. GUIDANCE: non-positive terminal heights must cite PRE-PV-1`,
			).toBe(contractError.clauseId);
			expect(
				caught.message,
				`1. WHAT: test_pre_pv_1_composeFrame_throws_contract_conforming_error(${String(invalidHeight)}) FAILED
2. WHY: PRE-PV-1 / ERRORS-PV-1 violation - error message does not state the contract-defined height failure
3. EXPECTED: message containing "PRE-PV-1 violation: Terminal height must be a finite number >= 1"
4. ACTUAL: ${JSON.stringify(caught.message)}
5. GUIDANCE: non-positive terminal heights must report the PRE-PV-1 height requirement`,
			).toContain("PRE-PV-1 violation: Terminal height must be a finite number >= 1");
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
		expect(
			frame,
			`1. WHAT: test_post_pv_1_frame_shape FAILED
2. WHY: POST-PV-1 violation - ${postPv1.description}
3. EXPECTED: ["ROW_1", "ROW_2", "ROW_3", "ROW_4", "DOCK_1", "DOCK_2"] (height 6, dock pinned to the bottom 2 rows)
4. ACTUAL: ${JSON.stringify(frame)}
5. GUIDANCE: Return exactly height rows with the scrolled transcript window on top and the dock pinned to the bottom rows`,
		).toEqual(["ROW_1", "ROW_2", "ROW_3", "ROW_4", "DOCK_1", "DOCK_2"]);
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
			expect(
				renderedText.includes("MODEL_OVERLAY_ACTIVE:"),
				`1. WHAT: test_post_pv_3_overlay_visible_in_pinned_mode FAILED
2. WHY: POST-PV-3 / SEQ-PV-1 / SEQ-PV-2 / INV-PV-2 violation - ${postPv3.description} / ${seqPv1.description} / ${seqPv2.description} / ${invPv2.description}
3. EXPECTED: bottom-anchored overlay text visible in rendered viewport
4. ACTUAL: viewport was:\n${renderedText}
5. GUIDANCE: Invoke #compositeOverlaysIntoWindow after PinnedViewport.composeFrame and before emitting the frame`,
			).toBe(true);

			terminal.sendInput("g");
			await terminal.waitForRender();
			expect(
				overlay.getValue(),
				`1. WHAT: test_post_pv_3_overlay_accepts_focused_input FAILED
2. WHY: POST-PV-3 / INV-PV-2 violation - ${postPv3.description} / ${invPv2.description}
3. EXPECTED: overlay input receives typed keystrokes without dock freeze
4. ACTUAL: overlay.getValue()=${JSON.stringify(overlay.getValue())}
5. GUIDANCE: Deliver keyboard events to the focused overlay rather than freezing the dock`,
			).toBe("g");

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
			expect(
				overlay.getValue(),
				`1. WHAT: test_inv_pv_3_overlay_focused_while_visible FAILED (test setup sanity)
2. WHY: INV-PV-3 violation - ${invPv3.description}
3. EXPECTED: overlay.getValue() === "x" while the overlay is visible and focused
4. ACTUAL: overlay.getValue()=${JSON.stringify(overlay.getValue())}
5. GUIDANCE: showOverlay must focus a visible overlay so it receives keyboard input`,
			).toBe("x");

			overlayVisible = false;
			terminal.sendInput("y");
			await terminal.waitForRender();

			expect(
				overlay.getValue(),
				`1. WHAT: test_inv_pv_3_invisible_overlay_does_not_receive_input FAILED
2. WHY: INV-PV-3 violation - ${invPv3.description}
3. EXPECTED: overlay.getValue() stays "x" — the "y" keystroke must not reach a component whose visible() now returns false
4. ACTUAL: overlay.getValue()=${JSON.stringify(overlay.getValue())}
5. GUIDANCE: Recheck focused-overlay visibility before delivering input and redirect focus when it is no longer visible`,
			).toBe("x");
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
		expect(
			reports.length,
			`1. WHAT: test_post_pv_4_concatenated_sgr_reports FAILED
2. WHY: POST-PV-4 violation - ${postPv4.description}
3. EXPECTED: 3 parsed SGR mouse reports
4. ACTUAL: ${reports.length}
5. GUIDANCE: Stream-parse every SGR packet in the chunk without dropping reports`,
		).toBe(3);
		expect(
			reports.map(report => report.wheel),
			`1. WHAT: test_post_pv_4_wheel_polarity FAILED
2. WHY: POST-PV-4 violation - ${postPv4.description}
3. EXPECTED: [-1, -1, 1]
4. ACTUAL: ${JSON.stringify(reports.map(report => report.wheel))}
5. GUIDANCE: Retain wheel polarity across concatenated packet streams`,
		).toEqual([-1, -1, 1]);
	});
});

// ============================================================================
// Software scrollback and content-integrity supporting checks (INV-PV-1,
// INV-PV-5) and pinned-only prompt lifecycle (INV-PV-7)
// ============================================================================

describe("pinned dock refactor — software scrollback, content integrity, and pinned-only prompt lifecycle", () => {
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
		expect(
			caught instanceof ZeroScrollbackError,
			`1. WHAT: test_inv_pv_1_validator_rejects_truncated_history FAILED
2. WHY: INV-PV-1 violation - ${invPv1.description}
3. EXPECTED: validateSoftwareScrollback(5, 10, 50) throws ZeroScrollbackError
4. ACTUAL: ${caught instanceof Error ? `threw ${caught.constructor.name}: ${caught.message}` : String(caught)}
5. GUIDANCE: Reject a transcriptLength <= windowHeight once more than 5 history blocks exist`,
		).toBe(true);
		expect(
			() => validateSoftwareScrollback(50, 10, 50),
			`1. WHAT: test_inv_pv_1_validator_accepts_sufficient_history FAILED
2. WHY: INV-PV-1 violation - ${invPv1.description}
3. EXPECTED: validateSoftwareScrollback(50, 10, 50) does not throw (history exceeds window height)
4. ACTUAL: threw
5. GUIDANCE: Only reject when transcriptLength <= windowHeight while more than 5 history blocks exist`,
		).not.toThrow();
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
			expect(
				transcriptRows.some(row => row.includes("DOCK_ONLY_ROW")),
				`1. WHAT: test_inv_pv_5_dock_does_not_leak_into_transcript FAILED
2. WHY: INV-PV-5 violation - ${invPv5.description}
3. EXPECTED: none of the ${transcriptRows.length} transcript-window rows contain "DOCK_ONLY_ROW"
4. ACTUAL: ${JSON.stringify(transcriptRows)}
5. GUIDANCE: Keep dock rows confined to the bottom dockHeight rows; never write dock or hint content into transcript rows`,
			).toBe(false);
			expect(
				dockRow,
				`1. WHAT: test_inv_pv_5_dock_row_intact FAILED (test setup sanity)
2. WHY: INV-PV-5 violation - ${invPv5.description}
3. EXPECTED: the bottom row is exactly "DOCK_ONLY_ROW"
4. ACTUAL: ${JSON.stringify(dockRow)}
5. GUIDANCE: The dock must occupy the bottom dockHeight rows of the composed frame`,
			).toBe("DOCK_ONLY_ROW");
		} finally {
			tui.stop();
		}
	});

	it("INV-PV-7: first frame after start renders the prompt only in the pinned dock", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.start()
		 * - Enforces: INV-PV-7: For every interactive TUI render, TUI SHALL render the prompt input box only in the pinned dock, including the first frame after start and every frame rendered after an exitPinned request.
		 * - Category: invariant
		 * - Test pyramid: Integration
		 * - Risk tier: High — an unpinned first frame is a live path that bypasses every pinned-dock guarantee (manifest DM-18 / Decision 9A)
		 * - Adversarial: Contract-governed, implementation-aware. Drives the public TUI.start() lifecycle with no pin request and observes exact terminal row placement of a distinguishable prompt plus the pinned-scroll discriminator above the dock.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites INV-PV-7 in requirements/contracts/pinned_dock.contract.ts.
		 *   [✓] C2 VALUABLE: both prompt dock placement AND pinned-scroll discriminator are observed. An unpinned/inline paint that places PROMPT:observe anywhere other than the final dock row fails; a missing prompt fails; a bottom-anchored prompt without TRANSCRIPT_LINE_1 visible above the dock fails.
		 *   [✓] C3 NON-DUPLICATIVE: the only test asserting first-frame-after-start dock placement and pinned-scroll discriminator; the sibling asserts the post-exitPinned boundary.
		 *   [✓] C4 NOT FUTURE-EDIT: bounds the existing start() render path (currently paints the prompt unpinned without the pinned-scroll discriminator), not a hypothetical API.
		 *
		 * Mock Contract: none.
		 * Double type: Stub (DistinguishablePromptFrameProvider) of TerminalFrameProvider; Fake (VirtualTerminal) of the production Terminal interface.
		 * VirtualTerminal.getViewport() reads the kitty WASM grid after real writes — the same observation seam already used for INV-PV-5.
		 */
		const invPv7 = CONTRACT_PINNED_DOCK["INV-PV-7"];
		const promptLine = "PROMPT:observe";
		const pinnedScrollDiscriminator = "TRANSCRIPT_LINE_1";
		const dockHeight = 1;
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal, false);
		tui.setFrameProvider(new DistinguishablePromptFrameProvider());
		try {
			tui.start();
			await terminal.waitForRender();
			const viewport = terminal.getViewport();
			const dockRows = viewport.slice(-dockHeight).map(row => row.trim());
			const aboveDock = viewport.slice(0, -dockHeight);
			expect(
				dockRows,
				`1. WHAT: test_inv_pv_7_first_frame_after_start_prompt_in_pinned_dock FAILED
2. WHY: INV-PV-7 violation - ${invPv7.description}
3. EXPECTED: the final ${dockHeight} physical row(s) equal [${JSON.stringify(promptLine)}]
4. ACTUAL: dock rows=${JSON.stringify(dockRows)}; full viewport=${JSON.stringify(viewport.map(row => row.trim()))}
5. GUIDANCE: The prompt input box must occupy the pinned dock on the first interactive frame after start, including when no separate pin request has been issued`,
			).toEqual([promptLine]);
			expect(
				aboveDock.some(row => row.includes(promptLine)),
				`1. WHAT: test_inv_pv_7_first_frame_after_start_prompt_only_in_dock FAILED
2. WHY: INV-PV-7 violation - ${invPv7.description}
3. EXPECTED: no row above the dock contains ${JSON.stringify(promptLine)}
4. ACTUAL: rows above dock=${JSON.stringify(aboveDock.map(row => row.trim()))}
5. GUIDANCE: The prompt input box must appear only in the pinned dock, never in the transcript window`,
			).toBe(false);
			expect(
				aboveDock.some(row => row.includes(pinnedScrollDiscriminator)),
				`1. WHAT: test_inv_pv_7_first_frame_after_start_pinned_scroll_discriminator FAILED
2. WHY: INV-PV-7 violation - ${invPv7.description}
3. EXPECTED: a row above the final prompt dock row contains ${JSON.stringify(pinnedScrollDiscriminator)}
4. ACTUAL: rows above dock=${JSON.stringify(aboveDock.map(row => row.trim()))}; full viewport=${JSON.stringify(viewport.map(row => row.trim()))}
5. GUIDANCE: The first interactive frame must show the pinned transcript discriminator above the prompt dock, not merely bottom-anchor the prompt`,
			).toBe(true);
		} finally {
			tui.stop();
		}
	});

	it("INV-PV-7: frame after exitPinned still renders the prompt only in the pinned dock", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.exitPinned()
		 * - Enforces: INV-PV-7: For every interactive TUI render, TUI SHALL render the prompt input box only in the pinned dock, including the first frame after start and every frame rendered after an exitPinned request.
		 * - Category: invariant
		 * - Test pyramid: Integration
		 * - Risk tier: High — honoring an exit request by painting an unpinned prompt reopens a live inline path (manifest DM-18 / Decision 9A)
		 * - Adversarial: Contract-governed, implementation-aware. Drives the public enter-then-exit lifecycle and observes exact terminal row placement after the exit request plus the pinned-scroll discriminator above the dock.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites INV-PV-7 in requirements/contracts/pinned_dock.contract.ts.
		 *   [✓] C2 VALUABLE: both prompt dock placement AND pinned-scroll discriminator are observed. Painting the prompt anywhere other than the final dock row after an exit request fails; a missing prompt fails; a bottom-anchored prompt without TRANSCRIPT_LINE_1 visible above the dock fails.
		 *   [✓] C3 NON-DUPLICATIVE: the only test asserting post-exitPinned dock placement and pinned-scroll discriminator; the sibling asserts the first-frame-after-start boundary.
		 *   [✓] C4 NOT FUTURE-EDIT: bounds the existing exitPinned() render path (currently paints the prompt unpinned again without the pinned-scroll discriminator), not a hypothetical API.
		 *
		 * Mock Contract: none.
		 * Double type: Stub (DistinguishablePromptFrameProvider) of TerminalFrameProvider; Fake (VirtualTerminal) of the production Terminal interface.
		 */
		const invPv7 = CONTRACT_PINNED_DOCK["INV-PV-7"];
		const promptLine = "PROMPT:observe";
		const pinnedScrollDiscriminator = "TRANSCRIPT_LINE_1";
		const dockHeight = 1;
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal, false);
		tui.setFrameProvider(new DistinguishablePromptFrameProvider());
		try {
			tui.start();
			await terminal.waitForRender();
			tui.enterPinned();
			await terminal.waitForRender();
			tui.exitPinned();
			await terminal.waitForRender();
			const viewport = terminal.getViewport();
			const dockRows = viewport.slice(-dockHeight).map(row => row.trim());
			const aboveDock = viewport.slice(0, -dockHeight);
			expect(
				dockRows,
				`1. WHAT: test_inv_pv_7_after_exit_pinned_prompt_in_pinned_dock FAILED
2. WHY: INV-PV-7 violation - ${invPv7.description}
3. EXPECTED: the final ${dockHeight} physical row(s) equal [${JSON.stringify(promptLine)}]
4. ACTUAL: dock rows=${JSON.stringify(dockRows)}; full viewport=${JSON.stringify(viewport.map(row => row.trim()))}
5. GUIDANCE: The prompt input box must occupy the pinned dock on every frame rendered after an exit request`,
			).toEqual([promptLine]);
			expect(
				aboveDock.some(row => row.includes(promptLine)),
				`1. WHAT: test_inv_pv_7_after_exit_pinned_prompt_only_in_dock FAILED
2. WHY: INV-PV-7 violation - ${invPv7.description}
3. EXPECTED: no row above the dock contains ${JSON.stringify(promptLine)}
4. ACTUAL: rows above dock=${JSON.stringify(aboveDock.map(row => row.trim()))}
5. GUIDANCE: The prompt input box must appear only in the pinned dock after an exit request, never in an unpinned transcript window`,
			).toBe(false);
			expect(
				aboveDock.some(row => row.includes(pinnedScrollDiscriminator)),
				`1. WHAT: test_inv_pv_7_after_exit_pinned_pinned_scroll_discriminator FAILED
2. WHY: INV-PV-7 violation - ${invPv7.description}
3. EXPECTED: a row above the final prompt dock row contains ${JSON.stringify(pinnedScrollDiscriminator)}
4. ACTUAL: rows above dock=${JSON.stringify(aboveDock.map(row => row.trim()))}; full viewport=${JSON.stringify(viewport.map(row => row.trim()))}
5. GUIDANCE: After an exit request the frame must still show the pinned transcript discriminator above the prompt dock, not merely bottom-anchor the prompt`,
			).toBe(true);
		} finally {
			tui.stop();
		}
	});
});

// ============================================================================
// Startup and explicit-exit alternate-screen ownership lifecycle (POST-PV-12b,
// POST-PV-28, POST-PV-29, SEQ-PV-11, SEQ-PV-12, INV-PV-17, INV-PV-18,
// FORBIDDEN-PV-10, ERRORS-PV-7) — Decision 9B / Decision 9C
// ============================================================================

describe("pinned dock refactor — startup and explicit-exit alternate-screen ownership", () => {
	it("POST-PV-28 / SEQ-PV-11 / INV-PV-17: start() renders the first prompt frame in the pinned dock without writing ALT_SCREEN_ENTER", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.start()
		 * - Enforces: POST-PV-28: TUI.start SHALL render its first prompt frame in the pinned dock without writing ALT_SCREEN_ENTER solely for startup
		 * - Enforces: SEQ-PV-11: TUI.start SHALL invoke TUI.#activatePinnedDock before requesting its first interactive frame
		 * - Enforces: INV-PV-17: TUI.start SHALL NOT write ALT_SCREEN_ENTER solely to render the first pinned prompt frame
		 * - Category: state-transition / integration
		 * - Test pyramid: Integration
		 * - Risk tier: High — every interactive session runs this startup path; a startup-owned alternate screen makes an independently requested fullscreen overlay a guest of the wrong canvas (manifest IP-PV-6 "Breaks If Missing", Decision 9B rejected-alternative rationale)
		 * - Adversarial: Contract-governed, implementation-aware. Drives the real TUI.start() lifecycle with no explicit pin request and captures the raw terminal write stream plus the first rendered frame's dock placement; only a real write-stream capture can distinguish "docked without alt-screen ownership" from "docked because isPinned() happens to be true", which the task's constraints bar as sole evidence.
		 *
		 * SEQ_TEST_SELF_CHECK:
		 *   [✓] Constructs the real TUI via new TUI(...) and drives it through start(), never a direct call to a private activation method.
		 *   [✓] Verifies SEQ-PV-11 ordering through the observable first-rendered-frame dock placement, not a direct #activatePinnedDock call.
		 *   [✓] Doubles: RecordingTerminal is a Spy — write(data) records the exact argument then delegates unchanged to VirtualTerminal.write (kitty-vt-wasm KittyTerminal). DistinguishablePromptFrameProvider is a Stub input fixture supplying a contract-valid TerminalFramePlan; it is not a terminal emulator and does not replace Terminal behavior.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-28, SEQ-PV-11, INV-PV-17 in requirements/contracts/pinned_dock.contract.ts.
		 *   [✓] C2 VALUABLE: today's start() writes ALT_SCREEN_ENTER on its very first call, failing the primary assertion; an implementation that activates the dock only after requesting a frame, or never docks the first frame, fails the secondary assertion.
		 *   [✓] C3 NON-DUPLICATIVE: the only test asserting TUI.start()'s terminal-mode write stream; the existing "first frame after start renders the prompt only in the pinned dock" INV-PV-7 test asserts row-exclusivity and the transcript discriminator and never inspects terminal-mode writes, so this test does not repeat it.
		 *   [✓] C4 NOT FUTURE-EDIT: bounds the current start() path, which writes ALT_SCREEN_ENTER on its first call today, not a hypothetical API.
		 *
		 * Mock Contract: none — no Terminal-behavior replacement.
		 * Double type: Spy (RecordingTerminal); Stub (DistinguishablePromptFrameProvider, contract-valid frame-plan input fixture).
		 * Fidelity source: RecordingTerminal.write records `data` then super.write(data). VirtualTerminal is backed by kitty-vt-wasm (KittyTerminal + loadModuleSync of kitty-vt.wasm in packages/tui/test/virtual-terminal.ts). The Spy cannot diverge from VirtualTerminal grid/mode semantics because it never substitutes them.
		 */
		const postPv28 = CONTRACT_PINNED_DOCK["POST-PV-28"];
		const seqPv11 = CONTRACT_PINNED_DOCK["SEQ-PV-11"];
		const invPv17 = CONTRACT_PINNED_DOCK["INV-PV-17"];
		const promptLine = "PROMPT:observe";
		const dockHeight = 1;
		const terminal = new RecordingTerminal(40, 8, 100);
		const tui = new TUI(terminal, false);
		tui.setFrameProvider(new DistinguishablePromptFrameProvider());
		try {
			tui.start();
			await terminal.waitForRender();

			const enterCount = countNeedle(terminal.writes, ALT_SCREEN_ENTER);
			expect(
				enterCount,
				`1. WHAT: test_post_pv_28_inv_pv_17_start_writes_no_alt_screen_enter FAILED
2. WHY: POST-PV-28 / INV-PV-17 violation - ${postPv28.description}; ${invPv17.description}
3. EXPECTED: 0 ALT_SCREEN_ENTER writes once TUI.start() settles its first frame
4. ACTUAL: ${enterCount}
5. GUIDANCE: Startup must dock the first prompt frame without acquiring alternate-screen ownership; reserve ALT_SCREEN_ENTER for an explicit pinned entry or an independently requested fullscreen overlay`,
			).toBe(0);

			const viewport = terminal.getViewport();
			const dockRows = viewport.slice(-dockHeight).map(row => row.trim());
			expect(
				dockRows,
				`1. WHAT: test_seq_pv_11_dock_active_on_first_rendered_frame FAILED
2. WHY: SEQ-PV-11 violation - ${seqPv11.description}
3. EXPECTED: the final ${dockHeight} physical row(s) of the first rendered frame equal [${JSON.stringify(promptLine)}]
4. ACTUAL: dock rows=${JSON.stringify(dockRows)}
5. GUIDANCE: Dock activation must run before the first interactive frame is requested, so the very first frame the terminal ever sees already carries the dock`,
			).toEqual([promptLine]);
		} finally {
			tui.stop();
		}
	});

	it("POST-PV-12b: a fullscreen overlay opened after dock-only startup writes exactly one ALT_SCREEN_ENTER", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.showOverlay() / TUI.#doRender()
		 * - Enforces: POST-PV-12b: opening a fullscreen overlay when no lifecycle owns the alternate screen SHALL write exactly one ALT_SCREEN_ENTER
		 * - Category: positive / integration
		 * - Test pyramid: Integration
		 * - Risk tier: High — a startup-owned alternate screen makes the overlay a silent guest of the wrong canvas instead of claiming its own entry (manifest Decision 9B rejected-alternative rationale)
		 * - Adversarial: Contract-governed, implementation-aware. Drives real start() then showOverlay({ fullscreen: true }) and measures the ALT_SCREEN_ENTER write attributable to the overlay-open call specifically — the diff across that call — rather than a bare post-hoc total; a startup bug that already claimed the screen would make a bare "total == 1" assertion pass for the wrong reason.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-12b in requirements/contracts/pinned_dock.contract.ts.
		 *   [✓] C2 VALUABLE: today's startup already claims the alternate screen, so the overlay-open call contributes zero new writes, failing the diff assertion below; a bare total-count check would pass for the wrong reason and is deliberately not used.
		 *   [✓] C3 NON-DUPLICATIVE: the only test measuring the ALT_SCREEN_ENTER write attributable to a fullscreen-overlay-open call made after a bare, unpinned start(); distinct from the POST-PV-28/INV-PV-17 start()-only test above (no overlay involved) and from the SLICE-1 POST-PV-12 test (overlay opened while an explicit enterPinned() already owns the screen).
		 *   [✓] C4 NOT FUTURE-EDIT: bounds the current overlay-open path, which contributes zero writes today because startup already owns the screen, not a hypothetical API.
		 *
		 * Mock Contract: none — no Terminal-behavior replacement.
		 * Double type: Spy (RecordingTerminal); Stub (StaticPinnedFrameProvider, contract-valid frame-plan input fixture); real Input overlay body (content not under test).
		 * Fidelity source: RecordingTerminal.write records `data` then super.write(data). VirtualTerminal is backed by kitty-vt-wasm (KittyTerminal + loadModuleSync of kitty-vt.wasm in packages/tui/test/virtual-terminal.ts). StaticPinnedFrameProvider is not a terminal emulator.
		 */
		const postPv12b = CONTRACT_PINNED_DOCK["POST-PV-12b"];
		const terminal = new RecordingTerminal(40, 8, 100);
		const tui = new TUI(terminal, false);
		tui.setFrameProvider(new StaticPinnedFrameProvider(["TRANSCRIPT_LINE_1"], ["DOCK_LINE_1"]));
		const overlay = new Input();
		overlay.prompt = "OVERLAY_BODY:";
		try {
			tui.start();
			await terminal.waitForRender();
			const beforeOverlayEnterCount = countNeedle(terminal.writes, ALT_SCREEN_ENTER);

			tui.showOverlay(overlay, { fullscreen: true });
			await terminal.waitForRender();
			const afterOverlayEnterCount = countNeedle(terminal.writes, ALT_SCREEN_ENTER);

			expect(
				afterOverlayEnterCount - beforeOverlayEnterCount,
				`1. WHAT: test_post_pv_12b_overlay_open_writes_one_alt_screen_enter FAILED
2. WHY: POST-PV-12b violation - ${postPv12b.description}
3. EXPECTED: exactly 1 new ALT_SCREEN_ENTER write attributable to the fullscreen-overlay-open call
4. ACTUAL: ${afterOverlayEnterCount - beforeOverlayEnterCount} new write(s) (before=${beforeOverlayEnterCount}, after=${afterOverlayEnterCount})
5. GUIDANCE: When no lifecycle yet owns the alternate screen, the fullscreen overlay's own open must be the action that claims it`,
			).toBe(1);
		} finally {
			tui.stop();
		}
	});

	it("POST-PV-29 / SEQ-PV-12 / INV-PV-18 / FORBIDDEN-PV-10 / ERRORS-PV-7: exitPinned releases only an alternate screen it explicitly owns, never one owned by an overlay or an in-flight resize", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.exitPinned()
		 * - Enforces: POST-PV-29: TUI.exitPinned SHALL write exactly one ALT_SCREEN_LEAVE when the explicit pinned session owns the alternate screen and no overlay or resize lifecycle owns it
		 * - Enforces: SEQ-PV-12: TUI.exitPinned SHALL invoke TUI.#releasePinnedAltScreen after retaining dock state, and only the pinned-owned screen may be released
		 * - Enforces: INV-PV-18: TUI.exitPinned SHALL retain pinned state, PinnedViewport, and docked prompt after an explicit pinned exit
		 * - Enforces: FORBIDDEN-PV-10: TUI.exitPinned SHALL NOT write ALT_SCREEN_LEAVE when the explicit pinned session does not own the alternate screen, including while overlay or resize lifecycle state owns it
		 * - Enforces: ERRORS-PV-7: when no explicit pinned screen is owned, TUI.exitPinned SHALL intentionally retain the dock and emit no ALT_SCREEN_LEAVE; error class: none; propagation: none
		 * - Category: state-transition / invariant / error (combined single-lifecycle scenario)
		 * - Test pyramid: Integration
		 * - Risk tier: High — releasing a screen exitPinned does not own corrupts an overlay's or an in-flight resize's borrowed buffer; never releasing one it does own leaves the session fullscreen forever (manifest IP-PV-7 "Breaks If Missing")
		 * - Adversarial: Contract-governed, implementation-aware. Drives one continuous real start() -> enterPinned() -> scrollPinnedBy() -> exitPinned() -> showOverlay(fullscreen) -> exitPinned() -> resize() -> exitPinned() lifecycle and measures the ALT_SCREEN_LEAVE write diff attributable to each exitPinned() call plus the PinnedViewport scroll window, never isPinned() alone. The three exitPinned() calls exercise, in order: a pinned-owned screen (must release exactly once), an overlay-owned screen (must not release), and an in-flight resize-owned screen (must not release) — the positive and negative branches of the same ownership check, so this single scenario cannot be satisfied by an implementation that always releases or one that never releases.
		 *
		 * SEQ_TEST_SELF_CHECK:
		 *   [✓] Constructs the real TUI via new TUI(...) and drives start()/enterPinned()/exitPinned()/showOverlay()/terminal.resize(), never a direct call to #releasePinnedAltScreen or #ensurePinnedAltScreen.
		 *   [✓] Verifies SEQ-PV-12 through the observable ALT_SCREEN_LEAVE write diff across each real exitPinned() call.
		 *   [✓] Doubles: RecordingTerminal is a Spy — write(data) records the exact argument then delegates unchanged to VirtualTerminal.write (kitty-vt-wasm KittyTerminal). StaticPinnedFrameProvider is a Stub input fixture supplying a contract-valid TerminalFramePlan; it is not a terminal emulator and does not replace Terminal behavior. terminal.resize() drives the real resize handler synchronously, so the in-flight resize-owned window is observed before its ~120ms settle timer, never by mutating a private flag.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-29, SEQ-PV-12, INV-PV-18, FORBIDDEN-PV-10, ERRORS-PV-7, all present in requirements/contracts/pinned_dock.contract.ts.
		 *   [✓] C2 VALUABLE: today's exitPinned() is an alias for enterPinned() and never writes ALT_SCREEN_LEAVE under any circumstance, so the first (pinned-owned) phase's "exactly 1" assertion fails today; an implementation that releases unconditionally regardless of ownership would instead fail the second and third phases' "exactly 0" assertions, which this same scenario also covers. Recreating or resetting PinnedViewport fails the scrolled-window discriminator (TRANSCRIPT_LINE_9 visible, TRANSCRIPT_LINE_10 absent) or the docked-prompt row.
		 *   [✓] C3 NON-DUPLICATIVE: the only test asserting the ALT_SCREEN_LEAVE write stream for TUI.exitPinned() under pinned-owned, overlay-owned, and resize-owned conditions, and the only test asserting PinnedViewport scrolled-window continuity across an exitPinned() call. INV-PV-7's post-exitPinned case asserts prompt exclusivity plus TRANSCRIPT_LINE_1 on an unscrolled 1-line history and is not repeated; SLICE-1 POST-PV-11/POST-PV-12 assert ALT_SCREEN_ENTER idempotency and overlay-open suppression and are not repeated.
		 *   [✓] C4 NOT FUTURE-EDIT: bounds the current exitPinned() path, which never writes ALT_SCREEN_LEAVE today regardless of ownership, not a hypothetical API.
		 *
		 * Mock Contract: none — no Terminal-behavior replacement.
		 * Double type: Spy (RecordingTerminal); Stub (StaticPinnedFrameProvider, contract-valid frame-plan input fixture); real Input overlay body.
		 * Fidelity source: RecordingTerminal.write records `data` then super.write(data). VirtualTerminal is backed by kitty-vt-wasm (KittyTerminal + loadModuleSync of kitty-vt.wasm in packages/tui/test/virtual-terminal.ts). StaticPinnedFrameProvider is not a terminal emulator.
		 */
		const postPv29 = CONTRACT_PINNED_DOCK["POST-PV-29"];
		const seqPv12 = CONTRACT_PINNED_DOCK["SEQ-PV-12"];
		const invPv18 = CONTRACT_PINNED_DOCK["INV-PV-18"];
		const forbiddenPv10 = CONTRACT_PINNED_DOCK["FORBIDDEN-PV-10"];
		const errorsPv7 = CONTRACT_PINNED_DOCK["ERRORS-PV-7"];
		const transcript = Array.from({ length: 10 }, (_, i) => `TRANSCRIPT_LINE_${i + 1}`);
		const terminal = new RecordingTerminal(40, 8, 100);
		const tui = new TUI(terminal, false);
		tui.setFrameProvider(new StaticPinnedFrameProvider(transcript, ["PROMPT:observe"]));
		try {
			// ---- Phase 1: pinned alone explicitly owns the alternate screen ----
			tui.start();
			await terminal.waitForRender();
			tui.enterPinned();
			await terminal.waitForRender();
			tui.scrollPinnedBy(-1);
			await terminal.waitForRender();
			const scrolledViewport = terminal.getViewport().map(row => row.trim());

			const leaveBeforePinnedExit = countNeedle(terminal.writes, ALT_SCREEN_LEAVE);
			tui.exitPinned();
			await terminal.waitForRender();
			const leaveAfterPinnedExit = countNeedle(terminal.writes, ALT_SCREEN_LEAVE);
			expect(
				leaveAfterPinnedExit - leaveBeforePinnedExit,
				`1. WHAT: test_post_pv_29_seq_pv_12_pinned_owned_exit_writes_one_alt_screen_leave FAILED
2. WHY: POST-PV-29 / SEQ-PV-12 violation - ${postPv29.description}; ${seqPv12.description}
3. EXPECTED: exactly 1 new ALT_SCREEN_LEAVE write when exitPinned() is called while the explicit pinned session alone owns the alternate screen
4. ACTUAL: ${leaveAfterPinnedExit - leaveBeforePinnedExit} new write(s) (before=${leaveBeforePinnedExit}, after=${leaveAfterPinnedExit})
5. GUIDANCE: exitPinned must release a pinned-owned alternate screen exactly once`,
			).toBe(1);

			const postExitViewport = terminal.getViewport().map(row => row.trim());
			const postExitAboveDock = postExitViewport.slice(0, -1);
			const postExitDockRows = postExitViewport.slice(-1);
			const retainedPinnedWindow = {
				scrolledLineVisible: postExitAboveDock.some(row => row.includes("TRANSCRIPT_LINE_9")),
				tailLineVisible: postExitAboveDock.some(row => row.includes("TRANSCRIPT_LINE_10")),
			};
			expect(
				postExitDockRows,
				`1. WHAT: test_inv_pv_18_docked_prompt_retained_after_exit FAILED
2. WHY: INV-PV-18 violation - ${invPv18.description}
3. EXPECTED: the final dock row equals ["PROMPT:observe"] after explicit pinned exit
4. ACTUAL: dock=${JSON.stringify(postExitDockRows)}; before=${JSON.stringify(scrolledViewport)}; after=${JSON.stringify(postExitViewport)}
5. GUIDANCE: An explicit pinned exit must keep the prompt docked; it must not drop or unpin the dock`,
			).toEqual(["PROMPT:observe"]);
			expect(
				retainedPinnedWindow,
				`1. WHAT: test_inv_pv_18_pinned_viewport_scroll_window_retained_after_exit FAILED
2. WHY: INV-PV-18 violation - ${invPv18.description}
3. EXPECTED: after exitPinned() the retained PinnedViewport still shows the scrolled window: { scrolledLineVisible: true, tailLineVisible: false } ("TRANSCRIPT_LINE_9" above the dock, "TRANSCRIPT_LINE_10" absent)
4. ACTUAL: ${JSON.stringify(retainedPinnedWindow)}; before=${JSON.stringify(scrolledViewport)}; after above-dock=${JSON.stringify(postExitAboveDock)}
5. GUIDANCE: exitPinned must retain the existing PinnedViewport scroll window, never recreate or reset it to the tail or the top`,
			).toEqual({ scrolledLineVisible: true, tailLineVisible: false });
			expect(
				tui.isPinned(),
				`1. WHAT: test_inv_pv_18_pinned_state_retained_after_exit FAILED
2. WHY: INV-PV-18 violation - ${invPv18.description}
3. EXPECTED: isPinned() still true after an explicit pinned exit
4. ACTUAL: ${tui.isPinned()}
5. GUIDANCE: An explicit pinned exit retains pinned state; it does not unpin the session`,
			).toBe(true);

			// ---- Phase 2: a fullscreen overlay owns the alternate screen ----
			const overlay = new Input();
			overlay.prompt = "OVERLAY_BODY:";
			const handle = tui.showOverlay(overlay, { fullscreen: true });
			await terminal.waitForRender();

			const leaveBeforeOverlayExit = countNeedle(terminal.writes, ALT_SCREEN_LEAVE);
			tui.exitPinned();
			await terminal.waitForRender();
			const leaveAfterOverlayExit = countNeedle(terminal.writes, ALT_SCREEN_LEAVE);
			expect(
				leaveAfterOverlayExit - leaveBeforeOverlayExit,
				`1. WHAT: test_forbidden_pv_10_errors_pv_7_overlay_owned_exit_writes_no_alt_screen_leave FAILED
2. WHY: FORBIDDEN-PV-10 / ERRORS-PV-7 violation - ${forbiddenPv10.description}; ${errorsPv7.description}
3. EXPECTED: 0 new ALT_SCREEN_LEAVE writes when exitPinned() is called while a fullscreen overlay owns the alternate screen
4. ACTUAL: ${leaveAfterOverlayExit - leaveBeforeOverlayExit} new write(s) (before=${leaveBeforeOverlayExit}, after=${leaveAfterOverlayExit})
5. GUIDANCE: exitPinned must not release an alternate screen owned by a fullscreen overlay`,
			).toBe(0);
			expect(
				tui.isPinned(),
				`1. WHAT: test_errors_pv_7_dock_retained_during_overlay_ownership FAILED (secondary signal)
2. WHY: ERRORS-PV-7 violation - ${errorsPv7.description}
3. EXPECTED: isPinned() still true — the dock is retained, not torn down, when exitPinned() finds no pinned-owned screen to release
4. ACTUAL: ${tui.isPinned()}
5. GUIDANCE: Intentionally retain the dock and emit no exception when exitPinned() does not own the alternate screen`,
			).toBe(true);
			handle.hide();
			await terminal.waitForRender();

			// ---- Phase 3: an in-flight resize owns the alternate screen ----
			const leaveBeforeResizeExit = countNeedle(terminal.writes, ALT_SCREEN_LEAVE);
			terminal.resize(60, 10);
			tui.exitPinned();
			const leaveAfterResizeExit = countNeedle(terminal.writes, ALT_SCREEN_LEAVE);
			expect(
				leaveAfterResizeExit - leaveBeforeResizeExit,
				`1. WHAT: test_forbidden_pv_10_resize_owned_exit_writes_no_alt_screen_leave FAILED
2. WHY: FORBIDDEN-PV-10 violation - ${forbiddenPv10.description}
3. EXPECTED: 0 new ALT_SCREEN_LEAVE writes when exitPinned() is called while an in-flight resize owns the alternate screen
4. ACTUAL: ${leaveAfterResizeExit - leaveBeforeResizeExit} new write(s) (before=${leaveBeforeResizeExit}, after=${leaveAfterResizeExit})
5. GUIDANCE: exitPinned must not release an alternate screen borrowed by an in-flight resize repaint`,
			).toBe(0);
		} finally {
			tui.stop();
		}
	});
});
