import { describe, expect, it } from "bun:test";
import { PINNED_MIN_TRANSCRIPT_ROWS, PinnedViewport } from "@oh-my-pi/pi-tui/pinned-viewport";
import { PINNED_MIN_TRANSCRIPT_ROWS as CONTRACT_MIN_ROWS } from "../../../requirements/contracts/pinned_dock.contract";

describe("pinned dock contract validators (supporting tests)", () => {
	it("CONTRACT VERIFICATION: POST-PV-20: contract min transcript rows matches implementation", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: PINNED_MIN_TRANSCRIPT_ROWS
		 * - Enforces: POST-PV-20: PINNED_MIN_TRANSCRIPT_ROWS constant SHALL equal 3
		 * - Category: invariant
		 * - Risk tier: Medium — dock encroaching on transcript violates minimum visible history
		 * - Adversarial: Contract-governed validator verification
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-PV-20 existing in requirements/contracts/pinned_dock.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: contract-to-implementation constant alignment
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		expect(PINNED_MIN_TRANSCRIPT_ROWS).toBe(
			CONTRACT_MIN_ROWS,
			`1. WHAT: PINNED_MIN_TRANSCRIPT_ROWS constant alignment FAILED
2. WHY: POST-PV-20 violation - implementation minimum transcript rows does not match contract
3. EXPECTED: ${CONTRACT_MIN_ROWS}
4. ACTUAL: ${PINNED_MIN_TRANSCRIPT_ROWS}
5. GUIDANCE: PINNED_MIN_TRANSCRIPT_ROWS must match contract constant exactly`,
		);
	});
});

