import { describe, expect, it } from "bun:test";
import { PageScanLimitError, pageLinesThroughHelper } from "@oh-my-pi/pi-coding-agent/tools/raw-io-lines";

function reader(content: string | Uint8Array) {
	const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
	const calls: Array<{ offset: number; length: number }> = [];
	return {
		bytes,
		calls,
		read: async (offset: number, length: number) => {
			calls.push({ offset, length });
			return bytes.slice(offset, offset + length);
		},
	};
}

const opts = { maxLines: 3, maxBytes: 10_000, chunkBytes: 7 } as const;

describe("pageLinesThroughHelper (POST-RAWIO-3)", () => {
	it("returns one window across chunk boundaries and reports more", async () => {
		const r = reader("alpha\nbravo\ncharlie\ndelta\necho\n");
		const page = await pageLinesThroughHelper(r.read, r.bytes.length, { ...opts, startLine0: 1 });
		expect(page).toEqual({ lines: ["bravo", "charlie", "delta"], startLine0: 1, more: true });
		expect(r.calls.every(c => c.length <= 7)).toBe(true);
	});

	it("reports no more lines when the window ends exactly at end of file", async () => {
		const r = reader("a\nb\nc\n");
		const page = await pageLinesThroughHelper(r.read, r.bytes.length, { ...opts, startLine0: 0 });
		expect(page).toEqual({ lines: ["a", "b", "c"], startLine0: 0, more: false });
	});

	it("keeps a final line that has no trailing newline and strips CR from CRLF lines", async () => {
		const r = reader("one\r\ntwo\r\nthree");
		const page = await pageLinesThroughHelper(r.read, r.bytes.length, { ...opts, startLine0: 0 });
		expect(page.lines).toEqual(["one", "two", "three"]);
		expect(page.more).toBe(false);
	});

	it("decodes multibyte text split across chunk boundaries", async () => {
		const r = reader("héllo wörld\nnaïve café\nsmörgåsbord\n");
		const page = await pageLinesThroughHelper(r.read, r.bytes.length, { ...opts, startLine0: 0 });
		expect(page.lines).toEqual(["héllo wörld", "naïve café", "smörgåsbord"]);
	});

	it("returns an empty window past the end of the file", async () => {
		const r = reader("a\nb\n");
		const page = await pageLinesThroughHelper(r.read, r.bytes.length, { ...opts, startLine0: 10 });
		expect(page).toEqual({ lines: [], startLine0: 10, more: false });
	});

	it("stops at the byte budget and marks more", async () => {
		const r = reader("aaaa\nbbbb\ncccc\n");
		const page = await pageLinesThroughHelper(r.read, r.bytes.length, {
			startLine0: 0,
			maxLines: 10,
			maxBytes: 9,
			chunkBytes: 7,
		});
		expect(page.lines).toEqual(["aaaa", "bbbb"]);
		expect(page.more).toBe(true);
	});

	it("refuses to scan past the sequential cap when the start line is not yet reached", async () => {
		const r = reader("x\n".repeat(100));
		await expect(
			pageLinesThroughHelper(r.read, r.bytes.length, { ...opts, startLine0: 90, scanCapBytes: 20 }),
		).rejects.toBeInstanceOf(PageScanLimitError);
	});
});

describe("pageLinesThroughHelper memory bound (Claude audit, POST-RAWIO-3)", () => {
	const MIB = 1024 * 1024;

	/** A reader that fabricates a file on demand, so the test itself never holds the whole file. */
	function syntheticReader(totalBytes: number, tail = "") {
		const tailBytes = new TextEncoder().encode(tail);
		const size = totalBytes + tailBytes.length;
		return {
			size,
			read: async (offset: number, length: number): Promise<Uint8Array> => {
				const out = new Uint8Array(Math.max(0, Math.min(length, size - offset)));
				out.fill(0x61);
				for (let at = Math.max(offset, totalBytes); at < offset + out.length; at++) {
					out[at - offset] = tailBytes[at - totalBytes] ?? 0x0a;
				}
				return out;
			},
		};
	}

	async function peakGrowthMiB<T>(work: () => Promise<T>): Promise<{ result: T; growthMiB: number }> {
		Bun.gc(true);
		const baseline = process.memoryUsage().rss;
		let peak = baseline;
		const sampler = setInterval(() => {
			peak = Math.max(peak, process.memoryUsage().rss);
		}, 2);
		try {
			const result = await work();
			return { result, growthMiB: Math.round((Math.max(peak, process.memoryUsage().rss) - baseline) / MIB) };
		} finally {
			clearInterval(sampler);
		}
	}

	it("does not accumulate a 48 MiB single line with no newline (first page)", async () => {
		const r = syntheticReader(48 * MIB);
		const { result, growthMiB } = await peakGrowthMiB(() =>
			pageLinesThroughHelper(r.read, r.size, { startLine0: 0, maxLines: 3, maxBytes: 1000, chunkBytes: MIB }),
		);
		expect(result.lines.length).toBe(1);
		expect(result.lines[0]?.length).toBe(1000);
		expect(growthMiB < 32, `parent RSS grew by ${growthMiB} MiB while paging a newline-free file`).toBe(true);
	}, 120_000);

	it("holds no bytes while skipping a huge line, then returns the lines after it", async () => {
		const r = syntheticReader(48 * MIB, "\nafter one\nafter two\n");
		const { result, growthMiB } = await peakGrowthMiB(() =>
			pageLinesThroughHelper(r.read, r.size, {
				startLine0: 1,
				maxLines: 3,
				maxBytes: 1000,
				chunkBytes: MIB,
				scanCapBytes: 256 * MIB,
			}),
		);
		expect(result.lines).toEqual(["after one", "after two"]);
		expect(growthMiB < 32, `parent RSS grew by ${growthMiB} MiB while skipping a huge line`).toBe(true);
	}, 120_000);
});
