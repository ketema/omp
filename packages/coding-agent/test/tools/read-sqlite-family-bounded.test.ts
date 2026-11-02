import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { stopRawIoHelper } from "@oh-my-pi/pi-coding-agent/tools/raw-io-client";
import { ReadTool, SNAPSHOT_MAX_BYTES } from "@oh-my-pi/pi-coding-agent/tools/read";

function evidence(what: string, expected: string, actual: unknown): string {
	return [
		`1. WHAT: ${what} FAILED`,
		"2. WHY: POST-RAWIO-3 violation (bounded helper reads)",
		`3. EXPECTED: ${expected}`,
		`4. ACTUAL: ${JSON.stringify(actual)}`,
		"5. GUIDANCE: Request at most SNAPSHOT_MAX_BYTES from the helper; sniff larger targets from a bounded prefix",
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

const MIB = 1024 * 1024;

describe("ReadTool bounds helper reads of SQLite-Family files (Copilot F5)", () => {
	let dir = "";
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-read-bounded-"));
	});
	afterEach(async () => {
		await stopRawIoHelper();
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("does not buffer a 256 MiB -wal sidecar whole in either process", async () => {
		/* CAR: contracts/raw_io_helper.contract.ts POST-RAWIO-3 (bounded by SNAPSHOT_MAX_BYTES), verification=test.
		 * HIGH-risk memory boundary: a multi-GB WAL read whole can exhaust both processes. C1: clause names the
		 * bound; C2: read.ts requests the whole file from the helper for any SQLite-Family target; C3: differs
		 * from the routing tests, which use tiny files; C4: real ReadTool, real helper, real sparse file, and
		 * parent RSS sampled every 5 ms (the helper reply is copied into the parent, so an unbounded read shows
		 * up as parent growth of the file's size). A small -wal control proves the helper path still works.
		 */
		const small = path.join(dir, "small.db-wal");
		await fs.writeFile(small, Buffer.alloc(8192, 0));
		const smallResult = await new ReadTool(session(dir)).execute("small-wal", { path: small });
		expect(
			smallResult.content.some(block => block.type === "text"),
			evidence("small sidecar control", "an ordinary small -wal read still returns a result", smallResult),
		).toBe(true);

		const big = path.join(dir, "big.db-wal");
		const handle = await fs.open(big, "w");
		await handle.truncate(256 * MIB);
		await handle.close();
		Bun.gc(true);
		const baseline = process.memoryUsage().rss;
		let peak = baseline;
		const sampler = setInterval(() => {
			peak = Math.max(peak, process.memoryUsage().rss);
		}, 5);
		let outcome: unknown;
		try {
			outcome = await new ReadTool(session(dir)).execute("big-wal", { path: big });
		} catch (error: unknown) {
			outcome = String(error);
		} finally {
			clearInterval(sampler);
		}
		const growthMiB = Math.round((peak - baseline) / MIB);
		expect(
			growthMiB < 64,
			evidence("bounded sidecar read", "parent RSS grows by less than 64 MiB", {
				growthMiB,
				outcome: String(outcome).slice(0, 80),
			}),
		).toBe(true);
	}, 120_000);

	it("refuses an oversized non-binary sidecar with an error naming the 4 MiB limit", async () => {
		const textual = path.join(dir, "big.db-journal");
		await fs.writeFile(textual, "a line of plain text\n".repeat(Math.ceil((SNAPSHOT_MAX_BYTES + MIB) / 21)));
		const size = (await fs.stat(textual)).size;
		expect(size > SNAPSHOT_MAX_BYTES, evidence("fixture size control", "the file exceeds the cap", size)).toBe(true);
		let refusal: unknown;
		let result: unknown;
		try {
			result = await new ReadTool(session(dir)).execute("big-journal", { path: textual });
		} catch (error: unknown) {
			refusal = error;
		}
		const message = refusal instanceof Error ? refusal.message : "";
		expect(
			{ refused: refusal !== undefined, namesLimit: message.includes("4 MiB") },
			evidence("oversized text sidecar", "refused with an error naming the 4 MiB limit", {
				message,
				returned: result !== undefined,
			}),
		).toEqual({ refused: true, namesLimit: true });
	}, 60_000);
});
