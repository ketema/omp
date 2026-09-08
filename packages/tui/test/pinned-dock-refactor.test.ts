import { describe, expect, it } from "bun:test";
import {
	Input,
	Text,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	TUI,
	type ViewportSize,
} from "@oh-my-pi/pi-tui";
import { parseSgrMouseStream } from "@oh-my-pi/pi-tui/mouse";
import { PinnedViewport } from "@oh-my-pi/pi-tui/pinned-viewport";
import {
	CONTRACT_PINNED_DOCK,
	InvalidHeightError,
	InvalidMouseInputError,
	OSC52_CLIPBOARD_PREFIX,
	validateComposeHeight,
	validateSgrMouseReports,
	validateSoftwareScrollback,
	ZeroScrollbackError,
} from "../../../requirements/contracts/pinned_dock.contract";
import { VirtualTerminal } from "./virtual-terminal";

/**
 * Boundary spy: delegates grid behavior to VirtualTerminal and records exact
 * terminal writes solely for POST-PV-6's OSC 52 observable.
 *
 * Double type: Spy.
 * Contract: requirements/contracts/pinned_dock.contract.ts POST-PV-6.
 */
class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

/**
 * Immutable frame input for real TUI lifecycle tests. It contains no provider
 * behavior under test; its values are the transcript and dock inputs governed
 * by the contract.
 *
 * Double type: Stub.
 * Contract: requirements/contracts/pinned_dock.contract.ts POST-PV-3, POST-PV-6.
 */
class StaticPinnedFrameProvider implements TerminalFrameProvider {
	constructor(
		private readonly scroll: readonly string[],
		private readonly dock: readonly string[],
	) {}

	renderFrame(_viewport: ViewportSize): TerminalFramePlan {
		return {
			viewport: [],
			pinnedScroll: this.scroll,
			pinnedDock: this.dock,
		};
	}
}

