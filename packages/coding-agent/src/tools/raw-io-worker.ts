/**
 * Out-of-process Raw-I/O Helper worker (`__omp_worker_raw_io`).
 *
 * Runs in a separate OS child process so opening, reading, writing, and closing
 * host files never releases POSIX advisory (`fcntl`) locks held by the parent
 * `omp` process on SQLite database and sidecar inodes (POST-RAWIO-1,
 * POST-RAWIO-1b, POST-RAWIO-2b, FORBIDDEN-RAWIO-1, FORBIDDEN-RAWIO-2,
 * FORBIDDEN-RAWIO-2b).
 *
 * Contract-Implementation Independence (CL11-F):
 *   This module MUST NOT import from `contracts/raw_io_helper.contract.ts` and
 *   MUST NOT open any SQLite database connection (`FORBIDDEN-RAWIO-1`).
 */
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import {
	type ClassificationKind,
	RAW_IO_PROGRESS_CHUNK_BYTES,
	type RawIoTargetClassification,
	type RawIoTransport,
	type RawIoWorkerInbound,
	SQLITE_HEADER_MAGIC,
	SQLITE_SIDECAR_SUFFIXES,
} from "./raw-io-protocol";

function matchesSqliteMagic(headerBytes: Uint8Array): boolean {
	if (headerBytes.byteLength < SQLITE_HEADER_MAGIC.byteLength) return false;
	for (let i = 0; i < SQLITE_HEADER_MAGIC.byteLength; i++) {
		if (headerBytes[i] !== SQLITE_HEADER_MAGIC[i]) return false;
	}
	return true;
}

async function resolveRealPathOrTarget(targetPath: string): Promise<string> {
	try {
		return await fs.realpath(targetPath);
	} catch (err) {
		const code = typeof err === "object" && err !== null && "code" in err ? Reflect.get(err, "code") : undefined;
		if (code !== "ENOENT" && code !== "ENOTDIR") {
			throw err;
		}
		return targetPath;
	}
}

async function classifyTargetInHelper(targetPath: string): Promise<RawIoTargetClassification> {
	const resolvedPath = await resolveRealPathOrTarget(targetPath);

	let stat: Stats | undefined;
	try {
		stat = await fs.stat(resolvedPath);
	} catch (err) {
		const code = typeof err === "object" && err !== null && "code" in err ? Reflect.get(err, "code") : undefined;
		if (code === "ENOENT" || code === "ENOTDIR") {
			// R3 (POST-RAWIO-1): non-existent targets classify as 'missing' regardless of path suffix.
			return {
				targetPath,
				resolvedPath,
				kind: "missing",
				isSqliteFamily: false,
				helperPid: process.pid,
				headerBytes: new Uint8Array(0),
				entryKind: "missing",
			};
		}
		throw err;
	}

	if (stat.isDirectory()) {
		return {
			targetPath,
			resolvedPath,
			kind: "directory",
			isSqliteFamily: false,
			helperPid: process.pid,
			headerBytes: new Uint8Array(0),
			entryKind: "directory",
		};
	}

	if (!stat.isFile()) {
		return {
			targetPath,
			resolvedPath,
			kind: "special",
			isSqliteFamily: false,
			helperPid: process.pid,
			headerBytes: new Uint8Array(0),
			entryKind: "special",
		};
	}

	// Open, read 16 header bytes, and close the descriptor exclusively inside this
	// separate OS helper process (POST-RAWIO-1, POST-RAWIO-1b, FORBIDDEN-RAWIO-2b).
	const headerBuffer = new Uint8Array(SQLITE_HEADER_MAGIC.byteLength);
	let bytesRead = 0;
	const handle = await fs.open(resolvedPath, "r");
	try {
		const readResult = await handle.read(headerBuffer, 0, headerBuffer.byteLength, 0);
		bytesRead = readResult.bytesRead;
	} finally {
		await handle.close();
	}

	const headerBytes = headerBuffer.subarray(0, bytesRead);
	// R2 (POST-RAWIO-1): inspect only resolvedPath for sidecar suffixes, never targetPath alone.
	const isResolvedSidecar = SQLITE_SIDECAR_SUFFIXES.some(suffix => resolvedPath.endsWith(suffix));
	const kind: ClassificationKind = isResolvedSidecar
		? "sqlite_sidecar"
		: matchesSqliteMagic(headerBytes)
			? "sqlite_db"
			: "non_sqlite";

	return {
		targetPath,
		resolvedPath,
		kind,
		isSqliteFamily: kind === "sqlite_db" || kind === "sqlite_sidecar",
		helperPid: process.pid,
		headerBytes,
		entryKind: "file",
	};
}

