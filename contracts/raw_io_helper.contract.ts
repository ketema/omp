/**
 * Raw-I/O Helper Contract - specification authority (TypeScript native).
 *
 * Authoritative Contract for SLICE-4 (REQ-L15586-05, REQ-L15586-31, REQ-L15586-08,
 * REQ-L15586-28; negative constraints INV-L15586-01, INV-L15586-02, INV-L15586-03,
 * INV-L15586-04, INV-L15586-12, INV-L15586-13; sequence SEQ-2, SEQ-5, SEQ-6;
 * integration points IP-2).
 *
 * Contract-Implementation Independence (CL11-F):
 *   Tests in packages/coding-agent/test/tools/ import this contract;
 *   production code under packages/coding-agent/src/ MUST NOT import this file.
 */

// =============================================================================
// Artifact 1: Exported Constants
// =============================================================================

export const SQLITE_HEADER_MAGIC = new Uint8Array([
	0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
]);

export const SQLITE_SIDECAR_SUFFIXES = Object.freeze(["-wal", "-shm", "-journal"] as const);

export const SQLITE_FAMILY_CLASSIFICATIONS = Object.freeze([
	"sqlite_db",
	"sqlite_sidecar",
	"non_sqlite",
	"missing",
	"directory",
	"special",
] as const);

export const VALID_ENTRY_KINDS = Object.freeze(["file", "missing", "directory", "special"] as const);

export const VALID_TOOL_NAMES = Object.freeze(["read", "write"] as const);

export const VALID_ACCESS_CHANNELS = Object.freeze(["raw_io_helper", "sqlite_connection", "in_process"] as const);
export const VALID_HELPER_OPERATIONS = Object.freeze(["classify", "read", "write"] as const);
export const VALID_QUEUED_TIMEOUT_ACTIONS = Object.freeze(["none", "retry_on_fresh_helper"] as const);
export const RAW_IO_WORKER_ARG = "__omp_worker_raw_io" as const;
export const RAW_IO_WORKER_SELECTORS_MODULE = "@oh-my-pi/pi-coding-agent/cli/worker-selectors" as const;
export const RAW_IO_CLIENT_MODULE = "@oh-my-pi/pi-coding-agent/tools/raw-io-client" as const;
export const RAW_IO_CLASSIFY_FN_NAME = "classifyRawIoTarget" as const;
export const RAW_IO_READ_BYTES_FN_NAME = "readRawIoBytes" as const;
export const RAW_IO_WRITE_BYTES_FN_NAME = "writeRawIoBytes" as const;
export const RAW_IO_STOP_FN_NAME = "stopRawIoHelper" as const;
export const RAW_IO_DEFAULT_TIMEOUT_MS = 5000 as const;
export const RAW_IO_PROGRESS_CHUNK_BYTES = 65536 as const;
export type SqliteSidecarSuffix = (typeof SQLITE_SIDECAR_SUFFIXES)[number];
export type ClassificationKind = (typeof SQLITE_FAMILY_CLASSIFICATIONS)[number];
export type EntryKind = (typeof VALID_ENTRY_KINDS)[number];
export type ToolName = (typeof VALID_TOOL_NAMES)[number];
export type AccessChannel = (typeof VALID_ACCESS_CHANNELS)[number];
export type HelperOperation = (typeof VALID_HELPER_OPERATIONS)[number];
export type QueuedTimeoutAction = (typeof VALID_QUEUED_TIMEOUT_ACTIONS)[number];
export type VerificationMethod = "test" | "execution" | "tool";

// =============================================================================
// Artifact 2: Exception Hierarchy
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

	constructor(operation: string, targetPath: string, reason: string, options?: ErrorOptions) {
		super("ERRORS-RAWIO-1", `Raw-I/O Helper failed during ${operation} for '${targetPath}': ${reason}`, options);
		this.operation = operation;
		this.targetPath = targetPath;
	}
}

// =============================================================================
// Artifact 3: Structural Interfaces (Typed Records)
// =============================================================================

export interface RawIoTargetClassification {
	readonly targetPath: string;
	readonly resolvedPath: string;
	readonly kind: ClassificationKind;
	readonly isSqliteFamily: boolean;
	readonly helperPid: number;
	readonly headerBytes?: Uint8Array | undefined;
	readonly entryKind?: EntryKind | undefined;
}

