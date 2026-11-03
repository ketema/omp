/**
 * POST-RAWIO-3 (bounded reads): page lines out of a large SQLite-Family file through bounded
 * Raw-I/O Helper range reads. Holds at most one chunk, the carried partial line and the collected
 * window in memory, and never opens the file in-process.
 *
 * Contract-Implementation Independence (CL11-F): redeclares its own constants and types.
 */

export const PAGE_CHUNK_BYTES = 1024 * 1024;
export const PAGE_SCAN_CAP_BYTES = 128 * 1024 * 1024;

export interface HelperLinePageOptions {
	/** Zero-based index of the first line to return. */
	readonly startLine0: number;
	readonly maxLines: number;
	readonly maxBytes: number;
	readonly scanCapBytes?: number;
	readonly chunkBytes?: number;
}

export interface HelperLinePage {
	readonly lines: string[];
	readonly startLine0: number;
	/** True when more lines remain after the returned window. */
	readonly more: boolean;
}

export class PageScanLimitError extends Error {
	constructor(scanCapBytes: number) {
		super(`line is beyond the ${scanCapBytes}-byte sequential scan limit for paging a SQLite-family file`);
		this.name = "PageScanLimitError";
	}
}

const LF = 0x0a;

function decodeLine(bytes: Uint8Array): string {
	const end = bytes.length > 0 && bytes[bytes.length - 1] === 0x0d ? bytes.length - 1 : bytes.length;
	return Buffer.from(bytes.buffer, bytes.byteOffset, end).toString("utf8");
}

export async function pageLinesThroughHelper(
	read: (offset: number, length: number) => Promise<Uint8Array>,
	fileSize: number,
	options: HelperLinePageOptions,
): Promise<HelperLinePage> {
	const chunkBytes = options.chunkBytes ?? PAGE_CHUNK_BYTES;
	const scanCap = options.scanCapBytes ?? PAGE_SCAN_CAP_BYTES;
	const lines: string[] = [];
	let collectedBytes = 0;
	let lineIndex = 0;
	let offset = 0;
	// The carry (a partial line spanning chunks) is capped at what the output can use: `take` truncates a
	// line to maxBytes anyway, so bytes beyond the cap are dropped until the next LF. A few bytes of slack
	// keep a cut multibyte character intact.
	const cap = options.maxBytes + 3;
	const EMPTY = new Uint8Array(0);
	const joinCapped = (head: Uint8Array, tail: Uint8Array): Uint8Array => {
		if (head.length >= cap) return head;
		const part = tail.length > cap - head.length ? tail.subarray(0, cap - head.length) : tail;
		const out = new Uint8Array(head.length + part.length);
		out.set(head);
		out.set(part, head.length);
		return out;
	};
	let carry: Uint8Array = EMPTY;
	let more = false;

	const take = (lineBytes: Uint8Array): boolean => {
		// Returns false once the window is full (the caller stops and reports `more`).
		if (lineIndex < options.startLine0) {
			lineIndex++;
			return true;
		}
		const text = decodeLine(lineBytes);
		const bytes = Buffer.byteLength(text, "utf8");
		if (lines.length >= options.maxLines || (lines.length > 0 && collectedBytes + bytes > options.maxBytes)) {
			more = true;
			return false;
		}
		lines.push(bytes > options.maxBytes ? text.slice(0, options.maxBytes) : text);
		collectedBytes += Math.min(bytes, options.maxBytes);
		lineIndex++;
		return true;
	};

	scan: while (offset < fileSize) {
		if (lineIndex < options.startLine0 && offset >= scanCap) throw new PageScanLimitError(scanCap);
		const chunk = await read(offset, Math.min(chunkBytes, fileSize - offset));
		if (chunk.length === 0) break;
		offset += chunk.length;
		const data = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
		let start = 0;
		for (let i = data.indexOf(LF, start); i !== -1; i = data.indexOf(LF, start)) {
			const lineBytes = joinCapped(carry, data.subarray(start, i));
			carry = EMPTY;
			if (!take(lineBytes)) break scan;
			start = i + 1;
		}
		carry = joinCapped(carry, data.subarray(start));
	}
	// A final line without a trailing newline.
	if (!more && offset >= fileSize && carry.length > 0 && lineIndex >= options.startLine0) take(carry);
	return { lines, startLine0: options.startLine0, more };
}
