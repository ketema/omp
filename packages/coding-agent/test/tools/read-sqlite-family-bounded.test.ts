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

	describe("pages an oversized non-binary sidecar (Ketema decision on F5)", () => {
		let textual = "";
		const LINES = 450_000;

		async function readText(readPath: string): Promise<string> {
			const result = await new ReadTool(session(dir)).execute("page", { path: readPath });
			return result.content
				.filter(block => block.type === "text")
				.map(block => ("text" in block ? block.text : ""))
				.join("\n");
		}

		beforeEach(async () => {
			textual = path.join(dir, "big.db-journal");
			const rows: string[] = [];
			for (let i = 1; i <= LINES; i++) rows.push(`line ${i}`);
			await fs.writeFile(textual, `${rows.join("\n")}\n`);
			const size = (await fs.stat(textual)).size;
			expect(size > SNAPSHOT_MAX_BYTES, evidence("fixture size control", "the file exceeds the cap", size)).toBe(
				true,
			);
		});

		it("returns the first page with a continuation notice instead of refusing or buffering the file", async () => {
			const text = await readText(textual);
			expect(
				{
					hasFirst: text.includes("line 1"),
					hasContinuation: /Use :\d+ to continue/.test(text),
					small: text.length < 200_000,
				},
				evidence("default page", "first page plus a continuation notice, bounded", {
					head: text.slice(0, 120),
					length: text.length,
				}),
			).toEqual({ hasFirst: true, hasContinuation: true, small: true });
		}, 60_000);

		it("returns exactly a requested single line range", async () => {
			const text = await readText(`${textual}:3-5`);
			expect(
				{
					three: text.includes("line 3"),
					four: text.includes("line 4"),
					five: text.includes("line 5"),
					six: text.includes("line 6\n") || text.endsWith("line 6"),
				},
				evidence("single range", "lines 3 to 5 and not line 6", text.slice(0, 200)),
			).toEqual({ three: true, four: true, five: true, six: false });
		}, 60_000);

		it("pages deep into the file through bounded helper reads", async () => {
			const text = await readText(`${textual}:300000-300002`);
			expect(
				{ a: text.includes("line 300000"), b: text.includes("line 300002"), before: text.includes("line 299999") },
				evidence("deep range", "lines 300000 to 300002 only", text.slice(0, 200)),
			).toEqual({ a: true, b: true, before: false });
		}, 90_000);

		it("refuses multi-range and tail selectors with an error naming the 4 MiB limit", async () => {
			for (const selector of [":1-2,5-6", ":-3"]) {
				let message = "";
				try {
					await readText(`${textual}${selector}`);
				} catch (error: unknown) {
					message = error instanceof Error ? error.message : String(error);
				}
				expect(
					message.includes("4 MiB"),
					evidence(`unsupported selector ${selector}`, "refused naming the 4 MiB limit", message),
				).toBe(true);
			}
		}, 60_000);
	});
});