export interface ClassifyResolvedTargetInput {
	readonly targetPath: unknown;
	readonly resolvedPath: unknown;
	readonly headerBytes: unknown;
	readonly helperPid: unknown;
	readonly parentPid: number;
	readonly entryKind?: unknown;
}

export interface RawIoHelperRequestEntry {
	readonly operation: HelperOperation;
	readonly targetPath: string;
}

export interface RawIoClassifyOptions {
	readonly helperSpawnCommand?: {
		readonly cmd: readonly string[];
	};
	readonly timeoutMs?: number;
	readonly onRequest?: (entry: RawIoHelperRequestEntry) => void;
}

export interface RawIoClassifyOptionsSpec {
	readonly helperSpawnCmd: readonly string[] | undefined;
	readonly timeoutMs: number;
}

export interface RawIoClientSurface {
	readonly classifyRawIoTarget: (
		targetPath: string,
		options?: RawIoClassifyOptions,
	) => Promise<RawIoTargetClassification>;
	readonly readRawIoBytes: (
		targetPath: string,
		offset?: number,
		length?: number,
		options?: RawIoClassifyOptions,
	) => Promise<Uint8Array>;
	readonly writeRawIoBytes: (targetPath: string, data: Uint8Array, options?: RawIoClassifyOptions) => Promise<void>;
	readonly stopRawIoHelper: () => Promise<void>;
}

export interface RawIoToolAccessRecord {
	readonly toolName: ToolName;
	readonly classification: RawIoTargetClassification;
	readonly accessChannel: AccessChannel;
	readonly classifiedBeforeOpen: true;
}
export interface RawIoTimeoutEvaluation {
	readonly operation: HelperOperation;
	readonly timeoutMs: number;
	readonly queuedWaitMs: number;
	readonly startedReceived: boolean;
	readonly elapsedBeforeStartMs: number;
	readonly elapsedSinceStartMs: number;
	readonly elapsedSinceProgressMs: number;
	readonly timedOut: boolean;
	readonly helperKilled: boolean;
	readonly queuedRequestsCount: number;
	readonly queuedAction: QueuedTimeoutAction;
}

export interface EvaluateTimeoutSemanticsInput {
	readonly operation: unknown;
	readonly timeoutMs: unknown;
	readonly queuedWaitMs?: unknown;
	readonly startedReceived?: unknown;
	readonly elapsedBeforeStartMs?: unknown;
	readonly elapsedSinceStartMs: unknown;
	readonly elapsedSinceProgressMs: unknown;
	readonly helperKilled: unknown;
	readonly queuedRequestsCount?: unknown;
	readonly queuedAction?: unknown;
}
export interface Clause {
	readonly verification: VerificationMethod;
	readonly text: string;
}
// =============================================================================
// Artifact 4: Pure Validators
// =============================================================================

export function isEntryKind(value: unknown): value is EntryKind {
	return value === "file" || value === "missing" || value === "directory" || value === "special";
}

export function isToolName(value: unknown): value is ToolName {
	return value === "read" || value === "write";
}

export function isHelperOperation(value: unknown): value is HelperOperation {
	return value === "classify" || value === "read" || value === "write";
}

export function isAccessChannel(value: unknown): value is AccessChannel {
	return value === "raw_io_helper" || value === "sqlite_connection" || value === "in_process";
}

export function validateTargetPath(targetPath: unknown): string {
	if (typeof targetPath !== "string") {
		throw new RawIoInvalidTargetPathError(targetPath);
	}
	const trimmed = targetPath.trim();
	if (trimmed.length === 0 || !trimmed.startsWith("/")) {
		throw new RawIoInvalidTargetPathError(targetPath);
	}
	return targetPath;
}

