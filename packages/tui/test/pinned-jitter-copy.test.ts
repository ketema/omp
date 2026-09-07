import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type TerminalFramePlan, type TerminalFrameProvider, TUI, type ViewportSize } from "@oh-my-pi/pi-tui";
import { parseSgrMouseStream, routeSgrMouseInput, type SgrMouseEvent } from "@oh-my-pi/pi-tui/mouse";
import { PINNED_WHEEL_SCROLL_LINES as IMPL_WHEEL_LINES, PINNED_MOUSE_ENTER } from "@oh-my-pi/pi-tui/pinned-viewport";
import {
	PINNED_WHEEL_SCROLL_LINES as CONTRACT_WHEEL_LINES,
	OSC52_CLIPBOARD_PREFIX,
	PINNED_MOUSE_SGR,
	PinnedJitterCopyContractError,
	validateSgrMouseStream,
} from "../../../requirements/contracts/pinned-jitter-copy.contract";
import { VirtualTerminal } from "./virtual-terminal";

/**
 * Test Double: RecordingTerminal (Stub/Spy)
 * Wraps VirtualTerminal to capture all output writes for escape sequence and clipboard assertions.
 */
class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

/**
 * Test Double: StaticFrameProvider (Stub)
 * Supplies predictable transcript and dock lines for TUI pinned frame testing.
 */
class StaticFrameProvider implements TerminalFrameProvider {
	constructor(
		readonly transcript: readonly string[],
		readonly dock: readonly string[],
	) {}

	renderFrame(_viewport: ViewportSize): TerminalFramePlan {
		return {
			viewport: [],
			pinnedScroll: [...this.transcript],
			pinnedDock: [...this.dock],
		};
	}
}

