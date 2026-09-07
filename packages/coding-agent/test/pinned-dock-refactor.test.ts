import { describe, expect, it } from "bun:test";
import { Text } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { CONTRACT_PINNED_DOCK } from "../../../requirements/contracts/pinned_dock.contract";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const postPv2 = CONTRACT_PINNED_DOCK["POST-PV-2"];
const postPv7 = CONTRACT_PINNED_DOCK["POST-PV-7"];
const seqPv4 = CONTRACT_PINNED_DOCK["SEQ-PV-4"];

describe("pinned dock refactor — SLICE-2 full scrollback and header retirement", () => {
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
			preferences: { ...COMPOSER_DEFAULTS, viewport: "pinned", quiet: true },
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

			expect(observed).toEqual(
				{
					optionsTranscript: fullTranscriptRows,
					earliestVisibleRow: fullTranscriptRows[0]?.trim(),
				},
				`1. WHAT: test_post_pv_2_preserves_full_composer_history FAILED
2. WHY: POST-PV-2 / INV-PV-1 / SEQ-PV-4 violation - ${postPv2.description}; ${seqPv4.description}
3. EXPECTED: optionsTranscript contains every session row and a scroll-up reaches ${JSON.stringify(transcriptRows[0])}
4. ACTUAL: ${JSON.stringify(observed)}
5. GUIDANCE: Supply the full accumulated transcript to the pinned viewport so previous session output remains scrollable`,
			);
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
		const startupHeaderRows = Array.from({ length: 12 }, (_, index) => `STARTUP_HEADER_${String(index).padStart(2, "0")}`);
		const activeSessionRows = ["ACTIVE_SESSION_MESSAGE_ONE", "ACTIVE_SESSION_MESSAGE_TWO"];
		const transcript = new TranscriptContainer();
		transcript.addChild(new Text(activeSessionRows.join("\n"), 0, 0));
		const composer = new Composer({
			terminal,
			preferences: { ...COMPOSER_DEFAULTS, viewport: "pinned", quiet: false },
		});

		try {
			composer.setHeaderExtras([new Text(startupHeaderRows.join("\n"), 0, 0)], []);
			composer.start({ playWelcomeIntro: false });
			composer.setRuntimeChildren([transcript, composer.editor]);
			await terminal.waitForRender();

			const plan = composer.renderFrame({ columns: 80, rows: 10 });
			const visibleActiveRows = (plan.pinnedScroll ?? []).filter(row => activeSessionRows.includes(row));

			expect(visibleActiveRows).toEqual(
				activeSessionRows,
				`1. WHAT: test_post_pv_7_retires_header_for_active_messages FAILED
2. WHY: POST-PV-7 violation - ${postPv7.description}
3. EXPECTED: active transcript rows ${JSON.stringify(activeSessionRows)} remain available despite startup header pressure
4. ACTUAL: active transcript rows in pinnedScroll=${JSON.stringify(visibleActiveRows)}
5. GUIDANCE: Retire or naturally move startup header rows out of the pinned transcript window before they consume all active-message capacity`,
			);
		} finally {
			composer.stop();
		}
	});
});