export function validateClassifyOptions(options: unknown): RawIoClassifyOptionsSpec {
	if (options === undefined || options === null) {
		return Object.freeze({ helperSpawnCmd: undefined, timeoutMs: RAW_IO_DEFAULT_TIMEOUT_MS });
	}
	if (typeof options !== "object" || Array.isArray(options)) {
		throw new RawIoClassificationMismatchError(
			"POST-RAWIO-2b",
			`options must be an object or undefined; got ${typeof options}`,
		);
	}
	const rawTimeout = Reflect.get(options, "timeoutMs") ?? RAW_IO_DEFAULT_TIMEOUT_MS;
	if (typeof rawTimeout !== "number" || !Number.isInteger(rawTimeout) || rawTimeout <= 0) {
		throw new RawIoClassificationMismatchError(
			"ERRORS-RAWIO-1",
			`timeoutMs must be a positive integer (> 0); got ${JSON.stringify(rawTimeout)}`,
		);
	}
	const spawn = Reflect.get(options, "helperSpawnCommand");
	if (spawn === undefined || spawn === null) {
		return Object.freeze({ helperSpawnCmd: undefined, timeoutMs: rawTimeout });
	}
	if (typeof spawn !== "object" || Array.isArray(spawn)) {
		throw new RawIoClassificationMismatchError(
			"POST-RAWIO-2b",
			`helperSpawnCommand must be an object; got ${typeof spawn}`,
		);
	}
	const cmd = Reflect.get(spawn, "cmd");
	if (
		!Array.isArray(cmd) ||
		cmd.length === 0 ||
		!cmd.every(part => typeof part === "string" && part.trim().length > 0)
	) {
		throw new RawIoClassificationMismatchError(
			"POST-RAWIO-2b",
			"helperSpawnCommand.cmd must be a non-empty array of non-empty strings",
		);
	}
	return Object.freeze({ helperSpawnCmd: Object.freeze([...cmd]), timeoutMs: rawTimeout });
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
			`helperPid (${String(input.helperPid)}) must be a positive OS PID distinct from omp parentPid (${String(input.parentPid)})`,
		);
	}
	const rawEntryKind = input.entryKind ?? "file";
	if (!isEntryKind(rawEntryKind)) {
		throw new RawIoClassificationMismatchError(
			"POST-RAWIO-1",
			`entryKind must be one of ${JSON.stringify(VALID_ENTRY_KINDS)}; got ${JSON.stringify(rawEntryKind)}`,
		);
	}
	if (rawEntryKind !== "file") {
		return Object.freeze({
			targetPath: validTarget,
			resolvedPath: validResolved,
			kind: rawEntryKind,
			isSqliteFamily: false,
			helperPid: input.helperPid,
			headerBytes: new Uint8Array(0),
			entryKind: rawEntryKind,
		});
	}
	if (!(input.headerBytes instanceof Uint8Array)) {
		throw new RawIoClassificationMismatchError(
			"POST-RAWIO-1",
			`headerBytes must be a Uint8Array for regular files; got ${typeof input.headerBytes}`,
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
		headerBytes: input.headerBytes.slice(0, SQLITE_HEADER_MAGIC.byteLength),
		entryKind: "file",
	});
}

export function validateHelperFailureError(
	errorMessage: unknown,
	expectedOperation: string,
	expectedPath: string,
	options?: { readonly timedOut?: boolean },
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
			`error message ${JSON.stringify(errorMessage)} must include operation '${expectedOperation}' and target path '${expectedPath}'`,
		);
	}
	if (options?.timedOut === true) {
		const lower = errorMessage.toLowerCase();
		if (!lower.includes("timed out") && !lower.includes("timeout")) {
			throw new RawIoClassificationMismatchError(
				"ERRORS-RAWIO-1",
				`timed-out error message ${JSON.stringify(errorMessage)} must indicate a timeout`,
			);
		}
		if (
			expectedOperation === "write" &&
			!lower.includes("outcome is unknown") &&
			!lower.includes("outcome unknown")
		) {
			throw new RawIoClassificationMismatchError(
				"ERRORS-RAWIO-1",
				`timed-out write error ${JSON.stringify(errorMessage)} must state that the write outcome is unknown`,
			);
		}
	}
	return errorMessage;
}

export function isQueuedTimeoutAction(value: unknown): value is QueuedTimeoutAction {
	return value === "none" || value === "retry_on_fresh_helper";
}

