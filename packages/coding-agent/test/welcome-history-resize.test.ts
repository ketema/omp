import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type Component, type RenderScheduler, visibleWidth } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "../../tui/test/virtual-render-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

class ResizeScheduler implements RenderScheduler {
	#now = 0;
	#pending = new Set<() => void>();

	now(): number {
		return this.#now;
	}

	scheduleImmediate(callback: () => void) {
		callback();
		return { cancel() {} };
	}

	scheduleRender(callback: () => void, _delayMs: number) {
		this.#pending.add(callback);
		return { cancel: () => this.#pending.delete(callback) };
	}

	settle(): void {
		this.#now += 120;
		while (this.#pending.size > 0) {
			const pending = [...this.#pending];
			this.#pending.clear();
			for (const callback of pending) callback();
		}
	}
	advance(ms: number): void {
		this.#now += ms;
	}
}

class MutableComposerTail implements Component {
	status = "thinking low";

	invalidate(): void {}

	render(): readonly string[] {
		return ["╭─ EDITOR TOP ─╮", `│ ${this.status} │`, "╰─ EDITOR BOTTOM ─╯"];
	}
}
class WidthTranscriptBlock implements Component {
	constructor(readonly id: number) {}

	render(width: number): readonly string[] {
		return [`block-${this.id}@${width}`];
	}
}

class TrackingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

function rowOf(rows: readonly string[], needle: string): number {
	return rows.findIndex(row => row.includes(needle));
}

function countRows(rows: readonly string[], needle: string): number {
	return rows.filter(row => row.includes(needle)).length;
}

function expectOneExactEditor(rows: readonly string[], status: string): number {
	const top = rowOf(rows, "EDITOR TOP");
	expect(countRows(rows, "EDITOR TOP")).toBe(1);
	expect(countRows(rows, status)).toBe(1);
	expect(countRows(rows, "EDITOR BOTTOM")).toBe(1);
	expect(rowOf(rows, status)).toBe(top + 1);
	expect(rowOf(rows, "EDITOR BOTTOM")).toBe(top + 2);
	return top;
}

function startRetiredWelcome(modelName: string): {
	composer: Composer;
	terminal: TrackingTerminal;
	scheduler: ResizeScheduler;
} {
	const terminal = new TrackingTerminal(80, 12);
	const scheduler = new ResizeScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: false, resizeScrollback: "preserve" },
		welcome: { version: "test", modelName, providerName: "test-provider" },
	});
	const transcript = new TranscriptContainer();
	transcript.addChild(new MutableComposerTail());
	composer.setRuntimeChildren([transcript, new MutableComposerTail()]);
	composer.start({ playWelcomeIntro: false });
	composer.renderFrame({ columns: 80, rows: 12 });
	scheduler.settle();
	return { composer, terminal, scheduler };
}

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("composer welcome native-history resize", () => {
	it("keeps one exact editor rectangle and retired welcome through repeated thinking and resize frames", async () => {
		// Select the long auth-broker tip: it retires as three hard rows at
		// width 80 and must not be recomposed into fewer rows after widening.
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const terminal = new TrackingTerminal(80, 12);
		const scheduler = new ResizeScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: false, resizeScrollback: "preserve" },
			welcome: { version: "test", modelName: "test-model", providerName: "test-provider" },
		});
		const offered: number[] = [];
		const acknowledged: number[] = [];
		let resizeFrames = 0;
		const renderFrame = composer.renderFrame.bind(composer);
		const renderResizeFrame = composer.renderResizeFrame.bind(composer);
		const acknowledgeHistory = composer.acknowledgeHistory.bind(composer);
		composer.renderFrame = viewport => {
			const plan = renderFrame(viewport);
			if (plan.history) offered.push(plan.history.id);
			return plan;
		};
		composer.renderResizeFrame = viewport => {
			resizeFrames++;
			return renderResizeFrame(viewport);
		};
		composer.acknowledgeHistory = id => {
			acknowledged.push(id);
			acknowledgeHistory(id);
		};

		const transcript = new TranscriptContainer();
		const tail = new MutableComposerTail();
		composer.setRuntimeChildren([transcript, tail]);
		composer.start({ playWelcomeIntro: false });
		scheduler.settle();

		// POST-PV-7: in pinned mode, welcome sits at index 0 of history
		const plan = composer.renderFrame({ columns: 80, rows: 12 });
		expect(countRows(plan.pinnedScroll ?? [], "Welcome back!")).toBe(1);
		expect(offered).toHaveLength(0);
		expect(acknowledged).toEqual(offered);

		const initialViewport = terminal.getViewport().map(row => Bun.stripANSI(row));
		const initialAnchor = expectOneExactEditor(initialViewport, tail.status);
		expect(initialAnchor).toBe(9);
		const writesAfterRetirement = terminal.writes.length;

		for (let index = 0; index < 40; index++) {
			tail.status = index % 2 === 0 ? "thinking high" : "thinking low";
			composer.ui.requestRender(true);
			scheduler.settle();
			const viewport = terminal.getViewport().map(row => Bun.stripANSI(row));
			expect(expectOneExactEditor(viewport, tail.status)).toBe(initialAnchor);
		}
		expect(offered).toHaveLength(0);
		expect(acknowledged).toHaveLength(0);

		for (const [columns, rows] of [
			[96, 28],
			[104, 30],
			[100, 34],
		] as const) {
			terminal.resize(columns, rows);
		}
		expect(resizeFrames).toBe(3);
		scheduler.settle();
		// The settled anchor repaint waits on the CPR reply, which VirtualTerminal
		// delivers on a microtask — drain it before reading the normal screen.
		await terminal.flush();

		let settledViewport = terminal.getViewport().map(row => Bun.stripANSI(row));
		expect(countRows(settledViewport, "Welcome back!")).toBe(1);
		expect(expectOneExactEditor(settledViewport, tail.status)).toBe(31);
		expect(countRows(settledViewport, "EDITOR TOP")).toBe(1);
		scheduler.advance(101);

		for (const [columns, rows] of [
			[92, 30],
			[72, 50],
		] as const) {
			terminal.resize(columns, rows);
		}
		expect(resizeFrames).toBe(5);
		scheduler.settle();
		await terminal.flush();

		settledViewport = terminal.getViewport().map(row => Bun.stripANSI(row));
		expect(countRows(settledViewport, "Welcome back!")).toBe(1);
		expect(expectOneExactEditor(settledViewport, tail.status)).toBe(47);
		expect(expectOneExactEditor(settledViewport, tail.status)).toBeGreaterThan(
			rowOf(settledViewport, "Welcome back!"),
		);
		expect(countRows(settledViewport, "EDITOR TOP")).toBe(1);
		expect(offered).toHaveLength(0);
		expect(acknowledged).toHaveLength(0);
		expect(terminal.writes.slice(writesAfterRetirement).some(write => write.includes("\x1b[3J"))).toBe(false);
		composer.ui.stop();
	});

	it("preserves a wide glyph that straddles a retired-row resize boundary", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const { composer } = startRetiredWelcome("model-aaaa界-tail");
		const accepted = composer
			.renderResizeFrame({ columns: 80, rows: 200 })
			.map(row => Bun.stripANSI(row))
			.find(row => row.includes("界"));
		expect(accepted).toBeDefined();
		const glyphIndex = accepted!.indexOf("界");
		const width = visibleWidth(accepted!.slice(0, glyphIndex)) + 1;
		expect(width).toBeLessThan(80);

		const resizeFrame = composer.renderResizeFrame({ columns: width, rows: 200 }).map(row => Bun.stripANSI(row));
		expect(countRows(resizeFrame, "界")).toBe(1);
		composer.ui.stop();
	});
	it("clips retired hard rows instead of reflowing them inside a multiplexer", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		Bun.env.TMUX = "/tmp/tmux-test/default,1,0";
		const marker = "MUX-SUFFIX";
		const { composer, terminal, scheduler } = startRetiredWelcome(`model-aaaa${marker}`);
		const accepted = composer
			.renderResizeFrame({ columns: 80, rows: 200 })
			.map(row => Bun.stripANSI(row))
			.find(row => row.includes(marker));
		expect(accepted).toBeDefined();
		expect(visibleWidth(accepted!)).toBeLessThanOrEqual(80);
		const markerIndex = accepted!.indexOf(marker);
		const width = visibleWidth(accepted!.slice(0, markerIndex)) - 1;
		expect(width).toBeGreaterThan(1);

		const resizeFrame = composer.renderResizeFrame({ columns: width, rows: 200 }).map(row => Bun.stripANSI(row));
		expect(countRows(resizeFrame, marker)).toBe(1);

		terminal.resize(width, 200);
		scheduler.settle();

		const transient = terminal.getViewport().map(row => Bun.stripANSI(row));
		expect(countRows(transient, marker)).toBe(0);
		composer.ui.stop();
	});
	it("rebuilds retired transcript rows at the settled width by default", async () => {
		const terminal = new VirtualTerminal(20, 12);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		for (let id = 0; id < 4; id++) transcript.addChild(new WidthTranscriptBlock(id));
		composer.setRuntimeChildren([transcript, new MutableComposerTail()]);
		composer.start({ playWelcomeIntro: false });
		await scheduler.settle(terminal);

		const initial = terminal.getViewport().map(r => Bun.stripANSI(r));
		expect(initial).toContain("block-0@20");

		terminal.resize(30, 12);
		await scheduler.advance(terminal, 160);

		const resized = terminal.getViewport().map(r => Bun.stripANSI(r));
		expect(resized.some(row => row.includes("@20"))).toBe(false);
		expect(resized).toContain("block-0@30");
		expect(resized).toContain("block-3@30");
		composer.ui.stop();
	});
});
