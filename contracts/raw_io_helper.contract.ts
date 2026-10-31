/**
 * Raw-I/O Helper Contract — specification authority (TypeScript native).
 *
 * Authoritative contract for SLICE-4 (REQ-L15586-05, REQ-L15586-31, REQ-L15586-08,
 * REQ-L15586-28; negative constraints INV-L15586-01, INV-L15586-02, INV-L15586-03,
 * INV-L15586-04, INV-L15586-12, INV-L15586-13) paired with contracts/raw_io_helper.contract.py.
 *
 * Contract-Implementation Independence (CL11-F):
 *   Production code MUST NOT import from this file; tests import both contract
 *   and implementation to verify constant, type, and behavioral alignment.
 */

// =============================================================================
// Artifact 1: Importable constants
// =============================================================================

export const RAW_IO_WORKER_ARG = "__omp_worker_raw_io" as const;

export const RAW_IO_WORKER_SELECTORS_MODULE = "@oh-my-pi/pi-coding-agent/cli/worker-selectors" as const;

export const RAW_IO_CLIENT_MODULE = "@oh-my-pi/pi-coding-agent/tools/raw-io-client" as const;

export const RAW_IO_CLASSIFY_FN_NAME = "classifyRawIoTarget" as const;

export const RAW_IO_STOP_FN_NAME = "stopRawIoHelper" as const;

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

export const SQLITE_FAMILY_ACTIVE_KINDS = ["sqlite_db", "sqlite_sidecar"] as const;

export const VALID_ENTRY_KINDS = ["file", "missing", "directory", "special"] as const;

// =============================================================================
// Artifact 2: Exception classes
// =============================================================================

export class RawIoHelperContractError extends Error {
	readonly clauseId: string;

	constructor(clauseId: string, message: string, options?: ErrorOptions) {
		super(`${clauseId} violation: ${message}`, options);
		this.name = new.target.name;
		this.clauseId = clauseId;
	}
}

export class RawIoInvalidTargetPathError extends RawIoHelperContractError {
	constructor(targetPath: unknown, options?: ErrorOptions) {
		super(
			"PRE-RAWIO-1",
			`targetPath must be a non-empty POSIX absolute path starting with '/'; got ${JSON.stringify(targetPath)}`,
			options,
		);
	}
}

export class RawIoClassificationMismatchError extends RawIoHelperContractError {}

export class RawIoHelperUnavailableError extends RawIoHelperContractError {
	readonly operation: string;
	readonly targetPath: string;
	readonly reason: string;

	constructor(operation: string, targetPath: string, reason: string, options?: ErrorOptions) {
		super("ERRORS-RAWIO-1", `Raw-I/O Helper failed during ${operation} for '${targetPath}': ${reason}`, options);
		this.operation = operation;
		this.targetPath = targetPath;
		this.reason = reason;
	}
}

// =============================================================================
// Artifact 3: Immutable records / structural types
// =============================================================================

export type ClauseVerification = "test" | "execution" | "tool";

export interface Clause {
	readonly verification: ClauseVerification;
	readonly text: string;
}

export type ClassificationKind = (typeof SQLITE_FAMILY_CLASSIFICATIONS)[number];

export type EntryKind = (typeof VALID_ENTRY_KINDS)[number];

export interface RawIoTargetClassification {
	readonly targetPath: string;
	readonly resolvedPath: string;
	readonly kind: ClassificationKind;
	readonly isSqliteFamily: boolean;
	readonly helperPid: number;
}

export interface RawIoClassifyOptions {
	readonly helperSpawnCommand?: {
		readonly cmd: readonly string[];
	};
}

export interface RawIoClientSurface {
	readonly classifyRawIoTarget: (
		targetPath: string,
		options?: RawIoClassifyOptions,
	) => Promise<RawIoTargetClassification>;
	readonly stopRawIoHelper: () => Promise<void>;
}

export interface ClassifyResolvedTargetInput {
	readonly targetPath: unknown;
	readonly resolvedPath: unknown;
	readonly headerBytes?: Uint8Array | undefined;
	readonly helperPid: unknown;
	readonly parentPid: number;
	readonly entryKind?: unknown;
}