export function evaluateTimeoutSemantics(input: EvaluateTimeoutSemanticsInput): RawIoTimeoutEvaluation {
	if (!isHelperOperation(input.operation)) {
		throw new RawIoClassificationMismatchError(
			"POST-RAWIO-2b",
			`operation must be one of ${JSON.stringify(VALID_HELPER_OPERATIONS)}; got ${JSON.stringify(input.operation)}`,
		);
	}
	if (typeof input.timeoutMs !== "number" || !Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0) {
		throw new RawIoClassificationMismatchError(
			"ERRORS-RAWIO-1",
			`timeoutMs must be a positive integer (> 0); got ${JSON.stringify(input.timeoutMs)}`,
		);
	}
	const startedReceived = input.startedReceived ?? true;
	if (typeof startedReceived !== "boolean") {
		throw new RawIoClassificationMismatchError(
			"POST-RAWIO-2b",
			`startedReceived must be a boolean; got ${JSON.stringify(startedReceived)}`,
		);
	}
	const queuedWaitMs = input.queuedWaitMs ?? 0;
	const elapsedBeforeStartMs = input.elapsedBeforeStartMs ?? 0;
	const queuedRequestsCount = input.queuedRequestsCount ?? 0;
	if (
		typeof queuedWaitMs !== "number" ||
		!Number.isInteger(queuedWaitMs) ||
		queuedWaitMs < 0 ||
		typeof elapsedBeforeStartMs !== "number" ||
		!Number.isInteger(elapsedBeforeStartMs) ||
		elapsedBeforeStartMs < 0 ||
		typeof input.elapsedSinceStartMs !== "number" ||
		!Number.isInteger(input.elapsedSinceStartMs) ||
		input.elapsedSinceStartMs < 0 ||
		typeof input.elapsedSinceProgressMs !== "number" ||
		!Number.isInteger(input.elapsedSinceProgressMs) ||
		input.elapsedSinceProgressMs < 0 ||
		typeof queuedRequestsCount !== "number" ||
		!Number.isInteger(queuedRequestsCount) ||
		queuedRequestsCount < 0
	) {
		throw new RawIoClassificationMismatchError(
			"POST-RAWIO-2b",
			"queuedWaitMs, elapsedBeforeStartMs, elapsedSinceStartMs, elapsedSinceProgressMs, and queuedRequestsCount must be non-negative integers",
		);
	}
	if (typeof input.helperKilled !== "boolean") {
		throw new RawIoClassificationMismatchError(
			"ERRORS-RAWIO-1",
			`helperKilled must be a boolean; got ${JSON.stringify(input.helperKilled)}`,
		);
	}
	const timedOut = !startedReceived
		? elapsedBeforeStartMs >= input.timeoutMs
		: input.operation === "classify"
			? input.elapsedSinceStartMs >= input.timeoutMs
			: input.elapsedSinceProgressMs >= input.timeoutMs;
	if (timedOut && !input.helperKilled) {
		throw new RawIoClassificationMismatchError(
			"ERRORS-RAWIO-1",
			"omp must kill the helper subprocess when a request times out",
		);
	}
	const expectedQueuedAction: QueuedTimeoutAction =
		timedOut && queuedRequestsCount > 0 ? "retry_on_fresh_helper" : "none";
	const resolvedQueuedAction = input.queuedAction ?? expectedQueuedAction;
	if (!isQueuedTimeoutAction(resolvedQueuedAction) || resolvedQueuedAction !== expectedQueuedAction) {
		throw new RawIoClassificationMismatchError(
			"ERRORS-RAWIO-1",
			`queuedAction must be '${expectedQueuedAction}' when timedOut=${String(timedOut)} and queuedRequestsCount=${String(queuedRequestsCount)}; got ${JSON.stringify(input.queuedAction)}`,
		);
	}
	return Object.freeze({
		operation: input.operation,
		timeoutMs: input.timeoutMs,
		queuedWaitMs,
		startedReceived,
		elapsedBeforeStartMs,
		elapsedSinceStartMs: input.elapsedSinceStartMs,
		elapsedSinceProgressMs: input.elapsedSinceProgressMs,
		timedOut,
		helperKilled: input.helperKilled,
		queuedRequestsCount,
		queuedAction: expectedQueuedAction,
	});
}
export function validateToolAccessRoute(
	toolName: unknown,
	classification: RawIoTargetClassification,
	accessChannel: unknown,
	classifiedBeforeOpen: unknown,
): RawIoToolAccessRecord {
	if (!isToolName(toolName)) {
		throw new RawIoClassificationMismatchError(
			"POST-RAWIO-3",
			`toolName must be one of ${JSON.stringify(VALID_TOOL_NAMES)}; got ${JSON.stringify(toolName)}`,
		);
	}
	const clauseId = toolName === "read" ? "POST-RAWIO-3" : "POST-RAWIO-3b";
	if (classifiedBeforeOpen !== true) {
		throw new RawIoClassificationMismatchError(
			clauseId,
			`${toolName} tool must classify target via Raw-I/O Helper before any open`,
		);
	}
	if (!isAccessChannel(accessChannel)) {
		throw new RawIoClassificationMismatchError(
			clauseId,
			`accessChannel must be one of ${JSON.stringify(VALID_ACCESS_CHANNELS)}; got ${JSON.stringify(accessChannel)}`,
		);
	}
	if (classification.isSqliteFamily) {
		if (accessChannel === "in_process") {
			throw new RawIoClassificationMismatchError(
				"FORBIDDEN-RAWIO-3",
				`${toolName} tool accessed SQLite-Family target '${classification.resolvedPath}' in-process`,
			);
		}
	} else if (classification.kind === "non_sqlite" && accessChannel !== "in_process") {
		throw new RawIoClassificationMismatchError(
			"POST-RAWIO-3c",
			`${toolName} tool must keep non_sqlite target '${classification.resolvedPath}' on the in_process fast path; got ${JSON.stringify(accessChannel)}`,
		);
	}
	return Object.freeze({
		toolName,
		classification,
		accessChannel,
		classifiedBeforeOpen: true,
	});
}

