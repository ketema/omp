import { describe, expect, it } from "bun:test";
import { clippedPinnedDockHeight, PINNED_MIN_TRANSCRIPT_ROWS, PinnedViewport } from "@oh-my-pi/pi-tui/pinned-viewport";
import {
	PINNED_MIN_TRANSCRIPT_ROWS as CONTRACT_MIN_ROWS,
	CONTRACT_PINNED_COMPOSER,
	clippedPinnedDockHeight as contractClip,
	PinnedComposerContractError,
	validateComposeHeight,
} from "../../../requirements/contracts/pinned-composer.contract";

describe("pinned composer contract validators (supporting tests)", () => {
	it("CONTRACT VERIFICATION: ERRORS-1 / PRE-1: rejects non-positive or non-finite compose height", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: validateComposeHeight()
		 * - Enforces: ERRORS-1 / PRE-1: validateComposeHeight SHALL throw PinnedComposerContractError citing PRE-1
		 * - Category: error
		 * - Risk tier: Medium — invalid height calculation causes layout failure
		 * - Adversarial: Contract-governed validator verification
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause ERRORS-1 and PRE-1 existing in contracts/pinned-composer.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: contract runtime validator verification
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		for (const invalid of [0, -1, -100, Number.NaN, Number.POSITIVE_INFINITY, "10" as unknown as number]) {
			let caught: unknown;
			try {
				validateComposeHeight(invalid);
			} catch (err) {
				caught = err;
			}
			expect(caught instanceof PinnedComposerContractError).toBe(
				true,
				`1. WHAT: validateComposeHeight(${String(invalid)}) FAILED
2. WHY: ERRORS-1 / PRE-1 violation - validateComposeHeight must throw PinnedComposerContractError
3. EXPECTED: instance of PinnedComposerContractError
4. ACTUAL: ${String(caught)}
5. GUIDANCE: composeFrame height must be validated as a finite number >= 1`,
			);
			if (caught instanceof PinnedComposerContractError) {
				expect(caught.clauseId).toBe(
					"PRE-1",
					`1. WHAT: validateComposeHeight(${String(invalid)}) clauseId mismatch
2. WHY: ERRORS-1 violation - clauseId must cite PRE-1
3. EXPECTED: 'PRE-1'
4. ACTUAL: '${caught.clauseId}'
5. GUIDANCE: Error must cite clause ID PRE-1`,
				);
			}
		}
	});

	it("CONTRACT VERIFICATION: POST-3: contract min transcript rows matches implementation", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: clippedPinnedDockHeight()
		 * - Enforces: POST-3: when height allows, at least PINNED_MIN_TRANSCRIPT_ROWS of the frame SHALL be transcript
		 * - Category: invariant
		 * - Risk tier: Medium — dock encroaching on transcript violates minimum visible history
		 * - Adversarial: Contract-governed validator verification
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-3 existing in contracts/pinned-composer.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: contract-to-implementation constant alignment
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		expect(PINNED_MIN_TRANSCRIPT_ROWS).toBe(
			CONTRACT_MIN_ROWS,
			`1. WHAT: PINNED_MIN_TRANSCRIPT_ROWS constant alignment FAILED
2. WHY: POST-3 violation - implementation minimum transcript rows does not match contract
3. EXPECTED: ${CONTRACT_MIN_ROWS}
4. ACTUAL: ${PINNED_MIN_TRANSCRIPT_ROWS}
5. GUIDANCE: PINNED_MIN_TRANSCRIPT_ROWS must match contract constant exactly`,
		);

		for (const [dock, height] of [
			[0, 10],
			[2, 10],
			[7, 10],
			[8, 10],
			[20, 10],
			[5, 2],
		] as const) {
			const implResult = clippedPinnedDockHeight(dock, height);
			const contractResult = contractClip(dock, height);
			expect(implResult).toBe(
				contractResult,
				`1. WHAT: clippedPinnedDockHeight(${dock}, ${height}) FAILED
2. WHY: POST-3 violation - dock clipping calculation diverged from contract
3. EXPECTED: ${contractResult}
4. ACTUAL: ${implResult}
5. GUIDANCE: Dock must be clipped to leave at least PINNED_MIN_TRANSCRIPT_ROWS when height allows`,
			);
		}
	});
});

