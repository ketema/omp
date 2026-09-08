import { describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type Component, Text } from "@oh-my-pi/pi-tui";
import { CONTRACT_PINNED_DOCK } from "../../../requirements/contracts/pinned_dock.contract";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const postPv2 = CONTRACT_PINNED_DOCK["POST-PV-2"];
const postPv7 = CONTRACT_PINNED_DOCK["POST-PV-7"];
const seqPv4 = CONTRACT_PINNED_DOCK["SEQ-PV-4"];
const invPv7 = CONTRACT_PINNED_DOCK["INV-PV-7"];

/**
 * Spy component: counts render() invocations to prove whether a settled
 * transcript block is cached across interactive frames or recomputed on
 * every call.
 *
 * Double type: Spy.
 * Contract: requirements/contracts/pinned_dock.contract.ts SEQ-PV-4.
 */
class RenderCountingBlock implements Component {
	renderCount = 0;

	constructor(private readonly lines: readonly string[]) {}

	render(_width: number): readonly string[] {
		this.renderCount++;
		return this.lines;
	}
}

describe("pinned dock refactor — SLICE-2 full scrollback, settled-block caching, and header retirement", () => {
	it("POST-PV-2 / INV-PV-1 / SEQ-PV-4: provides all session history to the pinned viewport and scrolls back to its first row", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: Composer.renderFrame() -> TUI -> PinnedViewport.composeFrame().
		 * - Enforces: POST-PV-2: PinnedViewport.composeFrame SHALL preserve full transcript lines in software history, allowing scrollTop to index previous session output.
		 * - Enforces: INV-PV-1 / SEQ-PV-4: Composer SHALL provide full accumulated transcript history on every interactive frame rather than truncate it to the visible window.
		 * - Category: integration
		 * - Test pyramid: Integration
		 * - Risk tier: High — truncating history produces maxScroll = 0 and makes prior session output unreachable.
		 * - Adversarial: Contract-governed, implementation-aware.
		 *
		 * SEQ_TEST_SELF_CHECK:
		 *   [✓] Constructs Composer through start(), mounts a real TranscriptContainer, and exercises the TUI render lifecycle.
		 *   [✓] Verifies the Composer-to-PinnedViewport handoff and a user-observable scroll result.
		 *   [✓] Does not call an internal renderer or mutate post-construction dependencies.
		 *   [✓] Uses real Text and TranscriptContainer components, not fabricated transcript behavior.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-2, INV-PV-1, and SEQ-PV-4 in requirements/contracts/pinned_dock.contract.ts.
		 *   [✓] C2 VALUABLE: a viewport-size slice makes optionsTranscript incomplete and leaves the first session row unreachable after scrolling.
		 *   [✓] C3 NON-DUPLICATIVE: validates the current contract's complete Composer-to-PinnedViewport history handoff; a legacy bounded-scroll test encodes the superseded opposite rule.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the explicit current full-software-scrollback guarantee.
		 */
		await initTheme();
		const terminal = new VirtualTerminal(80, 10, 100);
		const transcriptRows = Array.from({ length: 12 }, (_, index) => `SESSION_ROW_${String(index).padStart(2, "0")}`);
		const transcript = new TranscriptContainer();
		transcript.addChild(new Text(transcriptRows.join("\n"), 0, 0));
		const fullTranscriptRows = [...transcript.render(80)];
		const composer = new Composer({
			terminal,
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});

		try {
			composer.start({ playWelcomeIntro: false });
			composer.setRuntimeChildren([transcript, composer.editor]);
			await terminal.waitForRender();

			const plan = composer.renderFrame({ columns: 80, rows: 10 });
			composer.ui.scrollPinnedBy(-transcriptRows.length);
			await terminal.waitForRender();
			const observed = {
				optionsTranscript: plan.pinnedScroll ?? [],
				earliestVisibleRow: terminal.getViewport()[0]?.trim(),
			};

			expect(
				observed,
				`1. WHAT: test_post_pv_2_preserves_full_composer_history FAILED
2. WHY: POST-PV-2 / INV-PV-1 / SEQ-PV-4 violation - ${postPv2.description}; ${seqPv4.description}
3. EXPECTED: optionsTranscript contains every session row and a scroll-up reaches ${JSON.stringify(transcriptRows[0])}
4. ACTUAL: ${JSON.stringify(observed)}
5. GUIDANCE: Supply the full accumulated transcript to the pinned viewport so previous session output remains scrollable`,
			).toEqual({
				optionsTranscript: fullTranscriptRows,
				earliestVisibleRow: fullTranscriptRows[0]?.trim(),
			});
		} finally {
			composer.stop();
		}
	});

	it("SEQ-PV-4: caches a settled transcript block instead of re-rendering it on every interactive frame", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: TranscriptContainer.render() (invoked from Composer.renderFrame() in pinned mode).
		 * - Enforces: SEQ-PV-4: Composer.renderFrame SHALL provide the full accumulated transcript history to
		 *   PinnedViewport on every interactive frame, caching settled blocks.
		 * - Category: integration / performance
		 * - Test pyramid: Integration
		 * - Risk tier: Medium — uncached full-history re-render on every frame degrades interactively with long sessions.
		 * - Adversarial: Contract-governed, implementation-aware. Uses a render-counting spy block mounted
		 *   directly into a real TranscriptContainer, driven through Composer.renderFrame() (the real,
		 *   documented per-frame entry point), not a fabricated caching hook.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites SEQ-PV-4 in requirements/contracts/pinned_dock.contract.ts.
		 *   [✓] C2 VALUABLE: TranscriptContainer.render() currently calls every entry's render() unconditionally
		 *       on every invocation with no state-based short-circuit, so three additional frames necessarily
		 *       increase the spy's render count by three.
		 *   [✓] C3 NON-DUPLICATIVE: the POST-PV-2 test above asserts row *completeness*; this test asserts the
		 *       distinct *caching* half of the same SEQ-PV-4 clause via an unrelated observable (call count).
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit "caching settled blocks" clause text.
		 */
		await initTheme();
		const terminal = new VirtualTerminal(80, 10, 100);
		const settledBlock = new RenderCountingBlock(["SETTLED_BLOCK_ROW"]);
		const transcript = new TranscriptContainer();
		transcript.addChild(settledBlock);
		const composer = new Composer({
			terminal,
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});

		try {
			composer.start({ playWelcomeIntro: false });
			composer.setRuntimeChildren([transcript, composer.editor]);
			await terminal.waitForRender();

			const rendersAfterFirstFrame = settledBlock.renderCount;
			expect(
				rendersAfterFirstFrame > 0,
				`1. WHAT: test_seq_pv_4_first_frame_renders_block FAILED (test setup sanity)
2. WHY: SEQ-PV-4 violation - ${seqPv4.description}
3. EXPECTED: settled block render() called at least once by the first interactive frame
4. ACTUAL: renderCount=${rendersAfterFirstFrame}
5. GUIDANCE: Composer.renderFrame in pinned mode must render every mounted transcript block at least once`,
			).toBe(true);

			composer.renderFrame({ columns: 80, rows: 10 });
			composer.renderFrame({ columns: 80, rows: 10 });
			composer.renderFrame({ columns: 80, rows: 10 });

			expect(
				settledBlock.renderCount,
				`1. WHAT: test_seq_pv_4_caches_settled_blocks FAILED
2. WHY: SEQ-PV-4 violation - ${seqPv4.description}
3. EXPECTED: settled block render() call count stays at ${rendersAfterFirstFrame} across 3 additional unchanged frames (cached)
4. ACTUAL: settled block render() call count grew to ${settledBlock.renderCount}
5. GUIDANCE: Cache each settled block's rendered rows and reuse them on subsequent frames instead of calling render() again when its content has not changed`,
			).toBe(rendersAfterFirstFrame);
		} finally {
			composer.stop();
		}
	});

	it("POST-PV-7: retires startup header pressure so active session messages retain transcript rows", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: Composer.renderFrame().
		 * - Enforces: POST-PV-7: Composer pinned renderFrame SHALL NOT permanently consume available viewport rows with unretired startup headers when active session messages exist.
		 * - Enforces: DM-2: startup header retirement shall not reduce available transcript rows to zero.
		 * - Category: integration / regression
		 * - Test pyramid: Integration
		 * - Risk tier: High — a permanent header can hide all interactive output on a fixed-height terminal.
		 * - Adversarial: Contract-governed, implementation-aware.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-7 in requirements/contracts/pinned_dock.contract.ts; DM-2 is supporting requirement traceability.
		 *   [✓] C2 VALUABLE: retaining header rows until no transcript capacity remains removes both exact active message rows and fails the assertion.
		 *   [✓] C3 NON-DUPLICATIVE: exercises header pressure plus active interactive content, an observable not covered by the full-history handoff test.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current contracted retirement requirement.
		 */
		await initTheme();
		const terminal = new VirtualTerminal(80, 10, 100);
		const startupHeaderRows = Array.from(
			{ length: 12 },
			(_, index) => `STARTUP_HEADER_${String(index).padStart(2, "0")}`,
		);
		const activeSessionRows = ["ACTIVE_SESSION_MESSAGE_ONE", "ACTIVE_SESSION_MESSAGE_TWO"];
		const transcript = new TranscriptContainer();
		transcript.addChild(new Text(activeSessionRows.join("\n"), 0, 0));
		const composer = new Composer({
			terminal,
			preferences: { ...COMPOSER_DEFAULTS, quiet: false },
		});

		try {
			composer.setHeaderExtras([new Text(startupHeaderRows.join("\n"), 0, 0)], []);
			composer.start({ playWelcomeIntro: false });
			composer.setRuntimeChildren([transcript, composer.editor]);
			await terminal.waitForRender();

			const plan = composer.renderFrame({ columns: 80, rows: 10 });
			const visibleActiveRows = (plan.pinnedScroll ?? [])
				.map(row => row.trimEnd())
				.filter(row => activeSessionRows.includes(row));

			expect(
				visibleActiveRows,
				`1. WHAT: test_post_pv_7_retires_header_for_active_messages FAILED
2. WHY: POST-PV-7 violation - ${postPv7.description}
3. EXPECTED: active transcript rows ${JSON.stringify(activeSessionRows)} remain available despite startup header pressure
4. ACTUAL: active transcript rows in pinnedScroll=${JSON.stringify(visibleActiveRows)}
5. GUIDANCE: Retire or naturally move startup header rows out of the pinned transcript window before they consume all active-message capacity`,
			).toEqual(activeSessionRows);
		} finally {
			composer.stop();
		}
	});

	it("POST-PV-7: a retired startup header sits at index 0 of software history and is scrollable back to, not deleted", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: Composer.renderFrame().
		 * - Enforces: POST-PV-7: "...retired header sits at index 0 of history" (the second half of the
		 *   clause, distinct from the row-pressure guarantee covered by the test above).
		 * - Category: integration / regression
		 * - Test pyramid: Integration
		 * - Risk tier: High — a deleted-rather-than-retired header is a silent, permanent, unrecoverable loss
		 *   of legitimate session content (session version, model, recent-session list).
		 * - Adversarial: Contract-governed, implementation-aware. Scrolls all the way to the top of software
		 *   history after retirement and asserts the header's own first line is still reachable there, rather
		 *   than only checking that active rows remain visible (which the current implementation already
		 *   satisfies by unconditionally dropping the header, not retiring it).
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-PV-7 in requirements/contracts/pinned_dock.contract.ts.
		 *   [✓] C2 VALUABLE: Composer.renderFrame's pinned branch currently sets
		 *       `headerRows = this.#headerRetired ? [] : this.#header.render(width)`, permanently omitting the
		 *       header from pinnedScroll once retired, so the top-of-history row can never be the header's own text.
		 *   [✓] C3 NON-DUPLICATIVE: asserts the "sits at index 0 of history" half of POST-PV-7; the sibling
		 *       test above asserts the "does not consume active-message rows" half — two disjoint observables
		 *       named by the same clause.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit "retired header sits at index 0" clause text.
		 */
		await initTheme();
		const terminal = new VirtualTerminal(80, 10, 100);
		const startupHeaderRows = Array.from(
			{ length: 12 },
			(_, index) => `STARTUP_HEADER_${String(index).padStart(2, "0")}`,
		);
		const activeSessionRows = ["ACTIVE_SESSION_MESSAGE_ONE", "ACTIVE_SESSION_MESSAGE_TWO"];
		const transcript = new TranscriptContainer();
		transcript.addChild(new Text(activeSessionRows.join("\n"), 0, 0));
		const composer = new Composer({
			terminal,
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});

		try {
			composer.setHeaderExtras([new Text(startupHeaderRows.join("\n"), 0, 0)], []);
			composer.start({ playWelcomeIntro: false });
			composer.setRuntimeChildren([transcript, composer.editor]);
			await terminal.waitForRender();

			const planAfterRetirement = composer.renderFrame({ columns: 80, rows: 10 });
			const retiredAndActiveVisible = (planAfterRetirement.pinnedScroll ?? []).some(row =>
				row.includes("ACTIVE_SESSION_MESSAGE_ONE"),
			);
			expect(
				retiredAndActiveVisible,
				`1. WHAT: test_post_pv_7_header_retirement_triggered FAILED (test setup sanity)
2. WHY: POST-PV-7 violation - ${postPv7.description}
3. EXPECTED: header retirement has fired and active session rows are present in pinnedScroll
4. ACTUAL: pinnedScroll=${JSON.stringify(planAfterRetirement.pinnedScroll)}
5. GUIDANCE: Mounting session content with the header present must trigger header retirement`,
			).toBe(true);

			composer.ui.scrollPinnedBy(-(startupHeaderRows.length + activeSessionRows.length + 10));
			await terminal.waitForRender();

			const topRow = terminal.getViewport()[0]?.trim();
			expect(
				topRow,
				`1. WHAT: test_post_pv_7_header_retired_to_index_zero FAILED
2. WHY: POST-PV-7 violation - ${postPv7.description}
3. EXPECTED: scrolling to the top of software history reaches ${JSON.stringify(startupHeaderRows[0])} (retired header preserved at index 0)
4. ACTUAL: top row after scrolling to the top = ${JSON.stringify(topRow)}
5. GUIDANCE: Keep the retired header as the leading rows of pinnedScroll instead of omitting it once #headerRetired is true`,
			).toBe(startupHeaderRows[0]);
		} finally {
			composer.stop();
		}
	});

	it("INV-PV-7: ComposerPreferences exposes no viewport property and Composer operates pinned unconditionally", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: Composer.start() / ComposerPreferences
		 * - Enforces: INV-PV-7: TUI SHALL NOT expose or honor an inline/unpinned viewport setting or code path.
		 * - Category: negative-space / regression
		 * - Test pyramid: Integration
		 * - Risk tier: High — a live, honored inline code path bypasses every pinned-mode guarantee in this
		 *   contract for any caller that can influence composer preferences.
		 * - Adversarial: Contract-governed, implementation-aware. Verifies that ComposerPreferences has no
		 *   viewport property and Composer runs in pinned mode unconditionally.
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites INV-PV-7 in requirements/contracts/pinned_dock.contract.ts.
		 *   [✓] C2 VALUABLE: verifies structural removal of viewport setting and unconditional pinned operation.
		 *   [✓] C3 NON-DUPLICATIVE: integration-level check of the live Composer/TUI wiring.
		 *   [✓] C4 NOT FUTURE-EDIT: enforces the current, explicit INV-PV-7 structural removal requirement.
		 */
		await initTheme();

		// Structural check: ComposerPreferences and COMPOSER_DEFAULTS must have NO viewport property
		const hasViewportInDefaults = "viewport" in COMPOSER_DEFAULTS;
		expect(
			hasViewportInDefaults,
			`1. WHAT: test_inv_pv_7_no_viewport_in_composer_defaults FAILED
2. WHY: INV-PV-7 violation - ${invPv7.description}
3. EXPECTED: "viewport" in COMPOSER_DEFAULTS === false (no viewport setting in ComposerPreferences)
4. ACTUAL: "viewport" in COMPOSER_DEFAULTS === ${hasViewportInDefaults}
5. GUIDANCE: Remove the viewport property entirely from ComposerPreferences and COMPOSER_DEFAULTS`,
		).toBe(false);

		const terminal = new VirtualTerminal(80, 10, 100);
		const composer = new Composer({
			terminal,
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});

		try {
			composer.start({ playWelcomeIntro: false });
			await terminal.waitForRender();
			expect(
				composer.ui.isPinned(),
				`1. WHAT: test_inv_pv_7_starts_pinned FAILED (test setup sanity)
2. WHY: INV-PV-7 violation - ${invPv7.description}
3. EXPECTED: composer.ui.isPinned() === true unconditionally after start()
4. ACTUAL: composer.ui.isPinned() === ${composer.ui.isPinned()}
5. GUIDANCE: Composer.start() must enter pinned mode unconditionally without checking a viewport preference`,
			).toBe(true);
		} finally {
			composer.stop();
		}
	});
});