export function validateNonSqliteHelperLog(
	entries: unknown,
	nonSqlitePath: unknown,
): ReadonlyArray<RawIoHelperRequestEntry> {
	const validPath = validateTargetPath(nonSqlitePath);
	if (!Array.isArray(entries)) {
		throw new RawIoClassificationMismatchError("POST-RAWIO-3c", `entries must be an array; got ${typeof entries}`);
	}
	const validated: RawIoHelperRequestEntry[] = [];
	let sawClassify = false;
	for (const item of entries) {
		if (typeof item !== "object" || item === null) {
			throw new RawIoClassificationMismatchError(
				"POST-RAWIO-3c",
				`log entry must be an object; got ${JSON.stringify(item)}`,
			);
		}
		const op = Reflect.get(item, "operation");
		const pathVal = Reflect.get(item, "targetPath") ?? Reflect.get(item, "target_path");
		if (!isHelperOperation(op)) {
			throw new RawIoClassificationMismatchError(
				"POST-RAWIO-3c",
				`operation must be one of ${JSON.stringify(VALID_HELPER_OPERATIONS)}; got ${JSON.stringify(op)}`,
			);
		}
		const validEntryPath = validateTargetPath(pathVal);
		if (validEntryPath === validPath) {
			if (op === "classify") {
				sawClassify = true;
			} else {
				throw new RawIoClassificationMismatchError(
					"POST-RAWIO-3c",
					`non_sqlite target '${validPath}' must not send '${op}' byte requests to the Raw-I/O Helper`,
				);
			}
		}
		validated.push(Object.freeze({ operation: op, targetPath: validEntryPath }));
	}
	if (!sawClassify) {
		throw new RawIoClassificationMismatchError(
			"POST-RAWIO-3c",
			`expected at least one 'classify' request for non_sqlite target '${validPath}'`,
		);
	}
	return Object.freeze(validated);
}

