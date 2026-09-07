import { describe, expect, it } from "bun:test";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

describe("Composer pinned viewport wiring (SEQ-1, SEQ-3, POST-8)", () => {

	it("SEQ-1: start with viewport pinned enters TUI pinned mode", async () => {
		await initTheme();
		const term = new VirtualTerminal(80, 16, 100);
		const composer = new Composer({
			terminal: term,
			preferences: { ...COMPOSER_DEFAULTS, quiet: true, viewport: "pinned" },
		});
		try {
			composer.start({ playWelcomeIntro: false });
			await term.waitForRender();
			expect(composer.ui.isPinned()).toBe(true);
		} finally {
			composer.stop();
		}
	});

	it("SEQ-3: setPreferences toggles pinned and inline", async () => {
		await initTheme();
		const term = new VirtualTerminal(80, 16, 100);
		const composer = new Composer({
			terminal: term,
			preferences: { ...COMPOSER_DEFAULTS, quiet: true, viewport: "pinned" },
		});
		try {
			composer.start({ playWelcomeIntro: false });
			await term.waitForRender();
			expect(composer.ui.isPinned()).toBe(true);
			composer.setPreferences({ viewport: "inline" });
			expect(composer.ui.isPinned()).toBe(false);
			composer.setPreferences({ viewport: "pinned" });
			expect(composer.ui.isPinned()).toBe(true);
		} finally {
			composer.stop();
		}
	});

	it("POST-8: renderFrame omits HistoryBatch while pinned", async () => {
		await initTheme();
		const term = new VirtualTerminal(80, 16, 100);
		const composer = new Composer({
			terminal: term,
			preferences: { ...COMPOSER_DEFAULTS, quiet: true, viewport: "pinned" },
		});
		try {
			composer.start({ playWelcomeIntro: false });
			await term.waitForRender();
			const plan = composer.renderFrame({ columns: 80, rows: 16 });
			expect(plan.history).toBeUndefined();
			expect(plan.viewport).toEqual([]);
			expect(plan.pinnedDock).toBeDefined();
			expect(plan.pinnedScroll).toBeDefined();
		} finally {
			composer.stop();
		}
	});
});