// =============================================================================
// Artifact 4: Pure callable validators
// =============================================================================

export function isEntryKind(value: unknown): value is EntryKind {
	return value === "file" || value === "missing" || value === "directory" || value === "special";
}

export function validateTargetPath(targetPath: unknown): string {
	if (typeof targetPath !== "string" || targetPath.trim().length === 0 || !targetPath.startsWith("/")) {
		throw new RawIoInvalidTargetPathError(targetPath);
	}
	return targetPath;
}

export function validateClassifyOptions(options: unknown): RawIoClassifyOptions {
	if (options === undefined) {
		return Object.freeze({});
	}
	if (typeof options !== "object" || options === null) {
		throw new RawIoClassificationMismatchError(
			"POST-RAWIO-2",
			`options must be an object or undefined; got ${JSON.stringify(options)}`,
		);
	}
	const spawn = Reflect.get(options, "helperSpawnCommand");
	if (spawn === undefined) {
		return Object.freeze({});
	}
	if (typeof spawn !== "object" || spawn === null) {
		throw new RawIoClassificationMismatchError(
			"POST-RAWIO-2",
			"helperSpawnCommand must be an object with a non-empty 'cmd' array",
		);
	}
	const cmd = Reflect.get(spawn, "cmd");
	if (
		!Array.isArray(cmd) ||
		cmd.length === 0 ||
		!cmd.every((item): item is string => typeof item === "string" && item.trim().length > 0)
	) {
		throw new RawIoClassificationMismatchError(
			"POST-RAWIO-2",
			"helperSpawnCommand.cmd must be a non-empty array of non-empty strings",
		);
	}
	return Object.freeze({
		helperSpawnCommand: Object.freeze({
			cmd: Object.freeze([...cmd]),
		}),
	});
}

export function hasSqliteHeaderMagic(bytes: Uint8Array): boolean {
	if (bytes.byteLength < SQLITE_HEADER_MAGIC.byteLength) return false;
	for (let i = 0; i < SQLITE_HEADER_MAGIC.byteLength; i++) {
		if (bytes[i] !== SQLITE_HEADER_MAGIC[i]) return false;
	}
	return true;
}

export function validateClassificationRecord(input: ClassifyResolvedTargetInput): RawIoTargetClassification {
	const validTarget = validateTargetPath(input.targetPath);
	const validResolved = validateTargetPath(input.resolvedPath);
	if (
		typeof input.helperPid !== "number" ||
		!Number.isInteger(input.helperPid) ||
		input.helperPid <= 0 ||
		input.helperPid === input.parentPid
	) {
		throw new RawIoClassificationMismatchError(
			"FORBIDDEN-RAWIO-2",
			`helperPid (${String(input.helperPid)}) must be a positive OS PID distinct from omp parentPid (${input.parentPid})`,
		);
	}
	const rawEntryKind = input.entryKind ?? "file";
	if (!isEntryKind(rawEntryKind)) {
		throw new RawIoClassificationMismatchError(
			"POST-RAWIO-1",
			`entryKind must be one of ${JSON.stringify(VALID_ENTRY_KINDS)}; got ${JSON.stringify(rawEntryKind)}`,
		);
	}
	if (rawEntryKind === "missing" || rawEntryKind === "directory" || rawEntryKind === "special") {
		return Object.freeze({
			targetPath: validTarget,
			resolvedPath: validResolved,
			kind: rawEntryKind,
			isSqliteFamily: false,
			helperPid: input.helperPid,
		});
	}
	if (!(input.headerBytes instanceof Uint8Array)) {
		throw new RawIoClassificationMismatchError(
			"POST-RAWIO-1",
			"headerBytes must be a Uint8Array when entryKind is 'file'",
		);
	}
	const kind: ClassificationKind = SQLITE_SIDECAR_SUFFIXES.some(suffix => validResolved.endsWith(suffix))
		? "sqlite_sidecar"
		: hasSqliteHeaderMagic(input.headerBytes)
			? "sqlite_db"
			: "non_sqlite";
	return Object.freeze({
		targetPath: validTarget,
		resolvedPath: validResolved,
		kind,
		isSqliteFamily: kind === "sqlite_db" || kind === "sqlite_sidecar",
		helperPid: input.helperPid,
	});
}

