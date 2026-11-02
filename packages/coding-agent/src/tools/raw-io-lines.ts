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
	let carry: Uint8Array = new Uint8Array(0);
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
		const data =
			carry.length > 0 ? Buffer.concat([carry, chunk]) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
		let start = 0;
		for (let i = data.indexOf(LF, start); i !== -1; i = data.indexOf(LF, start)) {
			if (!take(data.subarray(start, i))) break scan;
			start = i + 1;
		}
		carry = Uint8Array.from(data.subarray(start));
	}
	// A final line without a trailing newline.
	if (!more && offset >= fileSize && carry.length > 0 && lineIndex >= options.startLine0) take(carry);
	else if (!more && offset >= fileSize && carry.length > 0) lineIndex++;
	return { lines, startLine0: options.startLine0, more };
}