describe("PinnedViewport.composeFrame (implementation tests)", () => {
	it("PRE-1 / ERRORS-1: composeFrame throws with clause id on invalid height", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: PinnedViewport.composeFrame()
		 * - Enforces: PRE-1 / ERRORS-1: composeFrame height SHALL be a finite number >= 1; PinnedViewport.composeFrame SHALL throw Error whose message contains PRE-1
		 * - Category: error
		 * - Risk tier: Medium — invalid height corrupts frame layout
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause PRE-1 / ERRORS-1 existing in contracts/pinned-composer.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: primary check for composeFrame precondition enforcement at implementation boundary
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		const viewport = new PinnedViewport();
		for (const invalid of [0, -1, Number.NaN, Number.NEGATIVE_INFINITY]) {
			let caught: unknown;
			try {
				viewport.composeFrame({ transcript: [], dock: [], height: invalid });
			} catch (err) {
				caught = err;
			}
			expect(caught instanceof Error).toBe(
				true,
				`1. WHAT: composeFrame with height=${String(invalid)} FAILED
2. WHY: PRE-1 / ERRORS-1 violation - composeFrame must throw Error on height < 1
3. EXPECTED: Error thrown
4. ACTUAL: ${String(caught)}
5. GUIDANCE: Throw an Error when height is not a finite number >= 1`,
			);
			if (caught instanceof Error) {
				expect(caught.message).toContain(
					"PRE-1",
					`1. WHAT: composeFrame error message citation FAILED
2. WHY: ERRORS-1 violation - Error message must cite PRE-1
3. EXPECTED: message containing 'PRE-1'
4. ACTUAL: '${caught.message}'
5. GUIDANCE: Error message must include clause ID PRE-1`,
				);
			}
		}
	});

	it("POST-1: returns a frame whose length equals height", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: PinnedViewport.composeFrame()
		 * - Enforces: POST-1: composeFrame SHALL return a frame whose length equals height
		 * - Category: positive
		 * - Risk tier: High — terminal height mismatch corrupts physical display
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-1 existing in contracts/pinned-composer.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: exact length invariant across multiple height partitions
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		const viewport = new PinnedViewport();
		for (const height of [1, 3, 8, 24]) {
			const frame = viewport.composeFrame({
				transcript: ["line 1", "line 2", "line 3", "line 4", "line 5"],
				dock: ["dock 1", "dock 2"],
				height,
			});
			expect(frame.length).toBe(
				height,
				`1. WHAT: composeFrame frame length FAILED
2. WHY: POST-1 violation - returned frame length must equal height
3. EXPECTED: ${height}
4. ACTUAL: ${frame.length}
5. GUIDANCE: Return an array with length equal to requested height`,
			);
		}
	});

	it("POST-2 / INV-1: dock occupies the last dockHeight rows", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: PinnedViewport.composeFrame()
		 * - Enforces: POST-2 / INV-1: the last dockHeight rows of the returned frame SHALL equal the dock
		 * - Category: positive
		 * - Risk tier: High — prompt box must remain pinned to the bottom
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-2 and INV-1 existing in contracts/pinned-composer.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: tests dock placement on the bottom rows of composed frame
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		const viewport = new PinnedViewport();
		const dock = ["PROMPT: input", "STATUS: ok"];
		const frame = viewport.composeFrame({
			transcript: ["T1", "T2", "T3", "T4"],
			dock,
			height: 6,
		});
		expect(frame.length).toBe(
			6,
			`1. WHAT: composeFrame height FAILED
2. WHY: POST-1 violation - frame length must equal height
3. EXPECTED: 6
4. ACTUAL: ${frame.length}
5. GUIDANCE: Ensure frame length matches height`,
		);
		const lastRows = frame.slice(frame.length - dock.length);
		expect(lastRows).toEqual(
			dock,
			`1. WHAT: composeFrame dock rows FAILED
2. WHY: POST-2 / INV-1 violation - last dockHeight rows must match dock exactly
3. EXPECTED: ${JSON.stringify(dock)}
4. ACTUAL: ${JSON.stringify(lastRows)}
5. GUIDANCE: Dock must occupy the bottom rows of the composed frame`,
		);
	});

	it("POST-2 / POST-3: clips an oversized dock from the top, keeping the editor and min transcript rows", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: PinnedViewport.composeFrame()
		 * - Enforces: POST-2 / POST-3: top-clipped when dock is taller than reserved band, preserving PINNED_MIN_TRANSCRIPT_ROWS
		 * - Category: boundary
		 * - Risk tier: High — oversized dock must not eliminate transcript visibility
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-2 and POST-3 existing in contracts/pinned-composer.contract.ts
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
2. WHY: POST-2 / POST-3 violation - oversized dock must be top-clipped preserving minimum transcript rows
3. EXPECTED: ["T2", "T3", "T4", "D4", "D5", "D6", "D7", "D8"]
4. ACTUAL: ${JSON.stringify(frame)}
5. GUIDANCE: Clip dock from top to reserve at least PINNED_MIN_TRANSCRIPT_ROWS for transcript`,
		);
	});

	it("POST-4: following pins the window to the transcript tail", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: PinnedViewport.composeFrame()
		 * - Enforces: POST-4: when following is true, the visible transcript SHALL be the tail
		 * - Category: positive
		 * - Risk tier: High — following mode must track newest transcript output
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-4 existing in contracts/pinned-composer.contract.ts
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
2. WHY: POST-4 violation - when following is true, visible transcript must be the tail
3. EXPECTED: ["line-16", "line-17", "line-18", "line-19", "PROMPT:"]
4. ACTUAL: ${JSON.stringify(frame)}
5. GUIDANCE: In following mode, display the last N rows of transcript where N is windowHeight`,
		);
	});

	it("POST-5: following=false keeps scrollTop while content appends", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: PinnedViewport.composeFrame()
		 * - Enforces: POST-5: when following is false, newly appended transcript SHALL NOT change which transcript rows are visible
		 * - Category: positive
		 * - Risk tier: High — reading earlier transcript while output streams must remain frozen
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-5 existing in contracts/pinned-composer.contract.ts
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
2. WHY: POST-5 violation - scrolled frame must show rows at frozen scrollTop
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
2. WHY: POST-5 violation - newly appended transcript rows must not alter frozen visible rows
3. EXPECTED: ["line-3", "line-4", "line-5", "line-6", "PROMPT:"]
4. ACTUAL: ${JSON.stringify(frameAfterAppend)}
5. GUIDANCE: Do not change visible transcript window when following is false and content is appended`,
		);
	});

	it("POST-6: scrollBy pauses following on scroll up and resumes following on landing at tail", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: PinnedViewport.scrollBy()
		 * - Enforces: POST-6: a scroll that leaves the tail SHALL pause following; a scroll that lands on the tail SHALL resume following
		 * - Category: state-transition
		 * - Risk tier: High — following state governs interactive scroll experience
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-6 existing in contracts/pinned-composer.contract.ts
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
2. WHY: POST-4 violation - initial viewport must follow transcript tail
3. EXPECTED: true
4. ACTUAL: false
5. GUIDANCE: Viewport must start in following mode`,
		);

		viewport.scrollBy(-2);
		expect(viewport.isFollowing()).toBe(
			false,
			`1. WHAT: viewport scroll up following state FAILED
2. WHY: POST-6 violation - scrolling away from tail must pause following
3. EXPECTED: false
4. ACTUAL: true
5. GUIDANCE: Pausing following on scroll up is required`,
		);

		viewport.scrollBy(2);
		expect(viewport.isFollowing()).toBe(
			true,
			`1. WHAT: viewport scroll down to tail following state FAILED
2. WHY: POST-6 violation - scrolling to tail must resume following
3. EXPECTED: true
4. ACTUAL: false
5. GUIDANCE: Resuming following when landing on max scroll is required`,
		);

		viewport.scrollToTop();
		expect(viewport.isFollowing()).toBe(
			false,
			`1. WHAT: viewport scrollToTop following state FAILED
2. WHY: POST-6 violation - scrolling to top must pause following when maxScroll > 0
3. EXPECTED: false
4. ACTUAL: true
5. GUIDANCE: scrollToTop must pause following`,
		);

		viewport.scrollToBottom();
		expect(viewport.isFollowing()).toBe(
			true,
			`1. WHAT: viewport scrollToBottom following state FAILED
2. WHY: POST-6 violation - scrollToBottom must resume following
3. EXPECTED: true
4. ACTUAL: false
5. GUIDANCE: scrollToBottom must resume following`,
		);
	});

	it("POST-7: composeFrame does not start following on dock mutation", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: PinnedViewport.composeFrame()
		 * - Enforces: POST-7: printable editor input SHALL NOT start following and SHALL NOT change which transcript rows are visible
		 * - Category: negative
		 * - Risk tier: High — typing in editor must not snap viewport back to tail
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-7 existing in contracts/pinned-composer.contract.ts
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
2. WHY: POST-6 violation - scroll up must pause following
3. EXPECTED: false
4. ACTUAL: true
5. GUIDANCE: Viewport must be paused`,
		);

		// Mutate dock text (simulating typing in editor while paused)
		const frame = viewport.composeFrame({ transcript, dock: ["PROMPT: typing something"], height: 5 });
		expect(viewport.isFollowing()).toBe(
			false,
			`1. WHAT: viewport following state after dock mutation FAILED
2. WHY: POST-7 violation - dock mutation must not resume following
3. EXPECTED: false
4. ACTUAL: true
5. GUIDANCE: Typing into dock must not restart following`,
		);
		expect(frame[frame.length - 1]).toBe(
			"PROMPT: typing something",
			`1. WHAT: dock row content after mutation FAILED
2. WHY: POST-2 violation - dock row must reflect updated content
3. EXPECTED: "PROMPT: typing something"
4. ACTUAL: ${String(frame[frame.length - 1])}
5. GUIDANCE: Dock must render current text`,
		);
	});
});

describe("contract clause map alignment", () => {
	it("CONTRACT TRACEABILITY: every contract clause is declared with test verification", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: CONTRACT_PINNED_COMPOSER
		 * - Enforces: Contract completeness & registry alignment
		 * - Category: property
		 * - Risk tier: Low — metadata verification
		 * - Adversarial: Contract-governed
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites all clauses in CONTRACT_PINNED_COMPOSER
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO
		 *   [✓] C3 NON-DUPLICATIVE: ensures test registry completeness against contract object
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		const clauses = Object.keys(CONTRACT_PINNED_COMPOSER);
		expect(clauses.length).toBeGreaterThan(0);
		for (const clauseId of clauses) {
			const clause = CONTRACT_PINNED_COMPOSER[clauseId as keyof typeof CONTRACT_PINNED_COMPOSER];
			expect(clause.verification).toBe(
				"test",
				`1. WHAT: clause verification type for ${clauseId} FAILED
2. WHY: Contract completeness violation - clause must specify verification: 'test'
3. EXPECTED: 'test'
4. ACTUAL: '${clause.verification}'
5. GUIDANCE: All pinned-composer clauses must be verifiable by tests`,
			);
		}
	});
});