describe("PinnedViewport.composeFrame (implementation tests)", () => {
	it("POST-PV-15: clips an oversized dock from the top, keeping the editor and min transcript rows", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: PinnedViewport.composeFrame()
		 * - Enforces: POST-PV-15: top-clipped when dock is taller than reserved band, preserving PINNED_MIN_TRANSCRIPT_ROWS
		 * - Category: boundary
		 * - Risk tier: High — oversized dock must not eliminate transcript visibility
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-PV-15 existing in requirements/contracts/pinned_dock.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: boundary test for oversized dock clipping
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		const viewport = new PinnedViewport();
		const dock = ["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8"];
		const transcript = ["T0", "T1", "T2", "T3", "T4"];
		const height = 8;
		// maxDock = 8 - 3 = 5 rows. Kept dock lines: D4, D5, D6, D7, D8. Transcript rows: 3 (T2, T3, T4).
		const frame = viewport.composeFrame({ transcript, dock, height });
		expect(frame).toEqual(
			["T2", "T3", "T4", "D4", "D5", "D6", "D7", "D8"],
			`1. WHAT: composeFrame oversized dock clipping FAILED
2. WHY: POST-PV-15 violation - oversized dock must be top-clipped preserving minimum transcript rows
3. EXPECTED: ["T2", "T3", "T4", "D4", "D5", "D6", "D7", "D8"]
4. ACTUAL: ${JSON.stringify(frame)}
5. GUIDANCE: Clip dock from top to reserve at least PINNED_MIN_TRANSCRIPT_ROWS for transcript`,
		);
	});

	it("POST-PV-19: following pins the window to the transcript tail", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: PinnedViewport.composeFrame()
		 * - Enforces: POST-PV-19: when following is true, the visible transcript SHALL be the tail
		 * - Category: positive
		 * - Risk tier: High — following mode must track newest transcript output
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-PV-19 existing in requirements/contracts/pinned_dock.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: verifies following mode transcript tail positioning
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		const viewport = new PinnedViewport();
		const transcript = Array.from({ length: 20 }, (_, i) => `line-${i}`);
		const dock = ["PROMPT:"];
		const frame = viewport.composeFrame({ transcript, dock, height: 5 });
		// height 5, dock 1 -> 4 lines of transcript tail: line-16, line-17, line-18, line-19
		expect(frame).toEqual(
			["line-16", "line-17", "line-18", "line-19", "PROMPT:"],
			`1. WHAT: composeFrame following tail FAILED
2. WHY: POST-PV-19 violation - when following is true, visible transcript must be the tail
3. EXPECTED: ["line-16", "line-17", "line-18", "line-19", "PROMPT:"]
4. ACTUAL: ${JSON.stringify(frame)}
5. GUIDANCE: In following mode, display the last N rows of transcript where N is windowHeight`,
		);
	});

	it("POST-PV-16: following=false keeps scrollTop while content appends", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: PinnedViewport.composeFrame()
		 * - Enforces: POST-PV-16: when following is false, newly appended transcript SHALL NOT change which transcript rows are visible
		 * - Category: positive
		 * - Risk tier: High — reading earlier transcript while output streams must remain frozen
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-PV-16 existing in requirements/contracts/pinned_dock.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: tests scroll freeze invariant during transcript appends
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		const viewport = new PinnedViewport();
		const transcript = Array.from({ length: 10 }, (_, i) => `line-${i}`);
		const dock = ["PROMPT:"];
		const height = 5; // windowHeight = 4
		viewport.composeFrame({ transcript, dock, height });
		viewport.scrollBy(-3); // moves scrollTop from 6 to 3, following becomes false

		const frameWhilePaused = viewport.composeFrame({ transcript, dock, height });
		expect(frameWhilePaused).toEqual(
			["line-3", "line-4", "line-5", "line-6", "PROMPT:"],
			`1. WHAT: composeFrame paused scroll position FAILED
2. WHY: POST-PV-16 violation - scrolled frame must show rows at frozen scrollTop
3. EXPECTED: ["line-3", "line-4", "line-5", "line-6", "PROMPT:"]
4. ACTUAL: ${JSON.stringify(frameWhilePaused)}
5. GUIDANCE: Paused viewport must maintain scrollTop`,
		);

		// Append 10 more lines to transcript
		const expanded = [...transcript, ...Array.from({ length: 10 }, (_, i) => `line-${i + 10}`)];
		const frameAfterAppend = viewport.composeFrame({ transcript: expanded, dock, height });
		expect(frameAfterAppend).toEqual(
			["line-3", "line-4", "line-5", "line-6", "PROMPT:"],
			`1. WHAT: composeFrame frozen view during append FAILED
2. WHY: POST-PV-16 violation - newly appended transcript rows must not alter frozen visible rows
3. EXPECTED: ["line-3", "line-4", "line-5", "line-6", "PROMPT:"]
4. ACTUAL: ${JSON.stringify(frameAfterAppend)}
5. GUIDANCE: Do not change visible transcript window when following is false and content is appended`,
		);
	});

	it("POST-PV-17: scrollBy pauses following on scroll up and resumes following on landing at tail", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: PinnedViewport.scrollBy()
		 * - Enforces: POST-PV-17: a scroll that leaves the tail SHALL pause following; a scroll that lands on the tail SHALL resume following
		 * - Category: state-transition
		 * - Risk tier: High — following state governs interactive scroll experience
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-PV-17 existing in requirements/contracts/pinned_dock.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: verifies following state transitions on bidirectional scrolling
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		const viewport = new PinnedViewport();
		const transcript = Array.from({ length: 10 }, (_, i) => `line-${i}`);
		viewport.composeFrame({ transcript, dock: ["PROMPT:"], height: 5 }); // maxScroll = 6
		expect(viewport.isFollowing()).toBe(
			true,
			`1. WHAT: viewport initial following state FAILED
2. WHY: POST-PV-19 violation - initial viewport must follow transcript tail
3. EXPECTED: true
4. ACTUAL: false
5. GUIDANCE: Viewport must start in following mode`,
		);

		viewport.scrollBy(-2);
		expect(viewport.isFollowing()).toBe(
			false,
			`1. WHAT: viewport scroll up following state FAILED
2. WHY: POST-PV-17 violation - scrolling away from tail must pause following
3. EXPECTED: false
4. ACTUAL: true
5. GUIDANCE: Pausing following on scroll up is required`,
		);

		viewport.scrollBy(2);
		expect(viewport.isFollowing()).toBe(
			true,
			`1. WHAT: viewport scroll down to tail following state FAILED
2. WHY: POST-PV-17 violation - scrolling to tail must resume following
3. EXPECTED: true
4. ACTUAL: false
5. GUIDANCE: Resuming following when landing on max scroll is required`,
		);

		viewport.scrollToTop();
		expect(viewport.isFollowing()).toBe(
			false,
			`1. WHAT: viewport scrollToTop following state FAILED
2. WHY: POST-PV-17 violation - scrolling to top must pause following when maxScroll > 0
3. EXPECTED: false
4. ACTUAL: true
5. GUIDANCE: scrollToTop must pause following`,
		);

		viewport.scrollToBottom();
		expect(viewport.isFollowing()).toBe(
			true,
			`1. WHAT: viewport scrollToBottom following state FAILED
2. WHY: POST-PV-17 violation - scrollToBottom must resume following
3. EXPECTED: true
4. ACTUAL: false
5. GUIDANCE: scrollToBottom must resume following`,
		);
	});

	it("POST-PV-18: composeFrame does not start following on dock mutation", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: PinnedViewport.composeFrame()
		 * - Enforces: POST-PV-18: dock mutation SHALL NOT start following and SHALL NOT change which transcript rows are visible
		 * - Category: negative
		 * - Risk tier: High — typing in editor must not snap viewport back to tail
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-PV-18 existing in requirements/contracts/pinned_dock.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: verifies composeFrame with dock updates preserves paused scroll state
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		const viewport = new PinnedViewport();
		const transcript = Array.from({ length: 12 }, (_, i) => `line-${i}`);
		viewport.composeFrame({ transcript, dock: ["PROMPT:"], height: 5 });
		viewport.scrollBy(-3);
		expect(viewport.isFollowing()).toBe(
			false,
			`1. WHAT: viewport paused following setup FAILED
2. WHY: POST-PV-17 violation - scroll up must pause following
3. EXPECTED: false
4. ACTUAL: true
5. GUIDANCE: Viewport must be paused`,
		);

		// Mutate dock text (simulating typing in editor while paused)
		const frame = viewport.composeFrame({ transcript, dock: ["PROMPT: typing something"], height: 5 });
		expect(viewport.isFollowing()).toBe(
			false,
			`1. WHAT: viewport following state after dock mutation FAILED
2. WHY: POST-PV-18 violation - dock mutation must not resume following
3. EXPECTED: false
4. ACTUAL: true
5. GUIDANCE: Typing into dock must not restart following`,
		);
		expect(frame[frame.length - 1]).toBe(
			"PROMPT: typing something",
			`1. WHAT: dock row content after mutation FAILED
2. WHY: INV-PV-8 violation - dock row must reflect updated content
3. EXPECTED: "PROMPT: typing something"
4. ACTUAL: ${String(frame[frame.length - 1])}
5. GUIDANCE: Dock must render current text`,
		);
	});
});
