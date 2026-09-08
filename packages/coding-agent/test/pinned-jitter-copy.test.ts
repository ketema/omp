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

	it("POST-PV-2 / SEQ-PV-4: Composer pinned renderFrame preserves full transcript lines in software history", () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: Composer.renderFrame()
		 * - Enforces: POST-PV-2 / INV-PV-1: Composer pinned renderFrame SHALL provide full transcript lines to pinnedScroll so PinnedViewport can scroll history
		 * - Category: architecture / integration
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

		const targetViewportRows = 20;
		const plan = composer.renderFrame({ columns: 80, rows: targetViewportRows });

		const scrollLength = plan.pinnedScroll?.length ?? 0;
		expect(scrollLength).toBeGreaterThanOrEqual(
			100,
			`1. WHAT: test_pinned_scroll_preserves_history FAILED\n2. WHY: POST-PV-2 violation - pinnedScroll must contain complete transcript history, got ${scrollLength} rows\n3. EXPECTED: >= 100 rows\n4. ACTUAL: ${scrollLength} rows\n5. GUIDANCE: PinnedViewport owns windowing; pass full transcript history`,
		);
		composer.stop();
		composer.ui.stop();
	});
});
