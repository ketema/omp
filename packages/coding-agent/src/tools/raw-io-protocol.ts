/**
 * Wire protocol for the out-of-process Raw-I/O Helper subprocess.
 *
 * Contract-Implementation Independence (CL11-F):
 *   This module redeclares its own constants and types independently; it MUST NOT
 *   import from `contracts/raw_io_helper.contract.ts`.
 */
import type { WorkerLogMessage } from "../subprocess/worker-client";

export { RAW_IO_WORKER_ARG } from "../cli/worker-selectors";

export const SQLITE_HEADER_MAGIC = new Uint8Array([
	0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
]);

export const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

export const SQLITE_FAMILY_CLASSIFICATIONS = [
	"sqlite_db",
	"sqlite_sidecar",
	"non_sqlite",
	"missing",
	"directory",
	"special",
] as const;

export type ClassificationKind = (typeof SQLITE_FAMILY_CLASSIFICATIONS)[number];

export type RawIoEntryKind = "file" | "missing" | "directory" | "special";

export interface RawIoTargetClassification {
	readonly targetPath: string;
	readonly resolvedPath: string;
	readonly kind: ClassificationKind;
	readonly isSqliteFamily: boolean;
	readonly helperPid: number;
	readonly headerBytes?: Uint8Array | undefined;
	readonly entryKind?: RawIoEntryKind | undefined;
}

export type RawIoWorkerInbound =
	| { readonly type: "ping"; readonly id: string }
	| { readonly type: "classify"; readonly id: string; readonly targetPath: string };

export type RawIoWorkerOutbound =
	| { readonly type: "pong"; readonly id: string }
	| {
			readonly type: "classified";
			readonly id: string;
			readonly classification: RawIoTargetClassification;
	  }
	| {
			readonly type: "error";
			readonly id: string;
			readonly operation: string;
			readonly targetPath: string;
			readonly error: string;
	  }
	| WorkerLogMessage;

export interface RawIoTransport {
	send(message: RawIoWorkerOutbound): void;
	onMessage(handler: (message: RawIoWorkerInbound) => void): () => void;
}
