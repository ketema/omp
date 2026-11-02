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

describe("pageLinesThroughHelper", () => {
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