export function validateHelperFailureError(
	errorMessage: unknown,
	expectedOperation: string,
	expectedPath: string,
): string {
	if (typeof errorMessage !== "string" || errorMessage.trim().length === 0) {
		throw new RawIoClassificationMismatchError(
			"ERRORS-RAWIO-1",
			`error message must be a non-empty string naming operation '${expectedOperation}' and path '${expectedPath}'`,
		);
	}
	if (!errorMessage.includes(expectedOperation) || !errorMessage.includes(expectedPath)) {
		throw new RawIoClassificationMismatchError(
			"ERRORS-RAWIO-1",
			`error message '${errorMessage}' must name operation '${expectedOperation}' and path '${expectedPath}'`,
		);
	}
	return errorMessage;
}

// =============================================================================
// Artifact 5: Traceability map
// =============================================================================

export const RAW_IO_HELPER_CONTRACT = {
	"PRE-RAWIO-1": {
		verification: "test",
		text: "Target path supplied to the Raw-I/O Helper classifier or reader is a non-empty POSIX absolute filesystem path starting with '/'. Source: REQ-L15586-05, IP-2.",
	},
	"POST-RAWIO-1": {
		verification: "test",
		text: "The Raw-I/O Helper classifies a target as SQLite-Family ('sqlite_sidecar' when its resolved real path ends with '-wal', '-shm', or '-journal'; 'sqlite_db' when its first 16 bytes equal 'SQLite format 3\\0') and as 'non_sqlite' (or 'missing'/'directory'/'special') otherwise, returning only bytes and metadata (RawIoTargetClassification) to omp. Source: REQ-L15586-05, IP-2.",
	},
	"POST-RAWIO-1b": {
		verification: "test",
		text: "Classifying a target through the Raw-I/O Helper closes no file descriptor for that target inside the omp process and retains every POSIX advisory lock omp holds on SQLite database and sidecar inodes. Source: INV-L15586-01, REQ-L15586-05, REQ-L15586-28.",
	},
	"POST-RAWIO-2": {
		verification: "test",
		text: "The worker-selector module (@oh-my-pi/pi-coding-agent/cli/worker-selectors) exports RAW_IO_WORKER_ARG ('__omp_worker_raw_io'), and the Raw-I/O client module (@oh-my-pi/pi-coding-agent/tools/raw-io-client) exports classifyRawIoTarget(targetPath, options?) -> Promise<RawIoTargetClassification> (where options.helperSpawnCommand.cmd is an optional spawn-command override for fault-injection testing of helper startup failure) and stopRawIoHelper() -> Promise<void> to terminate the helper subprocess. Source: REQ-L15586-05, REQ-L15586-08, SEQ-5, SEQ-6, IP-2.",
	},
	"ERRORS-RAWIO-1": {
		verification: "test",
		text: "When the Raw-I/O Helper cannot start, crashes, or fails during a classification or byte-read request, omp surfaces an error that names both the failed operation and the target path. Source: REQ-L15586-08.",
	},
	"FORBIDDEN-RAWIO-1": {
		verification: "test",
		text: "The Raw-I/O Helper SHALL NOT open a SQLite database connection. Source: INV-L15586-02.",
	},
	"FORBIDDEN-RAWIO-1b": {
		verification: "test",
		text: "omp SHALL NOT fall back to an in-process file open when the Raw-I/O Helper is unavailable or fails. Source: INV-L15586-03, REQ-L15586-08.",
	},
	"FORBIDDEN-RAWIO-2": {
		verification: "test",
		text: "omp SHALL NOT run the Raw-I/O Helper as an in-process thread or Worker (helperPid SHALL be a live OS process ID distinct from omp's process.pid). Source: INV-L15586-13.",
	},
	"FORBIDDEN-RAWIO-2b": {
		verification: "test",
		text: "omp SHALL NOT receive from another process a file descriptor for a file opened by a Trigger Path. Source: INV-L15586-12.",
	},
} as const satisfies Record<string, Clause>;

export type RawIoHelperClauseId = keyof typeof RAW_IO_HELPER_CONTRACT;