export function validateSqliteFamilyHelperLog(
	entries: unknown,
	sqliteFamilyPath: unknown,
	expectedOperations: ReadonlyArray<HelperOperation> = ["classify", "read", "write"],
): ReadonlyArray<RawIoHelperRequestEntry> {
	const validPath = validateTargetPath(sqliteFamilyPath);
	if (!Array.isArray(entries)) {
		throw new RawIoClassificationMismatchError("POST-RAWIO-3", `entries must be an array; got ${typeof entries}`);
	}
	const validated: RawIoHelperRequestEntry[] = [];
	const seenOps = new Set<HelperOperation>();
	for (const item of entries) {
		if (typeof item !== "object" || item === null) {
			throw new RawIoClassificationMismatchError(
				"POST-RAWIO-3",
				`log entry must be an object; got ${JSON.stringify(item)}`,
			);
		}
		const op = Reflect.get(item, "operation");
		const pathVal = Reflect.get(item, "targetPath") ?? Reflect.get(item, "target_path");
		if (!isHelperOperation(op)) {
			throw new RawIoClassificationMismatchError(
				"POST-RAWIO-3",
				`operation must be one of ${JSON.stringify(VALID_HELPER_OPERATIONS)}; got ${JSON.stringify(op)}`,
			);
		}
		const validEntryPath = validateTargetPath(pathVal);
		if (validEntryPath === validPath) {
			seenOps.add(op);
		}
		validated.push(Object.freeze({ operation: op, targetPath: validEntryPath }));
	}
	for (const reqOp of expectedOperations) {
		if (!seenOps.has(reqOp)) {
			const clauseId = reqOp === "write" ? "POST-RAWIO-3b" : "POST-RAWIO-3";
			throw new RawIoClassificationMismatchError(
				clauseId,
				`expected '${reqOp}' helper request for SQLite-Family target '${validPath}'; seen=${JSON.stringify([...seenOps].sort())}`,
			);
		}
	}
	return Object.freeze(validated);
}

// =============================================================================
// Artifact 5: Traceability Registry
// =============================================================================

