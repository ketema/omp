import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	classifyRawIoTarget,
	registerUnexitedWriteTarget,
	stopRawIoHelper,
} from "@oh-my-pi/pi-coding-agent/tools/raw-io-client";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";

function evidence(what: string, expected: string, actual: unknown): string {
	return [
		`1. WHAT: ${what} FAILED`,
		"2. WHY: ERRORS-RAWIO-1d violation",
		`3. EXPECTED: ${expected}`,
		`4. ACTUAL: ${JSON.stringify(actual)}`,
		"5. GUIDANCE: The WriteTool must apply the unexited-write refusal before choosing a write route, whatever the target now classifies as",
	].join("\n");
}

function session(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	};
}

describe("WriteTool honors the unexited-write block on every route (Copilot F6)", () => {
	let dir = "";
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-write-block-"));
	});
	afterEach(async () => {
		await stopRawIoHelper();
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("refuses a write to a registered target that now classifies as non-SQLite, leaving its bytes alone", async () => {
		/* CAR: contracts/raw_io_helper.contract.ts ERRORS-RAWIO-1d (refuse ANY new write to the registered real
		 * path; WriteTool applies it before any route), verification=test. HIGH-risk data-corruption boundary:
		 * a timed-out helper write opens a database with "w", truncating its header, so the next classify says
		 * non_sqlite and the in-process route could overwrite while the old helper's stale write is still pending.
		 * C1: clause text now names the WriteTool; C2: today only writeRawIoBytes consults the block; C3: differs
		 * from the client-level tests that call writeRawIoBytes directly; C4: real registrar, real WriteTool,
		 * real classifier, no doubles. The header-less file reproduces the post-truncation state truthfully.
		 */
		const target = path.join(dir, "truncated-by-helper.db");
		await fs.writeFile(target, "header was truncated\n");
		const classified = await classifyRawIoTarget(target);
		expect(
			classified.kind,
			evidence("classification control", "the blocked target now classifies as non_sqlite", classified.kind),
		).toBe("non_sqlite");
		const oldHelperExit = Promise.withResolvers<void>();
		registerUnexitedWriteTarget(target, oldHelperExit.promise);
		try {
			let refusal: unknown;
			try {
				await new WriteTool(session(dir)).execute("blocked-nonsqlite", { path: target, content: "NEW\n" });
			} catch (error: unknown) {
				refusal = error;
			}
			const message = refusal instanceof Error ? refusal.message : String(refusal);
			const bytes = await fs.readFile(target, "utf8");
			expect(
				{ refused: message.includes("previous helper is still alive"), bytes },
				evidence("blocked non-SQLite write", "refused naming the live helper; file unchanged", { message, bytes }),
			).toEqual({ refused: true, bytes: "header was truncated\n" });
		} finally {
			oldHelperExit.resolve();
			await oldHelperExit.promise;
		}
	});

	it("controls: another file is writable while blocked, and the block lifts when the old helper exits", async () => {
		const target = path.join(dir, "blocked.db");
		const other = path.join(dir, "other.txt");
		await fs.writeFile(target, "plain\n");
		const oldHelperExit = Promise.withResolvers<void>();
		registerUnexitedWriteTarget(target, oldHelperExit.promise);
		const tool = new WriteTool(session(dir));
		await tool.execute("other-file", { path: other, content: "ok\n" });
		expect(
			await fs.readFile(other, "utf8"),
			evidence("unrelated write control", "other files stay writable", null),
		).toBe("ok\n");
		oldHelperExit.resolve();
		await oldHelperExit.promise;
		await tool.execute("after-lift", { path: target, content: "lifted\n" });
		expect(
			await fs.readFile(target, "utf8"),
			evidence("lift control", "write succeeds after the old helper exits", null),
		).toBe("lifted\n");
	});
});