async function readBytesInHelper(
	transport: RawIoTransport,
	requestId: string,
	targetPath: string,
	offset?: number,
	length?: number,
): Promise<Uint8Array> {
	const resolvedPath = await resolveRealPathOrTarget(targetPath);
	const handle = await fs.open(resolvedPath, "r");
	try {
		const readOffset = offset ?? 0;
		let totalToRead = length;
		if (totalToRead === undefined) {
			const stat = await handle.stat();
			totalToRead = Math.max(0, stat.size - readOffset);
		}
		const output = new Uint8Array(totalToRead);
		let bytesProcessed = 0;
		while (bytesProcessed < totalToRead) {
			const chunkLen = Math.min(RAW_IO_PROGRESS_CHUNK_BYTES, totalToRead - bytesProcessed);
			const { bytesRead } = await handle.read(output, bytesProcessed, chunkLen, readOffset + bytesProcessed);
			if (bytesRead === 0) break;
			bytesProcessed += bytesRead;
			transport.send({
				type: "progress",
				id: requestId,
				bytesProcessed,
			});
		}
		return output.subarray(0, bytesProcessed);
	} finally {
		await handle.close();
	}
}

async function writeBytesInHelper(
	transport: RawIoTransport,
	requestId: string,
	targetPath: string,
	data: Uint8Array,
): Promise<void> {
	const resolvedPath = await resolveRealPathOrTarget(targetPath);
	const handle = await fs.open(resolvedPath, "w");
	try {
		let bytesProcessed = 0;
		const totalToWrite = data.byteLength;
		if (totalToWrite === 0) {
			transport.send({
				type: "progress",
				id: requestId,
				bytesProcessed: 0,
			});
			return;
		}
		while (bytesProcessed < totalToWrite) {
			const chunkLen = Math.min(RAW_IO_PROGRESS_CHUNK_BYTES, totalToWrite - bytesProcessed);
			const { bytesWritten } = await handle.write(data, bytesProcessed, chunkLen, bytesProcessed);
			if (bytesWritten === 0) {
				throw new Error("short write (0 bytes written)");
			}
			bytesProcessed += bytesWritten;
			transport.send({
				type: "progress",
				id: requestId,
				bytesProcessed,
			});
		}
	} finally {
		await handle.close();
	}
}

async function handleClassify(
	transport: RawIoTransport,
	message: Extract<RawIoWorkerInbound, { readonly type: "classify" }>,
): Promise<void> {
	transport.send({ type: "started", id: message.id });
	try {
		const classification = await classifyTargetInHelper(message.targetPath);
		transport.send({
			type: "classified",
			id: message.id,
			classification,
		});
	} catch (err) {
		transport.send({
			type: "error",
			id: message.id,
			operation: "classify",
			targetPath: message.targetPath,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

async function handleRead(
	transport: RawIoTransport,
	message: Extract<RawIoWorkerInbound, { readonly type: "read" }>,
): Promise<void> {
	transport.send({ type: "started", id: message.id });
	try {
		const bytes = await readBytesInHelper(transport, message.id, message.targetPath, message.offset, message.length);
		transport.send({
			type: "read_ok",
			id: message.id,
			bytes,
		});
	} catch (err) {
		transport.send({
			type: "error",
			id: message.id,
			operation: "read",
			targetPath: message.targetPath,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

async function handleWrite(
	transport: RawIoTransport,
	message: Extract<RawIoWorkerInbound, { readonly type: "write" }>,
): Promise<void> {
	transport.send({ type: "started", id: message.id });
	try {
		await writeBytesInHelper(transport, message.id, message.targetPath, message.data);
		transport.send({
			type: "write_ok",
			id: message.id,
		});
	} catch (err) {
		transport.send({
			type: "error",
			id: message.id,
			operation: "write",
			targetPath: message.targetPath,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

export function startRawIoWorker(transport: RawIoTransport): void {
	transport.onMessage(message => {
		switch (message.type) {
			case "ping":
				transport.send({ type: "pong", id: message.id });
				return;
			case "classify":
				void handleClassify(transport, message);
				return;
			case "read":
				void handleRead(transport, message);
				return;
			case "write":
				void handleWrite(transport, message);
				return;
		}
	});
}
