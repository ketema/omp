import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	COMPOSER_DEFAULTS,
	Composer,
	type ComposerPreferences,
} from "@oh-my-pi/pi-coding-agent/modes/composer";
import {
	type AnimationFrame,
	TranscriptContainer,
} from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { Component } from "@oh-my-pi/pi-tui";
import {
	CONTRACT_PINNED_JITTER_COPY,
} from "../../../requirements/contracts/pinned-jitter-copy.contract";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

/**
 * Test Double: SimpleTranscriptBlock (Stub)
 * Implements a finalized transcript block emitting fixed lines of text.
 */
class SimpleTranscriptBlock implements Component {
	constructor(private readonly lines: string[]) {}

	render(): string[] {
		return this.lines;
	}

	isTranscriptBlockFinalized(): boolean {
		return true;
	}
}

describe("CONTRACT_PINNED_JITTER_COPY (Composer Implementation Tests)", () => {
	beforeEach(async () => {
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("POST-5 / SEQ-2: Composer pinned renderFrame bounds pinnedScroll to viewport rows and avoids unbounded TranscriptContainer.render", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: Composer.renderFrame()
		 * - Enforces: POST-5: Composer pinned renderFrame SHALL NOT call TranscriptContainer.render (unbounded full history); pinnedScroll SHALL be produced by a windowed path whose length is at most the physical row count
		 * - Enforces: SEQ-2: Composer.renderFrame pinned branch SHALL obtain transcript rows from a windowed renderer, not TranscriptContainer.render (IP-DM-3)
		 * - Category: performance / architecture / integration
		 * - Risk tier: High — full history render on every pinned frame causes severe CPU burn and frame drop jitter
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clauses POST-5 and SEQ-2 existing in contracts/pinned-jitter-copy.contract.ts
		 *   [✓] C2 VALUABLE: passes "can impl be wrong and test pass?" = NO (current composer.ts calls transcript.render(width) unbounded)
		 *   [✓] C3 NON-DUPLICATIVE: tests Composer frame planning and windowed transcript delegation
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contract, not hypothetical future
		 */
		const terminal = new VirtualTerminal(80, 24);
		const config: ComposerPreferences = {
			...COMPOSER_DEFAULTS,
			viewport: "pinned",
			quiet: true,
		};
		const composer = new Composer({ preferences: config, terminal });
		composer.start();

		const transcript = new TranscriptContainer();
		// Add 100 lines of history to transcript
		for (let i = 0; i < 100; i++) {
			transcript.addChild(new SimpleTranscriptBlock([`TRANSCRIPT_ROW_${String(i).padStart(3, "0")}`]));
		}

		composer.setRuntimeChildren([transcript, composer.editor]);

		const renderSpy = vi.spyOn(TranscriptContainer.prototype, "render");

		const targetViewportRows = 20;
		const plan = composer.renderFrame({ columns: 80, rows: targetViewportRows });

		expect(renderSpy.mock.calls.length).toBe(
			0,
			`1. WHAT: test_transcript_container_not_rendered FAILED\n2. WHY: SEQ-2 / POST-5 violation - Composer pinned renderFrame invoked unbounded TranscriptContainer.render\n3. EXPECTED: 0 calls to TranscriptContainer.render\n4. ACTUAL: ${renderSpy.mock.calls.length} calls\n5. GUIDANCE: Use windowed transcript rendering path instead of unbounded full-history render`,
		);

		const scrollLength = plan.pinnedScroll?.length ?? 0;
		expect(scrollLength).toBeLessThanOrEqual(
			targetViewportRows,
			`1. WHAT: test_pinned_scroll_bounded_length FAILED\n2. WHY: POST-5 violation - pinnedScroll contains ${scrollLength} rows, which exceeds viewport height ${targetViewportRows}\n3. EXPECTED: <= ${targetViewportRows} rows\n4. ACTUAL: ${scrollLength} rows\n5. GUIDANCE: Use a windowed transcript renderer bounded by available physical viewport rows instead of full unbounded history`,
		);

		composer.stop();
		composer.ui.stop();
	});
});
