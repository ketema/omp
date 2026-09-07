import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { COMPOSER_DEFAULTS, Composer, type ComposerPreferences } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { Component } from "@oh-my-pi/pi-tui";
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

	it("POST-5: bootstrap pinnedScroll is empty when dock occupies the whole frame", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: Composer.renderFrame()
		 * - Enforces: POST-5: pinnedScroll length is at most the physical row count
		 * - Category: boundary
		 * - Risk tier: High — slice(-0) returned the full unbounded scroll array
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-5
		 *   [✓] C2 VALUABLE: fails if available===0 still returns the full scroll
		 *   [✓] C3 NON-DUPLICATIVE: bootstrap branch, not the TranscriptContainer path
		 *   [✓] C4 NOT FUTURE-EDIT: locks the slice(-0) arbitration
		 */
		const terminal = new VirtualTerminal(80, 24);
		const composer = new Composer({
			preferences: { ...COMPOSER_DEFAULTS, viewport: "pinned", quiet: true },
			terminal,
		});
		composer.start();
		const probe = composer.renderFrame({ columns: 80, rows: 24 });
		const dockLength = probe.pinnedDock?.length ?? 0;
		expect(dockLength).toBeGreaterThan(
			0,
			`1. WHAT: test_bootstrap_dock_present FAILED\n2. WHY: POST-5 setup - bootstrap dock must occupy rows\n3. EXPECTED: dock length > 0\n4. ACTUAL: ${dockLength}\n5. GUIDANCE: Bootstrap dock is editor plus status`,
		);
		const plan = composer.renderFrame({ columns: 80, rows: dockLength });
		const scrollLength = plan.pinnedScroll?.length ?? -1;
		expect(scrollLength).toBe(
			0,
			`1. WHAT: test_bootstrap_available_zero FAILED\n2. WHY: POST-5 violation - dock filling the frame must yield empty pinnedScroll, not slice(-0) full history\n3. EXPECTED: 0\n4. ACTUAL: ${scrollLength}\n5. GUIDANCE: When available rows are 0, pinnedScroll is []`,
		);
		composer.stop();
		composer.ui.stop();
	});
});
