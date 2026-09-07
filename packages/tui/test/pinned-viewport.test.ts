import { describe, expect, it } from "bun:test";
import {
	clippedPinnedDockHeight,
	PINNED_MIN_TRANSCRIPT_ROWS,
	PinnedViewport,
} from "@oh-my-pi/pi-tui/pinned-viewport";
import {
	CONTRACT_PINNED_COMPOSER,
	PINNED_MIN_TRANSCRIPT_ROWS as CONTRACT_MIN_ROWS,
	clippedPinnedDockHeight as contractClip,
	validateComposeHeight,
	validateViewportMode,
	PinnedComposerContractError,
} from "../../../requirements/contracts/pinned-composer.contract.ts";

describe("pinned composer contract validators", () => {
	it("PRE-MODE-1: rejects unknown viewport modes", () => {
		expect(validateViewportMode("pinned")).toBe("pinned");
		expect(validateViewportMode("inline")).toBe("inline");
		try {
			validateViewportMode("sticky");
			throw new Error("PRE-MODE-1 violation: expected throw for sticky");
		} catch (err) {
			expect(err).toBeInstanceOf(PinnedComposerContractError);
			expect((err as PinnedComposerContractError).clauseId).toBe("PRE-MODE-1");
			expect((err as Error).message).toContain("PRE-MODE-1");
		}
	});

	it("PRE-1 / ERRORS-1: rejects non-positive compose height", () => {
		expect(() => validateComposeHeight(0)).toThrow(/PRE-1/);
		expect(() => validateComposeHeight(Number.NaN)).toThrow(/PRE-1/);
	});

	it("POST-3: contract min transcript rows matches implementation", () => {
		expect(PINNED_MIN_TRANSCRIPT_ROWS).toBe(CONTRACT_MIN_ROWS);
		expect(PINNED_MIN_TRANSCRIPT_ROWS).toBe(3);
		expect(clippedPinnedDockHeight(10, 8)).toBe(contractClip(10, 8));
		expect(clippedPinnedDockHeight(10, 8)).toBe(5);
	});
});

describe("PinnedViewport.composeFrame", () => {
	it("POST-1: returns a frame whose length equals height", () => {
		const viewport = new PinnedViewport();
		const frame = viewport.composeFrame({
			transcript: ["a", "b", "c", "d"],
			dock: ["PROMPT", "STATUS"],
			height: 10,
		});
		expect(frame.length).toBe(10);
	});

	it("POST-2 / INV-1: dock occupies the last dockHeight rows", () => {
		const viewport = new PinnedViewport();
		const dock = ["PROMPT", "STATUS"];
		const frame = viewport.composeFrame({
			transcript: ["t0", "t1", "t2", "t3", "t4"],
			dock,
			height: 8,
		});
		expect(frame.slice(-dock.length)).toEqual(dock);
		expect(frame[frame.length - 1]).toBe("STATUS");
		expect(frame[frame.length - 2]).toBe("PROMPT");
	});

	it("POST-2: clips an oversized dock from the top, keeping the editor", () => {
		const viewport = new PinnedViewport();
		const frame = viewport.composeFrame({
			transcript: ["t0"],
			dock: ["HUD", "CHIPS", "PROMPT", "STATUS"],
			height: 5,
		});
		expect(frame.length).toBe(5);
		expect(frame.slice(-2)).toEqual(["PROMPT", "STATUS"]);
		expect(frame).not.toContain("HUD");
	});

	it("POST-4: following pins the window to the transcript tail", () => {
		const viewport = new PinnedViewport();
		const transcript = ["0", "1", "2", "3", "4", "5", "6", "7"];
		const frame = viewport.composeFrame({ transcript, dock: ["DOCK"], height: 5 });
		expect(viewport.isFollowing()).toBe(true);
		expect(frame.slice(0, 4)).toEqual(["4", "5", "6", "7"]);
		expect(frame[4]).toBe("DOCK");
	});

	it("POST-5: following=false keeps scrollTop while content appends", () => {
		const viewport = new PinnedViewport();
		viewport.composeFrame({
			transcript: ["0", "1", "2", "3", "4", "5", "6", "7"],
			dock: ["DOCK"],
			height: 5,
		});
		viewport.scrollBy(-2);
		expect(viewport.isFollowing()).toBe(false);
		const frozen = viewport.scrollTop();
		const frame = viewport.composeFrame({
			transcript: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
			dock: ["DOCK"],
			height: 5,
		});
		expect(viewport.scrollTop()).toBe(frozen);
		expect(viewport.isFollowing()).toBe(false);
		expect(frame.slice(0, 4)).toEqual(["2", "3", "4", "5"]);
	});

	it("POST-6: scrollBy resumes following at the tail", () => {
		const viewport = new PinnedViewport();
		viewport.composeFrame({
			transcript: ["0", "1", "2", "3", "4", "5"],
			dock: ["DOCK"],
			height: 4,
		});
		viewport.scrollBy(-10);
		expect(viewport.isFollowing()).toBe(false);
		expect(viewport.scrollTop()).toBe(0);
		viewport.scrollBy(10);
		expect(viewport.isFollowing()).toBe(true);
	});

	it("POST-7: composeFrame itself does not treat a dock rewrite as follow", () => {
		const viewport = new PinnedViewport();
		viewport.composeFrame({
			transcript: ["0", "1", "2", "3", "4", "5"],
			dock: ["old"],
			height: 4,
		});
		viewport.scrollBy(-2);
		const top = viewport.scrollTop();
		viewport.composeFrame({
			transcript: ["0", "1", "2", "3", "4", "5"],
			dock: ["typed"],
			height: 4,
		});
		expect(viewport.scrollTop()).toBe(top);
		expect(viewport.isFollowing()).toBe(false);
	});

	it("PRE-1: composeFrame throws with clause id on invalid height", () => {
		const viewport = new PinnedViewport();
		expect(() => viewport.composeFrame({ transcript: [], dock: [], height: 0 })).toThrow(/PRE-1 violation/);
	});
});

describe("contract clause map", () => {
	it("every CONTRACT_PINNED_COMPOSER clause declares a verification method", () => {
		for (const [id, clause] of Object.entries(CONTRACT_PINNED_COMPOSER)) {
			expect(["test", "execution", "tool"]).toContain(clause.verification);
			expect(clause.text.length).toBeGreaterThan(0);
			expect(id.length).toBeGreaterThan(0);
		}
	});
});
