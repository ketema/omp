import { describe, expect, it } from "bun:test";
import { type Component, type Focusable, TUI, type TerminalFrameProvider, type ViewportSize } from "@oh-my-pi/pi-tui";
import { ALT_SCREEN_ENTER } from "../../../requirements/contracts/pinned-composer.contract";
import { VirtualTerminal } from "./virtual-terminal";

class RecordingTerminal extends VirtualTerminal {
	writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

class EditorStub implements Component, Focusable {
	focused = false;
	text = "";
	invalidate(): void {}
	render(): string[] {
		return [`PROMPT:${this.text}`];
	}
	handleInput(data: string): void {
		if (data.startsWith("\x1b")) return;
		this.text += data;
	}
}

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

describe("TUI pinned session (POST-8/9/10, SEQ-2, FORBIDDEN-1)", () => {
	it("POST-9: enterPinned writes ALT_SCREEN_ENTER once", async () => {
		const term = new RecordingTerminal(40, 8, 100);
		const tui = new TUI(term, true);
		const editor = new EditorStub();
		tui.addChild(editor);
		tui.setFocus(editor);
		try {
			tui.start();
			tui.enterPinned();
			await term.waitForRender();
			expect(countNeedle(term.writes, ALT_SCREEN_ENTER)).toBe(1);
			tui.enterPinned();
			await term.waitForRender();
			expect(countNeedle(term.writes, ALT_SCREEN_ENTER)).toBe(1);
		} finally {
			tui.stop();
		}
	});

	it("POST-10: fullscreen overlay while pinned does not write a second 1049h", async () => {
		const term = new RecordingTerminal(40, 8, 100);
		const tui = new TUI(term, true);
		const editor = new EditorStub();
		const overlay: Component = {
			invalidate() {},
			render: () => ["OVERLAY"],
		};
		tui.addChild(editor);
		tui.setFocus(editor);
		try {
			tui.start();
			tui.enterPinned();
			await term.waitForRender();
			expect(countNeedle(term.writes, ALT_SCREEN_ENTER)).toBe(1);
			tui.showOverlay(overlay, { fullscreen: true, mouseTracking: true });
			await term.waitForRender();
			expect(countNeedle(term.writes, ALT_SCREEN_ENTER)).toBe(1);
		} finally {
			tui.stop();
		}
	});

	it("SEQ-2 / POST-7: wheel up does not mutate editor text", async () => {
		const term = new RecordingTerminal(40, 8, 100);
		const editor = new EditorStub();
		const provider: TerminalFrameProvider = {
			renderFrame(_viewport: ViewportSize) {
				return {
					viewport: [],
					pinnedScroll: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
					pinnedDock: [editor.render()[0]!],
				};
			},
			acknowledgeHistory() {},
		};
		const tui = new TUI(term, true);
		tui.setFrameProvider(provider);
		tui.setFocus(editor);
		try {
			tui.start();
			tui.enterPinned();
			await term.waitForRender();
			term.sendInput("\x1b[<64;1;1M");
			await term.waitForRender();
			expect(editor.text).toBe("");
			term.sendInput("x");
			await term.waitForRender();
			expect(editor.text).toBe("x");
		} finally {
			tui.stop();
		}
	});

	it("INV-1: dock row is the last viewport line while pinned", async () => {
		const term = new RecordingTerminal(40, 6, 100);
		const editor = new EditorStub();
		const provider: TerminalFrameProvider = {
			renderFrame() {
				return {
					viewport: [],
					pinnedScroll: ["a", "b", "c", "d", "e", "f", "g"],
					pinnedDock: ["PROMPT:"],
				};
			},
			acknowledgeHistory() {},
		};
		const tui = new TUI(term, true);
		tui.setFrameProvider(provider);
		tui.setFocus(editor);
		try {
			tui.start();
			tui.enterPinned();
			await term.waitForRender();
			const rows = term.getViewport().map(line => line.trimEnd());
			expect(rows[rows.length - 1]).toBe("PROMPT:");
		} finally {
			tui.stop();
		}
	});

	it("IP-3 / SEQ-2: pageUp scrolls transcript without mutating the editor", async () => {
		const term = new RecordingTerminal(40, 6, 100);
		const editor = new EditorStub();
		const lines = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
		const provider: TerminalFrameProvider = {
			renderFrame() {
				return { viewport: [], pinnedScroll: lines, pinnedDock: ["PROMPT:"] };
			},
			acknowledgeHistory() {},
		};
		const tui = new TUI(term, true);
		tui.setFrameProvider(provider);
		tui.setFocus(editor);
		try {
			tui.start();
			tui.enterPinned();
			await term.waitForRender();
			term.sendInput("\x1b[5~");
			await term.waitForRender();
			expect(editor.text).toBe("");
			const rows = term.getViewport().map(line => line.trimEnd());
			expect(rows[rows.length - 1]).toBe("PROMPT:");
			expect(rows).not.toContain("9");
		} finally {
			tui.stop();
		}
	});

	it("IP-3: follow key resumes tail after pageUp", async () => {
		const term = new RecordingTerminal(40, 6, 100);
		const editor = new EditorStub();
		const provider: TerminalFrameProvider = {
			renderFrame() {
				return {
					viewport: [],
					pinnedScroll: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
					pinnedDock: ["PROMPT:"],
				};
			},
			acknowledgeHistory() {},
		};
		const tui = new TUI(term, true);
		tui.setFrameProvider(provider);
		tui.setFocus(editor);
		try {
			tui.start();
			tui.enterPinned();
			await term.waitForRender();
			term.sendInput("\x1b[5~");
			await term.waitForRender();
			term.sendInput("\x1b[1;6B");
			await term.waitForRender();
			const rows = term.getViewport().map(line => line.trimEnd());
			expect(rows).toContain("9");
			expect(rows[rows.length - 1]).toBe("PROMPT:");
		} finally {
			tui.stop();
		}
	});
});