describe("CONTRACT_PINNED_JITTER_COPY (TUI Implementation Tests)", () => {
	it("Alignment: Implementation and contract agree on wheel scroll line constant", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: PinnedViewport & contract
		 * - Enforces: POST-2: PINNED_WHEEL_SCROLL_LINES constant alignment
		 * - Category: invariant
		 * - Risk tier: Medium — constant mismatch causes scroll velocity drift
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-2 existing in contracts/pinned-jitter-copy.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: verifies baseline constant alignment between impl and contract
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		expect(IMPL_WHEEL_LINES).toBe(
			CONTRACT_WHEEL_LINES,
			`1. WHAT: test_constant_alignment FAILED\n2. WHY: POST-2 violation - implementation wheel scroll lines must match contract\n3. EXPECTED: ${CONTRACT_WHEEL_LINES}\n4. ACTUAL: ${IMPL_WHEEL_LINES}\n5. GUIDANCE: Align PINNED_WHEEL_SCROLL_LINES to 3 lines per notch`,
		);
	});

	it("POST-1 / FORBIDDEN-1: parse API / routeSgrMouseInput handles concatenated SGR reports in one chunk without dropping", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: routeSgrMouseInput() & parseSgrMouse()
		 * - Enforces: POST-1: parse of a stdin chunk SHALL return every SGR mouse report in order, including concatenated reports in one chunk
		 * - Enforces: FORBIDDEN-1: a concatenated multi-report SGR chunk SHALL NOT be dropped as unparsed
		 * - Category: positive / boundary
		 * - Risk tier: High — dropping concatenated mouse packets causes scroll stutter and missing drag events
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clauses POST-1 and FORBIDDEN-1 existing in contracts/pinned-jitter-copy.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (anchored regex returns null on multi-event input)
		 *   [✓] C3 NON-DUPLICATIVE: tests stream parsing across multi-event stdin chunks at mouse router surface
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		const concatenatedChunk = "\x1b[<64;10;5M\x1b[<65;10;5M";
		const received: SgrMouseEvent[] = [];
		const handled = routeSgrMouseInput(concatenatedChunk, event => {
			received.push(event);
			return true;
		});

		expect(handled).toBe(
			true,
			`1. WHAT: test_route_concatenated_sgr FAILED\n2. WHY: FORBIDDEN-1 violation - concatenated multi-report SGR chunk was dropped as unparsed\n3. EXPECTED: true (handled)\n4. ACTUAL: ${handled}\n5. GUIDANCE: Stream parse SGR reports without anchoring to single-report boundaries`,
		);

		expect(received.length).toBe(
			2,
			`1. WHAT: test_route_concatenated_sgr_count FAILED\n2. WHY: POST-1 violation - parse of stdin chunk did not extract all concatenated SGR reports\n3. EXPECTED: 2 events\n4. ACTUAL: ${received.length} events\n5. GUIDANCE: Extract every SGR report present in the input chunk sequentially`,
		);

		expect(received[0]?.wheel).toBe(
			-1,
			`1. WHAT: test_route_concatenated_sgr_first_event FAILED\n2. WHY: POST-1 violation - first SGR report wheel direction mismatch\n3. EXPECTED: -1 (wheel up)\n4. ACTUAL: ${received[0]?.wheel}\n5. GUIDANCE: Preserve order and properties of first SGR report`,
		);

		expect(received[1]?.wheel).toBe(
			1,
			`1. WHAT: test_route_concatenated_sgr_second_event FAILED\n2. WHY: POST-1 violation - second SGR report wheel direction mismatch\n3. EXPECTED: 1 (wheel down)\n4. ACTUAL: ${received[1]?.wheel}\n5. GUIDANCE: Preserve order and properties of second SGR report`,
		);
	});

	it("POST-2 / SEQ-1: TUI.#handlePinnedInput applies summed wheel delta from concatenated wheel chunk", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.handleInput() -> PinnedViewport.scrollBy()
		 * - Enforces: POST-2: the pinned mouse handler SHALL scroll by the summed wheel delta of all wheel reports in the chunk (PINNED_WHEEL_SCROLL_LINES per notch)
		 * - Enforces: SEQ-1: TUI.#handlePinnedInput SHALL stream-parse SGR before calling PinnedViewport.scrollBy (IP-DM-1)
		 * - Category: integration
		 * - Risk tier: High — failure to sum wheel deltas causes dropped scroll increments under fast trackpad/wheel gestures
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clauses POST-2 and SEQ-1 existing in contracts/pinned-jitter-copy.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (current code drops concatenated chunks)
		 *   [✓] C3 NON-DUPLICATIVE: tests end-to-end scroll accumulation from multi-report stdin chunk to TUI viewport
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		const term = new RecordingTerminal(40, 10, 100);
		const tui = new TUI(term, false);

		// 30 transcript rows, 2 dock rows, height 10 => window height = 8
		// Following tail initially shows transcript lines 22..29
		const transcript = Array.from({ length: 30 }, (_, i) => `LINE_${String(i).padStart(2, "0")}`);
		const dock = ["DOCK_PROMPT", "DOCK_STATUS"];
		const provider = new StaticFrameProvider(transcript, dock);

		tui.setFrameProvider(provider);
		tui.start();
		tui.enterPinned();
		await term.waitForRender();

		const initialViewport = term.getViewport();
		// Initial viewport at tail: lines 22..29 visible
		expect(initialViewport[0]?.trim()).toBe(
			"LINE_22",
			`1. WHAT: test_initial_pinned_viewport FAILED\n2. WHY: POST-2 precondition violation - initial viewport not at tail\n3. EXPECTED: LINE_22\n4. ACTUAL: ${initialViewport[0]?.trim()}\n5. GUIDANCE: Initialize pinned viewport following tail`,
		);

		// Send 2 wheel-up reports concatenated in ONE chunk: 2 notches up = -6 lines
		const twoNotchesUp = "\x1b[<64;10;5M\x1b[<64;10;5M";
		term.sendInput(twoNotchesUp);
		await term.waitForRender();

		const scrolledViewport = term.getViewport();
		// After 6 lines up: visible transcript should be lines 16..23
		expect(scrolledViewport[0]?.trim()).toBe(
			"LINE_16",
			`1. WHAT: test_summed_wheel_scroll FAILED\n2. WHY: POST-2 / SEQ-1 violation - concatenated wheel reports did not scroll by summed delta (2 notches * 3 lines = 6 lines)\n3. EXPECTED: LINE_16\n4. ACTUAL: ${scrolledViewport[0]?.trim()}\n5. GUIDANCE: Stream parse concatenated SGR wheel events and apply the summed line delta to the viewport`,
		);

		tui.stop();
	});

	it("POST-3: Left button press, drag, and release copies selected visible plaintext via OSC 52", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#handlePinnedInput -> OSC 52 clipboard write
		 * - Enforces: POST-3: left-button press, drag, and release on transcript rows SHALL copy the selected visible plaintext to the clipboard via OSC 52
		 * - Category: integration
		 * - Risk tier: High — highlight-to-copy is core terminal UX; broken copy traps text in terminal
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-3 existing in contracts/pinned-jitter-copy.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (current code ignores non-wheel SGR)
		 *   [✓] C3 NON-DUPLICATIVE: tests mouse drag selection and OSC 52 clipboard emission on release
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		const term = new RecordingTerminal(40, 10, 100);
		const tui = new TUI(term, false);

		const transcript = ["ALPHA_TRANSCRIPT_LINE", "BETA_TRANSCRIPT_LINE", "GAMMA_TRANSCRIPT_LINE"];
		const dock = ["DOCK_INPUT"];
		const provider = new StaticFrameProvider(transcript, dock);

		tui.setFrameProvider(provider);
		tui.start();
		tui.enterPinned();
		await term.waitForRender();

		// Simulate drag selection on row 0:
		// Press left at col 0, row 0 (1-based: col 1, row 1) => \x1b[<0;1;1M
		// Drag to col 5, row 0 (1-based: col 6, row 1, button 32 = motion) => \x1b[<32;6;1M
		// Release at col 5, row 0 (1-based: col 6, row 1, suffix 'm') => \x1b[<0;6;1m
		// Selected text: "ALPHA" (columns 0..4 of "ALPHA_TRANSCRIPT_LINE")
		term.sendInput("\x1b[<0;1;1M");
		term.sendInput("\x1b[<32;6;1M");
		term.sendInput("\x1b[<0;6;1m");
		await term.waitForRender();

		const expectedSelectedText = "ALPHA";
		const expectedBase64 = Buffer.from(expectedSelectedText, "utf8").toString("base64");

		const allWrites = term.writes.join("");
		const hasOsc52Prefix = allWrites.includes(OSC52_CLIPBOARD_PREFIX);
		const hasPayload = allWrites.includes(expectedBase64);

		expect(hasOsc52Prefix && hasPayload).toBe(
			true,
			`1. WHAT: test_highlight_copy_osc52 FAILED\n2. WHY: POST-3 violation - left button press, drag, and release on transcript did not emit OSC 52 clipboard sequence with selected text\n3. EXPECTED: terminal write containing '${OSC52_CLIPBOARD_PREFIX}' and base64 '${expectedBase64}' for '${expectedSelectedText}'\n4. ACTUAL: OSC52 prefix present: ${hasOsc52Prefix}, payload present: ${hasPayload}\n5. GUIDANCE: Track mouse drag selection over transcript rows and write OSC 52 clipboard sequence on release`,
		);

		tui.stop();
	});

	it("POST-3: exitPinned discards an in-progress drag so a later release does not copy", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.exitPinned / drag selection
		 * - Enforces: POST-3: copy only for an uninterrupted press-drag-release
		 * - Category: regression
		 * - Risk tier: Medium — stale drag after exit writes unexpected clipboard
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-3
		 *   [✓] C2 VALUABLE: fails if drag state survives exitPinned
		 *   [✓] C3 NON-DUPLICATIVE: interrupted-gesture path, not the happy-path copy test
		 *   [✓] C4 NOT FUTURE-EDIT: locks the arbitrated exitPinned/overlay clear
		 */
		const term = new RecordingTerminal(40, 10, 100);
		const tui = new TUI(term, false);
		tui.setFrameProvider(new StaticFrameProvider(["ALPHA_TRANSCRIPT_LINE"], ["DOCK_INPUT"]));
		tui.start();
		tui.enterPinned();
		await term.waitForRender();
		term.sendInput("\x1b[<0;1;1M");
		term.sendInput("\x1b[<32;6;1M");
		tui.exitPinned();
		tui.enterPinned();
		await term.waitForRender();
		const writesBefore = term.writes.length;
		term.sendInput("\x1b[<0;6;1m");
		await term.waitForRender();
		const after = term.writes.slice(writesBefore).join("");
		expect(after.includes(OSC52_CLIPBOARD_PREFIX)).toBe(
			false,
			`1. WHAT: test_exitPinned_clears_drag FAILED\n2. WHY: POST-3 - release after exitPinned copied from a stale drag\n3. EXPECTED: no OSC 52 after the post-exit release\n4. ACTUAL: writes contained OSC 52\n5. GUIDANCE: Clear drag anchors when leaving pinned mode`,
		);
		tui.stop();
	});

	it("POST-4: Pinned mouse-enter includes SGR encoding 1006", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.enterPinned() & PINNED_MOUSE_ENTER
		 * - Enforces: POST-4: pinned mouse-enter SHALL include SGR encoding 1006; button-event 1002 MAY remain only to feed POST-3 drag motion
		 * - Category: positive
		 * - Risk tier: High — missing SGR 1006 limits coordinates to 223 columns and breaks UTF-8 mouse
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-4 existing in contracts/pinned-jitter-copy.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: asserts presence of SGR 1006 mode escape sequence on enterPinned
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		const term = new RecordingTerminal(40, 10, 100);
		const tui = new TUI(term, false);

		expect(PINNED_MOUSE_ENTER.includes(PINNED_MOUSE_SGR)).toBe(
			true,
			`1. WHAT: test_pinned_mouse_enter_constant FAILED\n2. WHY: POST-4 violation - PINNED_MOUSE_ENTER constant must include SGR 1006 sequence\n3. EXPECTED: contains ${JSON.stringify(PINNED_MOUSE_SGR)}\n4. ACTUAL: ${JSON.stringify(PINNED_MOUSE_ENTER)}\n5. GUIDANCE: Include \\x1b[?1006h in PINNED_MOUSE_ENTER`,
		);

		tui.start();
		tui.enterPinned();
		await term.waitForRender();

		const writesBlob = term.writes.join("");
		expect(writesBlob.includes(PINNED_MOUSE_SGR)).toBe(
			true,
			`1. WHAT: test_enter_pinned_writes_sgr FAILED\n2. WHY: POST-4 violation - enterPinned did not write SGR 1006 enable sequence to terminal\n3. EXPECTED: terminal writes contain ${JSON.stringify(PINNED_MOUSE_SGR)}\n4. ACTUAL: writes=${JSON.stringify(term.writes)}\n5. GUIDANCE: Emit SGR mouse mode sequence on pinned session initialization`,
		);

		tui.stop();
	});

	it("POST-6: When following is false, TUI SHALL NOT replace a transcript content row with a follow-key hint", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#renderPinnedFrame()
		 * - Enforces: POST-6: when following is false, TUI SHALL NOT replace a transcript content row with a follow-key hint
		 * - Category: negative / regression
		 * - Risk tier: High — clobbering transcript content rows corrupts displayed log data
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-6 existing in contracts/pinned-jitter-copy.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (lines[hintRow] currently overwrites last transcript row)
		 *   [✓] C3 NON-DUPLICATIVE: tests transcript preservation when following is paused
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		const term = new RecordingTerminal(40, 6, 100);
		const tui = new TUI(term, false);

		// 6 rows total: windowHeight = 4, dock = 2
		const transcript = [
			"CONTENT_ROW_0",
			"CONTENT_ROW_1",
			"CONTENT_ROW_2",
			"CONTENT_ROW_3",
			"CONTENT_ROW_4",
			"CONTENT_ROW_5",
		];
		const dock = ["DOCK_ROW_0", "DOCK_ROW_1"];
		const provider = new StaticFrameProvider(transcript, dock);

		tui.setFrameProvider(provider);
		tui.start();
		tui.enterPinned();
		await term.waitForRender();

		// Scroll up by 2 lines to pause following. Visible transcript lines: CONTENT_ROW_0..3
		tui.scrollPinnedBy(-2);
		await term.waitForRender();

		const viewport = term.getViewport();

		// Content row 3 (row index 3) must be "CONTENT_ROW_3", NOT overwritten with "to follow"
		const row3Text = viewport[3]?.trim();
		const hasClobberedHint = (viewport[3] ?? "").includes("to follow");

		expect(hasClobberedHint).toBe(
			false,
			`1. WHAT: test_follow_hint_overwriting_transcript FAILED\n2. WHY: POST-6 violation - TUI replaced transcript content row with follow-key hint\n3. EXPECTED: row 3 contains 'CONTENT_ROW_3' without follow hint overwrite\n4. ACTUAL: row 3 is '${viewport[3]}'\n5. GUIDANCE: Do not overwrite visible transcript content rows with follow hint text when following is paused`,
		);

		expect(row3Text).toBe(
			"CONTENT_ROW_3",
			`1. WHAT: test_transcript_row_content_preserved FAILED\n2. WHY: POST-6 violation - transcript row 3 content altered\n3. EXPECTED: CONTENT_ROW_3\n4. ACTUAL: ${row3Text}\n5. GUIDANCE: Preserve original transcript row content during scrolled rendering`,
		);

		tui.stop();
	});

	it("INV-1: The editor dock SHALL remain the last rows of the physical frame", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TUI.#renderPinnedFrame() & PinnedViewport.composeFrame()
		 * - Enforces: INV-1: the editor dock SHALL remain the last rows of the physical frame
		 * - Category: invariant
		 * - Risk tier: High — dock misalignment pushes prompt off screen
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause INV-1 existing in contracts/pinned-jitter-copy.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: verifies physical dock invariant on rendered frame
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		const term = new RecordingTerminal(40, 8, 100);
		const tui = new TUI(term, false);

		const transcript = ["T0", "T1", "T2", "T3", "T4"];
		const dock = ["DOCK_ROW_FIRST", "DOCK_ROW_SECOND"];
		const provider = new StaticFrameProvider(transcript, dock);

		tui.setFrameProvider(provider);
		tui.start();
		tui.enterPinned();
		await term.waitForRender();

		const viewport = term.getViewport();
		const lastRowIndex = viewport.length - 1;
		const secondLastRowIndex = viewport.length - 2;

		expect(viewport[secondLastRowIndex]?.trim()).toBe(
			"DOCK_ROW_FIRST",
			`1. WHAT: test_dock_second_last_row FAILED\n2. WHY: INV-1 violation - dock first row is not at physical position height-2\n3. EXPECTED: DOCK_ROW_FIRST\n4. ACTUAL: ${viewport[secondLastRowIndex]?.trim()}\n5. GUIDANCE: Pin dock to the bottom rows of the frame`,
		);

		expect(viewport[lastRowIndex]?.trim()).toBe(
			"DOCK_ROW_SECOND",
			`1. WHAT: test_dock_last_row FAILED\n2. WHY: INV-1 violation - dock last row is not at physical position height-1\n3. EXPECTED: DOCK_ROW_SECOND\n4. ACTUAL: ${viewport[lastRowIndex]?.trim()}\n5. GUIDANCE: Pin dock to the bottom rows of the frame`,
		);

		tui.stop();
	});

	it("INV-2: Implementation source files SHALL NOT import the contract module", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: Architecture & DbC isolation
		 * - Enforces: INV-2: implementation SHALL NOT import this contract module
		 * - Category: invariant / architecture
		 * - Risk tier: High — implementation importing contract introduces illegal cyclic dependency
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause INV-2 existing in contracts/pinned-jitter-copy.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: static analysis gate checking all relevant production source files
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		const filesToCheck = [
			resolve(__dirname, "../src/tui.ts"),
			resolve(__dirname, "../src/mouse.ts"),
			resolve(__dirname, "../src/pinned-viewport.ts"),
			resolve(__dirname, "../../coding-agent/src/modes/composer.ts"),
		];

		const forbiddenImportPattern = /pinned-jitter-copy\.contract/;

		for (const file of filesToCheck) {
			const content = readFileSync(file, "utf8");
			const hasForbiddenImport = forbiddenImportPattern.test(content);

			expect(hasForbiddenImport).toBe(
				false,
				`1. WHAT: test_forbidden_contract_import FAILED in ${file}\n2. WHY: INV-2 violation - implementation file imports contract module\n3. EXPECTED: no import matching /pinned-jitter-copy\\.contract/\n4. ACTUAL: forbidden import found in ${file}\n5. GUIDANCE: Remove contract imports from implementation; tests serve as the bridge`,
			);
		}
	});

	it("PRE-1 / ERRORS-1: validateSgrMouseStream contract validator error behaviors", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: validateSgrMouseStream()
		 * - Enforces: PRE-1: SGR mouse stream parse input SHALL be a string
		 * - Enforces: ERRORS-1: validateSgrMouseStream SHALL throw PinnedJitterCopyContractError citing PRE-1 when the input is not a string; a string with no SGR reports SHALL return an empty list
		 * - Category: error / contract-verification
		 * - Risk tier: Medium — invalid stream inputs must fail with clear contract citation
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clauses PRE-1 and ERRORS-1 existing in contracts/pinned-jitter-copy.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: validates precondition enforcement and error dispatch
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		for (const nonString of [null, undefined, 123, {}, []]) {
			let caught: unknown;
			try {
				validateSgrMouseStream(nonString);
			} catch (e) {
				caught = e;
			}
			expect(caught instanceof PinnedJitterCopyContractError).toBe(
				true,
				`1. WHAT: test_validate_sgr_pre1_type FAILED for ${String(nonString)}\n2. WHY: ERRORS-1 violation - validateSgrMouseStream must throw PinnedJitterCopyContractError on non-string input\n3. EXPECTED: PinnedJitterCopyContractError instance\n4. ACTUAL: ${String(caught)}\n5. GUIDANCE: Validate that input is string before parsing SGR stream`,
			);
			expect((caught as PinnedJitterCopyContractError).clauseId).toBe(
				"PRE-1",
				`1. WHAT: test_validate_sgr_pre1_clause_id FAILED\n2. WHY: ERRORS-1 violation - exception must cite PRE-1\n3. EXPECTED: PRE-1\n4. ACTUAL: ${(caught as PinnedJitterCopyContractError).clauseId}\n5. GUIDANCE: Cite PRE-1 on contract error`,
			);
		}

		const emptyResult = validateSgrMouseStream("plain text with no SGR reports");
		expect(emptyResult).toEqual(
			[],
			`1. WHAT: test_validate_sgr_empty_result FAILED\n2. WHY: ERRORS-1 violation - string with no SGR reports must return empty list\n3. EXPECTED: []\n4. ACTUAL: ${JSON.stringify(emptyResult)}\n5. GUIDANCE: Return empty array when no SGR patterns match in string`,
		);

		expect(parseSgrMouseStream("plain text with no SGR reports")).toEqual(
			[],
			`1. WHAT: test_parseSgrMouseStream_empty FAILED\n2. WHY: ERRORS-1 - mouse.ts stream parse must return [] when no reports exist\n3. EXPECTED: []\n4. ACTUAL: ${JSON.stringify(parseSgrMouseStream("plain text with no SGR reports"))}\n5. GUIDANCE: Production parser returns empty list, not an exception`,
		);
		expect(parseSgrMouseStream("\x1b[<64;10;5M\x1b[<65;10;5M").length).toBe(
			2,
			`1. WHAT: test_parseSgrMouseStream_concat FAILED\n2. WHY: POST-1 - mouse.ts must extract both reports\n3. EXPECTED: 2\n4. ACTUAL: ${parseSgrMouseStream("\x1b[<64;10;5M\x1b[<65;10;5M").length}\n5. GUIDANCE: Stream-parse concatenated SGR in mouse.ts`,
		);
		const asUnknown = parseSgrMouseStream as (data: unknown) => unknown;
		expect(asUnknown(null)).toEqual(
			[],
			`1. WHAT: test_parseSgrMouseStream_non_string FAILED\n2. WHY: PRE-1 - mouse.ts must not throw on non-string\n3. EXPECTED: []\n4. ACTUAL: ${JSON.stringify(asUnknown(null))}\n5. GUIDANCE: Guard typeof data before parsing`,
		);
	});
});
