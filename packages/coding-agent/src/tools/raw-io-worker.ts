/**
 * Out-of-process Raw-I/O Helper worker (`__omp_worker_raw_io`).
 *
 * Runs in a separate OS child process so opening, reading, and closing host
 * files never releases POSIX advisory (`fcntl`) locks held by the parent `omp`
 * process on SQLite database and `-shm` inodes (POST-RAWIO-1, POST-RAWIO-1b,
 * FORBIDDEN-RAWIO-1, FORBIDDEN-RAWIO-2, FORBIDDEN-RAWIO-2b).
 *
 * Contract-Implementation Independence (CL11-F):
 *   This module MUST NOT import from `contracts/raw_io_helper.contract.ts` and
 *   MUST NOT open any SQLite database connection (`FORBIDDEN-RAWIO-1`).
 */
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import {
	type ClassificationKind,
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

// Inline check removed in favor of direct helper.

async function classifyTargetInHelper(targetPath: string): Promise<RawIoTargetClassification> {
	let resolvedPath = targetPath;
	try {
		resolvedPath = await fs.realpath(targetPath);
	} catch (err) {
		const code = typeof err === "object" && err !== null && "code" in err ? Reflect.get(err, "code") : undefined;
		if (code !== "ENOENT" && code !== "ENOTDIR") {
			throw err;
		}
	}

	const isSidecarSuffix = SQLITE_SIDECAR_SUFFIXES.some(
		suffix => resolvedPath.endsWith(suffix) || targetPath.endsWith(suffix),
	);

	let stat: Stats | undefined;
	try {
		stat = await fs.stat(resolvedPath);
	} catch (err) {
		const code = typeof err === "object" && err !== null && "code" in err ? Reflect.get(err, "code") : undefined;
		if (code === "ENOENT" || code === "ENOTDIR") {
			if (isSidecarSuffix) {
				return {
					targetPath,
					resolvedPath,
					kind: "sqlite_sidecar",
					isSqliteFamily: true,
					helperPid: process.pid,
					headerBytes: new Uint8Array(0),
					entryKind: "file",
				};
			}
			return {
				targetPath,
				resolvedPath,
				kind: "missing",
				isSqliteFamily: false,
				helperPid: process.pid,
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
	const kind: ClassificationKind = isSidecarSuffix
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

async function handleClassify(
	transport: RawIoTransport,
	message: Extract<RawIoWorkerInbound, { readonly type: "classify" }>,
): Promise<void> {
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

export function startRawIoWorker(transport: RawIoTransport): void {
	transport.onMessage(message => {
		switch (message.type) {
			case "ping":
				transport.send({ type: "pong", id: message.id });
				return;
			case "classify":
				void handleClassify(transport, message);
				return;
		}
	});
}