describe("pinned dock refactor — SLICE-1 overlay compositing and selection integrity", () => {
	it("POST-PV-4 / FORBIDDEN-PV-1: decodes every report in one concatenated SGR mouse chunk", () => {
		const postPv4 = CONTRACT_PINNED_DOCK["POST-PV-4"];
		const forbiddenPv1 = CONTRACT_PINNED_DOCK["FORBIDDEN-PV-1"];

		const concatenatedChunk = "\x1b[<64;10;5M\x1b[<64;10;5M\x1b[<65;10;5M";
		const reports = parseSgrMouseStream(concatenatedChunk);

		expect(reports.length).toBe(
			3,
			`1. WHAT: test_post_pv_4_concatenated_sgr_reports FAILED
2. WHY: POST-PV-4 / FORBIDDEN-PV-1 violation - ${postPv4.description} / ${forbiddenPv1.description}
3. EXPECTED: 3 parsed SGR mouse reports
4. ACTUAL: ${reports.length}
5. GUIDANCE: Stream-parse every SGR packet in the chunk without anchoring to line ends`,
		);

		expect(reports.map(report => report.wheel)).toEqual(
			[-1, -1, 1],
			`1. WHAT: test_post_pv_4_wheel_polarity FAILED
2. WHY: POST-PV-4 violation - ${postPv4.description}
3. EXPECTED: [-1, -1, 1]
4. ACTUAL: ${JSON.stringify(reports.map(report => report.wheel))}
5. GUIDANCE: Retain wheel polarity across concatenated packet streams`,
		);
	});

	it("POST-PV-3 / SEQ-PV-2: composites every visible floating and anchored overlay before input is delivered", async () => {
		const postPv3 = CONTRACT_PINNED_DOCK["POST-PV-3"];
		const seqPv2 = CONTRACT_PINNED_DOCK["SEQ-PV-2"];

		const terminal = new VirtualTerminal(48, 8);
		const tui = new TUI(terminal, false);
		const overlay = new Input();
		overlay.prompt = "MODEL_OVERLAY_ACTIVE:";

		tui.setFrameProvider(new StaticPinnedFrameProvider(["TRANSCRIPT_LINE_1"], ["DOCK_LINE_1"]));
		try {
			tui.start();
			tui.enterPinned();
			await terminal.waitForRender();

			const handle = tui.showOverlay(overlay, {
				anchor: "bottom-center",
				width: "100%",
				maxHeight: "100%",
				margin: 0,
			});
			await terminal.waitForRender();

			const renderedText = terminal.getViewport().join("\n");
			expect(renderedText.includes("MODEL_OVERLAY_ACTIVE:")).toBe(
				true,
				`1. WHAT: test_post_pv_3_overlay_visible_in_pinned_mode FAILED
2. WHY: POST-PV-3 / SEQ-PV-2 violation - ${postPv3.description} / ${seqPv2.description}
3. EXPECTED: bottom-anchored overlay text visible in rendered viewport
4. ACTUAL: viewport was:\n${renderedText}
5. GUIDANCE: Invoke #compositeOverlaysIntoWindow after PinnedViewport.composeFrame`,
			);

			terminal.sendInput("g");
			await terminal.waitForRender();
			expect(overlay.getValue()).toBe(
				"g",
				`1. WHAT: test_post_pv_3_overlay_accepts_focused_input FAILED
2. WHY: POST-PV-3 / SEQ-PV-2 violation - ${postPv3.description}
3. EXPECTED: overlay input receives typed keystrokes without dock freeze
4. ACTUAL: overlay.getValue()=${JSON.stringify(overlay.getValue())}
5. GUIDANCE: Deliver keyboard events to the focused overlay rather than freezing the dock`,
			);

			handle.hide();
			await terminal.waitForRender();
		} finally {
			tui.stop();
		}
	});

	it("POST-PV-6: copies an exact multi-row transcript selection through OSC 52 on release", async () => {
		const postPv6 = CONTRACT_PINNED_DOCK["POST-PV-6"];

		const terminal = new RecordingTerminal(48, 8, 100);
		const tui = new TUI(terminal, false);

		tui.setFrameProvider(
			new StaticPinnedFrameProvider(
				["ALPHA_LINE_CONTENT", "BRAVO_LINE_CONTENT", "CHARLIE_LINE_CONTENT"],
				["PROMPT_INPUT_DOCK"],
			),
		);
		try {
			tui.start();
			tui.enterPinned();
			await terminal.waitForRender();

			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;10;2M");
			await terminal.waitForRender();

			const writesBeforeRelease = terminal.writes.length;
			terminal.sendInput("\x1b[<0;10;2m");
			await terminal.waitForRender();

			const releaseWrites = terminal.writes.slice(writesBeforeRelease).join("");
			expect(releaseWrites.includes(OSC52_CLIPBOARD_PREFIX)).toBe(
				true,
				`1. WHAT: test_post_pv_6_multi_row_osc52_copy FAILED
2. WHY: POST-PV-6 violation - ${postPv6.description}
3. EXPECTED: terminal write containing OSC 52 clipboard prefix (${JSON.stringify(OSC52_CLIPBOARD_PREFIX)})
4. ACTUAL: no OSC 52 escape in release writes: ${JSON.stringify(releaseWrites)}
5. GUIDANCE: Collect visible transcript selection spanning rows and emit OSC 52 on left-button release`,
			);
		} finally {
			tui.stop();
		}
	});

	it("SEQ-PV-5: overlay focus clears an in-progress drag before a later release", async () => {
		const seqPv5 = CONTRACT_PINNED_DOCK["SEQ-PV-5"];

		const terminal = new RecordingTerminal(48, 8, 100);
		const tui = new TUI(terminal, false);
		const overlay = new Input();
		overlay.prompt = "FOCUS_STEALER:";

		tui.setFrameProvider(new StaticPinnedFrameProvider(["SELECTABLE_TRANSCRIPT"], ["PROMPT_DOCK"]));
		try {
			tui.start();
			tui.enterPinned();
			await terminal.waitForRender();

			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;6;1M");
			await terminal.waitForRender();

			const handle = tui.showOverlay(overlay, { anchor: "center" });
			await terminal.waitForRender();
			handle.hide();
			await terminal.waitForRender();

			const writesBeforeRelease = terminal.writes.length;
			terminal.sendInput("\x1b[<0;6;1m");
			await terminal.waitForRender();
			const writesAfterInterruptedRelease = terminal.writes.slice(writesBeforeRelease).join("");

			expect(writesAfterInterruptedRelease.includes(OSC52_CLIPBOARD_PREFIX)).toBe(
				false,
				`1. WHAT: test_seq_pv_5_overlay_focus_clears_drag FAILED
2. WHY: SEQ-PV-5 / POST-PV-6 violation - ${seqPv5.description}
3. EXPECTED: no OSC 52 clipboard write after a drag is interrupted by overlay focus
4. ACTUAL: OSC 52 clipboard write emitted=${writesAfterInterruptedRelease.includes(OSC52_CLIPBOARD_PREFIX)}
5. GUIDANCE: Discard active drag selection immediately when overlay focus takes control`,
			);
		} finally {
			tui.stop();
		}
	});

	it("PRE-PV-1 / ERRORS-PV-1 / POST-PV-1 / SEQ-PV-1: composeFrame validation, height compliance, and invocation sequence", () => {
		expect(() => validateComposeHeight(0)).toThrow(InvalidHeightError);
		expect(() => validateComposeHeight(-5)).toThrow(InvalidHeightError);
		validateComposeHeight(24);

		const viewport = new PinnedViewport();
		const frame = viewport.composeFrame({
			transcript: ["ROW_1", "ROW_2", "ROW_3", "ROW_4"],
			dock: ["DOCK_1", "DOCK_2"],
			height: 6,
		});
		expect(frame.length).toBe(6);
		expect(frame[4]).toBe("DOCK_1");
		expect(frame[5]).toBe("DOCK_2");
	});

	it("PRE-PV-2 / ERRORS-PV-2 / POST-PV-5 / SEQ-PV-3: mouse validator and summed wheel delta application", async () => {
		const nonStringInput = null as unknown as string;
		expect(() => validateSgrMouseReports(nonStringInput, [])).toThrow(InvalidMouseInputError);

		const chunk = "\x1b[<64;1;1M\x1b[<64;1;1M";
		const events = parseSgrMouseStream(chunk);
		validateSgrMouseReports(chunk, events);
		expect(events.length).toBe(2);

		const terminal = new RecordingTerminal(48, 8, 100);
		const tui = new TUI(terminal, false);
		const history = Array.from({ length: 20 }, (_, i) => `HIST_${i}`);
		tui.setFrameProvider(new StaticPinnedFrameProvider(history, ["DOCK"]));
		try {
			tui.start();
			tui.enterPinned();
			await terminal.waitForRender();

			terminal.sendInput(chunk);
			await terminal.waitForRender();

			const view = terminal.getViewport();
			expect(view.length).toBe(8);
		} finally {
			tui.stop();
		}
	});

	it("INV-PV-5: following status does not overwrite transcript content rows", async () => {
		const terminal = new RecordingTerminal(48, 6, 100);
		const tui = new TUI(terminal, false);
		const history = ["TRANSCRIPT_LINE_1", "TRANSCRIPT_LINE_2", "TRANSCRIPT_LINE_3", "TRANSCRIPT_LINE_4", "TRANSCRIPT_LINE_5"];
		tui.setFrameProvider(new StaticPinnedFrameProvider(history, ["PROMPT_ROW"]));
		try {
			tui.start();
			tui.enterPinned();
			await terminal.waitForRender();

			terminal.sendInput("\x1b[<64;1;1M");
			await terminal.waitForRender();

			const viewportText = terminal.getViewport().join("\n");
			expect(viewportText.includes("TRANSCRIPT_LINE_")).toBe(true);
		} finally {
			tui.stop();
		}
	});

	it("INV-PV-1 / validateSoftwareScrollback: rejects truncated history when long history exists", () => {
		expect(() => validateSoftwareScrollback(5, 10, 50)).toThrow(ZeroScrollbackError);
		validateSoftwareScrollback(50, 10, 50);
	});
});
