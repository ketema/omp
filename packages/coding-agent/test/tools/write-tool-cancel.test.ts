import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { stopRawIoHelper } from "@oh-my-pi/pi-coding-agent/tools/raw-io-client";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";

function evidence(what: string, expected: string, actual: unknown): string {
	return [
		`1. WHAT: ${what} FAILED`,
		"2. WHY: POST-RAWIO-3b violation (cancellation recheck)",
		`3. EXPECTED: ${expected}`,
		`4. ACTUAL: ${JSON.stringify(actual)}`,
		"5. GUIDANCE: Recheck the abort signal after classification and before dispatching the helper write",
	].join("\n");
}

const SQLITE_HEADER = Buffer.concat([Buffer.from("SQLite format 3\0", "latin1"), Buffer.alloc(4080, 0)]);

describe("WriteTool honors cancellation before dispatching a SQLite-Family write (Copilot F7a)", () => {
	let dir = "";
	let target = "";
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-write-cancel-"));
		target = path.join(dir, "guard.db");
		await fs.writeFile(target, SQLITE_HEADER);
	});
	afterEach(async () => {
		await stopRawIoHelper();
		await fs.rm(dir, { recursive: true, force: true });
	});

	function session(onRequest: (entry: { operation: string }) => void): ToolSession {
		return {
			cwd: dir,
			hasUI: false,
			enableLsp: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			rawIoHelperOptions: { onRequest },
		} as ToolSession;
	}

	it("control: without cancellation the write reaches the file through the helper", async () => {
		const requests: string[] = [];
		await new WriteTool(session(entry => requests.push(entry.operation))).execute("control", {
			path: target,
			content: "NEW\n",
		});
		expect(
			{ content: await fs.readFile(target, "utf8"), wrote: requests.includes("write") },
			evidence("uncancelled write control", "the write lands through the helper", requests),
		).toEqual({ content: "NEW\n", wrote: true });
	});

	it("never mutates the target when cancelled while its classification is pending", async () => {
		/* CAR: contracts/raw_io_helper.contract.ts POST-RAWIO-3b (recheck cancellation before the helper write),
		 * verification=test. HIGH-risk data-integrity boundary: untilAborted rejects the tool call, but the inner
		 * continuation used to keep going and overwrite the file after the user cancelled. C1: clause names the
		 * recheck; C2: the SQLite-Family branch returns before the pre-existing throwIfAborted; C3: differs from
		 * the uncancelled control; C4: real WriteTool, real helper, abort fired from the real onRequest hook for
		 * the classify request, file bytes observed for 1.5 s after the call rejects. No doubles.
		 */
		const controller = new AbortController();
		const requests: string[] = [];
		const tool = new WriteTool(
			session(entry => {
				requests.push(entry.operation);
				if (entry.operation === "classify") controller.abort();
			}),
		);
		let rejected = false;
		try {
			await tool.execute("cancelled", { path: target, content: "NEW\n" }, controller.signal);
		} catch {
			rejected = true;
		}
		const deadline = Date.now() + 1500;
		let content = (await fs.readFile(target)).toString("latin1");
		while (Date.now() < deadline && content.startsWith("SQLite format 3")) {
			await Bun.sleep(25);
			content = (await fs.readFile(target)).toString("latin1");
		}
		expect(
			{ rejected, untouched: content.startsWith("SQLite format 3"), wroteRequested: requests.includes("write") },
			evidence("cancelled write", "call rejects, target untouched, no helper write requested", {
				rejected,
				head: content.slice(0, 20),
				requests,
			}),
		).toEqual({ rejected: true, untouched: true, wroteRequested: false });
	}, 30_000);
});