export const RAW_IO_HELPER_CONTRACT = Object.freeze({
	"PRE-RAWIO-1": {
		verification: "test",
		text: "Target path passed to the Raw-I/O Helper classifier is a non-empty POSIX absolute path starting with '/'. Source: REQ-L15586-05, IP-2.",
	},
	"POST-RAWIO-1": {
		verification: "test",
		text: "The Raw-I/O Helper resolves the target path in a separate OS process and returns kind='missing', 'directory', or 'special' (with isSqliteFamily=false) when the resolved target is not an existing regular file, even if its path ends in -wal, -shm, or -journal; for an existing regular file, it classifies the target as 'sqlite_sidecar' when resolvedPath (not targetPath alone) ends in -wal, -shm, or -journal, 'sqlite_db' when its first 16 bytes equal 'SQLite format 3\\x00', and 'non_sqlite' otherwise. Source: REQ-L15586-05, IP-2.",
	},
	"POST-RAWIO-1b": {
		verification: "test",
		text: "Classifying a target through the Raw-I/O Helper closes no file descriptor inside the omp process and retains every POSIX advisory lock omp holds on SQLite database and sidecar inodes. Source: INV-L15586-01, REQ-L15586-05, REQ-L15586-28.",
	},
	"POST-RAWIO-2": {
		verification: "test",
		text: "The worker-selector module (@oh-my-pi/pi-coding-agent/cli/worker-selectors) exports RAW_IO_WORKER_ARG ('__omp_worker_raw_io'), and omp's CLI entrypoint dispatches RAW_IO_WORKER_ARG to the Raw-I/O Helper worker. Source: REQ-L15586-05, SEQ-5, IP-2.",
	},
	"POST-RAWIO-2b": {
		verification: "test",
		text: "The Raw-I/O client module (@oh-my-pi/pi-coding-agent/tools/raw-io-client) exports classifyRawIoTarget(targetPath, options?) -> Promise<RawIoTargetClassification>, readRawIoBytes(targetPath, offset?, length?, options?) -> Promise<Uint8Array>, and writeRawIoBytes(targetPath, data, options?) -> Promise<void>, where options.helperSpawnCommand is an optional spawn-command override, options.timeoutMs is an optional positive integer timeout bound defaulting to RAW_IO_DEFAULT_TIMEOUT_MS (5000ms), and options.onRequest is invoked exactly once for each request sent to the Raw-I/O Helper across every operation ('classify', 'read', 'write') with that request's operation and targetPath; requests on a shared helper are dispatched strictly serially (a queued request is never sent to the helper before the active request settles and has no running timeout while waiting in the queue, so a request queued behind a timed-out request is sent—and logged via onRequest—exactly once, when dispatched to the fresh helper), the helper emits a {type: 'started', id} message when it begins the active request (which starts the fixed options.timeoutMs timer for 'classify' and the no-progress options.timeoutMs timer for 'read' and 'write'), and for 'read' and 'write' the helper transfers in bounded chunks (RAW_IO_PROGRESS_CHUNK_BYTES = 65536) and emits {type: 'progress', id, bytesProcessed} after each chunk to reset the no-progress timer. Source: REQ-L15586-05, REQ-L15586-08, REQ-L15586-31, SEQ-2, SEQ-5, IP-2.",
	},
	"POST-RAWIO-2c": {
		verification: "test",
		text: "The Raw-I/O client module (@oh-my-pi/pi-coding-agent/tools/raw-io-client) exports stopRawIoHelper() -> Promise<void> to terminate the helper subprocess. Source: SEQ-6, IP-2.",
	},
	"POST-RAWIO-3": {
		verification: "test",
		text: "When ReadTool receives a host file path, it forwards session.rawIoHelperOptions on every helper request, classifies the target out of process through the Raw-I/O Helper before any in-process file open, and accesses every SQLite-Family target (including -wal, -shm, and -journal sidecars) only through the Raw-I/O Helper (recording a 'read' entry in onRequest) or a SQLite connection (whose own connection close is permitted because SQLite retains .db and -shm locks across secondary connection closes), retaining every POSIX advisory lock SQLite holds on the database file and its -shm file, and every POSIX advisory lock omp holds on a SQLite-Family target that the tool accesses through the Raw-I/O Helper. Source: REQ-L15586-05, REQ-L15586-31, SEQ-2, IP-2, INV-L15586-01, INV-L15586-04, Q-SLICE4-01.",
	},
	"POST-RAWIO-3b": {
		verification: "test",
		text: "When WriteTool receives a host file path, it forwards session.rawIoHelperOptions on every helper request, classifies the target out of process through the Raw-I/O Helper before any in-process file open, and accesses every SQLite-Family target (including -wal, -shm, and -journal sidecars) only through the Raw-I/O Helper (recording a 'write' entry in onRequest) or a SQLite connection (whose own connection close is permitted because SQLite retains .db and -shm locks across secondary connection closes), retaining every POSIX advisory lock SQLite holds on the database file and its -shm file, and every POSIX advisory lock omp holds on a SQLite-Family target that the tool accesses through the Raw-I/O Helper. Source: REQ-L15586-05, REQ-L15586-31, SEQ-2, IP-2, INV-L15586-01, INV-L15586-04, Q-SLICE4-01.",
	},
	"POST-RAWIO-3c": {
		verification: "test",
		text: "When a host file is classified as 'non_sqlite', ReadTool and WriteTool forward session.rawIoHelperOptions and access that ordinary file on the in-process fast path so the same onRequest hook that records 'read' and 'write' entries for SQLite-Family helper targets records a 'classify' request and zero 'read' or 'write' byte requests for the 'non_sqlite' path. Source: REQ-L15586-31, SEQ-2, IP-2.",
	},
	"ERRORS-RAWIO-1": {
		verification: "test",
		text: "IF the Raw-I/O Helper cannot start, crashes, fails, or times out (when the active request does not receive {type: 'started', id} within options.timeoutMs of being sent to the helper, when 'classify' exceeds options.timeoutMs after {type: 'started', id}, or when 'read'/'write' receives no {type: 'progress', id} or completion message for options.timeoutMs after {type: 'started', id}, default RAW_IO_DEFAULT_TIMEOUT_MS = 5000ms), THEN omp SHALL kill the helper subprocess (so a timed-out write cannot land late), fail only the active request naming its operation and target path (and for a timed-out 'write', stating that its outcome is unknown), dispatch requests still queued at the kill (which were never sent to the killed helper) once in their original order to a newly spawned helper (a retried request that then fails or times out fails with the usual error naming its operation and target path, with no second retry), and SHALL NOT fall back to an in-process file open. Source: REQ-L15586-08, INV-L15586-03.",
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
	"FORBIDDEN-RAWIO-3": {
		verification: "test",
		text: "ReadTool and WriteTool SHALL NOT open or close a raw in-process file descriptor on a SQLite-Family File (including during SQLite header sniffing, WAL-version inspection, editable-file header checks, or byte reads/writes; a SQLite connection's own descriptors managed by SQLite are not raw descriptors). Source: REQ-L15586-05, REQ-L15586-31, INV-L15586-01, INV-L15586-04, Q-SLICE4-01.",
	},
} as const satisfies Record<string, Clause>);

export type RawIoHelperClauseId = keyof typeof RAW_IO_HELPER_CONTRACT;
