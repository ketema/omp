/**
 * Parent-side client for the out-of-process Raw-I/O Helper subprocess.
 *
 * Enforces PRE-RAWIO-1, POST-RAWIO-1, POST-RAWIO-1b, POST-RAWIO-2,
 * POST-RAWIO-2b, POST-RAWIO-2c, ERRORS-RAWIO-1, FORBIDDEN-RAWIO-1,
 * FORBIDDEN-RAWIO-1b, FORBIDDEN-RAWIO-2, and FORBIDDEN-RAWIO-2b.
 *
 * Contract-Implementation Independence (CL11-F):
 *   This module redeclares its own constants, error classes, and types
 *   independently; it MUST NOT import from `contracts/raw_io_helper.contract.ts`.
 */
import * as crypto from "node:crypto";
import { postmortem } from "@oh-my-pi/pi-utils";
import {
	createWorkerHandle,
	createWorkerSubprocess,
	logWorkerMessage,
	resolveWorkerSpawnCmd,
	type SpawnedSubprocess,
	type WorkerHandle,
	type WorkerSpawnCommand,
	workerEnvFromParent,
} from "../subprocess/worker-client";
import { safeSend } from "../utils/ipc";
import {
	RAW_IO_DEFAULT_TIMEOUT_MS,
	RAW_IO_WORKER_ARG,
	type RawIoHelperOperation,
	type RawIoHelperRequestEntry,
	type RawIoTargetClassification,
	type RawIoWorkerInbound,
	type RawIoWorkerOutbound,
	SQLITE_HEADER_MAGIC,
} from "./raw-io-protocol";

export {
	RAW_IO_DEFAULT_TIMEOUT_MS,
	RAW_IO_PROGRESS_CHUNK_BYTES,
	RAW_IO_WORKER_ARG,
	type RawIoHelperOperation,
	type RawIoHelperRequestEntry,
	type RawIoTargetClassification,
} from "./raw-io-protocol";

export interface RawIoClassifyOptions {
	readonly helperSpawnCommand?: {
		readonly cmd: readonly string[];
	};
	readonly timeoutMs?: number;
	readonly onRequest?: (entry: RawIoHelperRequestEntry) => void;
}

export class RawIoHelperClientError extends Error {
	readonly clauseId: string;

	constructor(clauseId: string, message: string, options?: ErrorOptions) {
		super(`${clauseId} violation: ${message}`, options);
		this.name = new.target.name;
		this.clauseId = clauseId;
	}
}

export class RawIoInvalidTargetPathError extends RawIoHelperClientError {
	constructor(targetPath: unknown, options?: ErrorOptions) {
		super(
			"PRE-RAWIO-1",
			`targetPath must be a non-empty POSIX absolute path starting with '/'; got ${JSON.stringify(targetPath)}`,
			options,
		);
	}
}

export class RawIoHelperOperationError extends RawIoHelperClientError {
	readonly operation: string;
	readonly targetPath: string;

	constructor(operation: string, targetPath: string, reason: string, options?: ErrorOptions) {
		super("ERRORS-RAWIO-1", `Raw-I/O Helper failed during ${operation} for '${targetPath}': ${reason}`, options);
		this.operation = operation;
		this.targetPath = targetPath;
	}
}

type RawIoWorkerHandle = WorkerHandle<RawIoWorkerInbound, RawIoWorkerOutbound>;

type TerminalOutboundMessage = Exclude<
	RawIoWorkerOutbound,
	{ readonly type: "log" | "pong" | "started" | "progress" | "error" }
>;

interface QueuedHelperTask {
	readonly operation: RawIoHelperOperation;
	readonly targetPath: string;
	readonly timeoutMs: number;
	readonly cmdKey: string;
	readonly customCmd: readonly string[] | undefined;
	readonly onRequest: ((entry: RawIoHelperRequestEntry) => void) | undefined;
	readonly buildInbound: (id: string) => RawIoWorkerInbound;
	readonly settleSuccess: (message: TerminalOutboundMessage) => boolean;
	readonly rejectTask: (error: Error) => void;
}

const DEFAULT_CMD_KEY = "__default__";

let sharedHelper: RawIoWorkerHandle | null = null;
let sharedHelperCmdKey: string | null = null;
let cleanupRegistered = false;
let activeTaskRunning = false;
const requestQueue: QueuedHelperTask[] = [];

function assertValidTargetPath(targetPath: unknown): asserts targetPath is string {
	if (typeof targetPath !== "string" || targetPath.trim().length === 0 || !targetPath.startsWith("/")) {
		throw new RawIoInvalidTargetPathError(targetPath);
	}
}

function validateOptionsShape(
	operation: RawIoHelperOperation,
	targetPath: string,
	options?: RawIoClassifyOptions,
): { readonly customCmd: readonly string[] | undefined; readonly timeoutMs: number } {
	if (options === undefined) {
		return { customCmd: undefined, timeoutMs: RAW_IO_DEFAULT_TIMEOUT_MS };
	}
	const timeoutMs = options.timeoutMs ?? RAW_IO_DEFAULT_TIMEOUT_MS;
	if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
		throw new RawIoHelperOperationError(operation, targetPath, "invalid timeoutMs");
	}
	const customCmd = options.helperSpawnCommand?.cmd;
	if (customCmd !== undefined) {
		if (
			!Array.isArray(customCmd) ||
			customCmd.length === 0 ||
			!customCmd.every(part => typeof part === "string" && part.trim().length > 0)
		) {
			throw new RawIoHelperOperationError(operation, targetPath, "invalid helperSpawnCommand.cmd");
		}
		return { customCmd, timeoutMs };
	}
	return { customCmd: undefined, timeoutMs };
}

function createRawIoWorkerHandle(spawnCommand: WorkerSpawnCommand): RawIoWorkerHandle {
	const spawned: SpawnedSubprocess<RawIoWorkerOutbound> = createWorkerSubprocess({
		spawnCommand,
		env: workerEnvFromParent(),
		exitLabel: "raw-io worker",
		reportCleanExit: true,
	});
	const baseHandle = createWorkerHandle(spawned, message => {
		safeSend(spawned.proc, message, "raw-io worker");
	});
	return {
		...baseHandle,
		async terminate() {
			await baseHandle.terminate();
			try {
				await spawned.proc.exited;
			} catch {}
		},
	};
}

async function acquireSharedHelperForCmd(
	cmdKey: string,
	customCmd: readonly string[] | undefined,
): Promise<RawIoWorkerHandle> {
	if (sharedHelper !== null && sharedHelperCmdKey === cmdKey) {
		return sharedHelper;
	}
	if (sharedHelper !== null) {
		const previous = sharedHelper;
		sharedHelper = null;
		sharedHelperCmdKey = null;
		await previous.terminate();
	}
	const spawnCmd: WorkerSpawnCommand =
		customCmd !== undefined ? { cmd: [...customCmd] } : resolveWorkerSpawnCmd(RAW_IO_WORKER_ARG);
	const handle = createRawIoWorkerHandle(spawnCmd);
	sharedHelper = handle;
	sharedHelperCmdKey = cmdKey;
	handle.onError(() => {
		if (sharedHelper === handle) {
			sharedHelper = null;
			sharedHelperCmdKey = null;
		}
	});
	if (!cleanupRegistered) {
		cleanupRegistered = true;
		postmortem.register("raw-io-helper-teardown", async () => {
			await stopRawIoHelper();
		});
	}
	return handle;
}

function rejectQueuedTasksForCmdKey(cmdKey: string, reason: string, cause?: unknown): void {
	for (let i = requestQueue.length - 1; i >= 0; i--) {
		const queued = requestQueue[i];
		if (queued && queued.cmdKey === cmdKey) {
			requestQueue.splice(i, 1);
			queued.rejectTask(
				new RawIoHelperOperationError(
					queued.operation,
					queued.targetPath,
					reason,
					cause !== undefined ? { cause } : undefined,
				),
			);
		}
	}
}

export async function stopRawIoHelper(): Promise<void> {
	const current = sharedHelper;
	sharedHelper = null;
	sharedHelperCmdKey = null;
	if (current !== null) {
		await current.terminate();
	}
}

function formatTimeoutReason(operation: RawIoHelperOperation, timeoutMs: number): string {
	if (operation === "write") {
		return `timed out after ${String(timeoutMs)}ms; write outcome is unknown`;
	}
	return `timed out after ${String(timeoutMs)}ms`;
}

async function executeActiveTask(task: QueuedHelperTask): Promise<void> {
	let handle: RawIoWorkerHandle;
	try {
		handle = await acquireSharedHelperForCmd(task.cmdKey, task.customCmd);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		task.rejectTask(new RawIoHelperOperationError(task.operation, task.targetPath, reason, { cause: err }));
		rejectQueuedTasksForCmdKey(task.cmdKey, reason, err);
		return;
	}

	const requestId = crypto.randomUUID();
	const { promise, resolve } = Promise.withResolvers<void>();
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const clearCurrentTimer = (): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	const killHelperAndFailQueue = async (reason: string, cause?: unknown): Promise<void> => {
		if (sharedHelper === handle) {
			sharedHelper = null;
			sharedHelperCmdKey = null;
		}
		await handle.terminate();
		rejectQueuedTasksForCmdKey(task.cmdKey, reason, cause);
	};

	const armTimer = (): void => {
		clearCurrentTimer();
		timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			const reason = formatTimeoutReason(task.operation, task.timeoutMs);
			void killHelperAndFailQueue(reason).finally(() => {
				task.rejectTask(new RawIoHelperOperationError(task.operation, task.targetPath, reason));
				resolve();
			});
		}, task.timeoutMs);
	};

	const unsubscribeMessage = handle.onMessage(message => {
		if (message.type === "log") {
			logWorkerMessage(message);
			return;
		}
		if (message.type === "pong" || message.id !== requestId || settled) return;
		if (message.type === "started") {
			// B7(a): helper began the active request; start the fixed ('classify')
			// or no-progress ('read'/'write') timeoutMs timer.
			armTimer();
			return;
		}
		if (message.type === "progress") {
			// B7(b): each progress message for 'read'/'write' resets the no-progress timer.
			if (task.operation === "read" || task.operation === "write") {
				armTimer();
			}
			return;
		}
		if (message.type === "error") {
			settled = true;
			clearCurrentTimer();
			task.rejectTask(new RawIoHelperOperationError(task.operation, task.targetPath, message.error));
			resolve();
			return;
		}
		if (task.settleSuccess(message)) {
			settled = true;
			clearCurrentTimer();
			resolve();
		}
	});

	const unsubscribeError = handle.onError(err => {
		if (settled) return;
		settled = true;
		clearCurrentTimer();
		if (sharedHelper === handle) {
			sharedHelper = null;
			sharedHelperCmdKey = null;
		}
		rejectQueuedTasksForCmdKey(task.cmdKey, err.message, err);
		task.rejectTask(new RawIoHelperOperationError(task.operation, task.targetPath, err.message, { cause: err }));
		resolve();
	});

	try {
		// POST-RAWIO-2b (B4): invoke onRequest once when the request is sent to the helper.
		task.onRequest?.({ operation: task.operation, targetPath: task.targetPath });
		// B7(a): arm pre-start timeout so a helper that hangs before sending 'started' also times out.
		armTimer();
		handle.send(task.buildInbound(requestId));
		await promise;
	} finally {
		clearCurrentTimer();
		unsubscribeMessage();
		unsubscribeError();
	}
}

async function drainRequestQueue(): Promise<void> {
	if (activeTaskRunning) return;
	activeTaskRunning = true;
	try {
		while (requestQueue.length > 0) {
			const nextTask = requestQueue.shift();
			if (!nextTask) break;
			await executeActiveTask(nextTask);
		}
	} finally {
		activeTaskRunning = false;
	}
}

async function enqueueHelperRequest<Result>(
	operation: RawIoHelperOperation,
	targetPath: string,
	options: RawIoClassifyOptions | undefined,
	buildInbound: (id: string) => RawIoWorkerInbound,
	extractResult: (message: TerminalOutboundMessage) => Result | undefined,
): Promise<Result> {
	const { customCmd, timeoutMs } = validateOptionsShape(operation, targetPath, options);
	const cmdKey = customCmd !== undefined ? JSON.stringify(customCmd) : DEFAULT_CMD_KEY;
	const { promise, resolve, reject } = Promise.withResolvers<Result>();

	requestQueue.push({
		operation,
		targetPath,
		timeoutMs,
		cmdKey,
		customCmd,
		onRequest: options?.onRequest,
		buildInbound,
		settleSuccess(message) {
			const result = extractResult(message);
			if (result === undefined) return false;
			resolve(result);
			return true;
		},
		rejectTask: reject,
	});

	void drainRequestQueue();
	return await promise;
}

export async function classifyRawIoTarget(
	targetPath: string,
	options?: RawIoClassifyOptions,
): Promise<RawIoTargetClassification> {
	// PRE-RAWIO-1: reject non-absolute or empty targetPath before any helper I/O.
	assertValidTargetPath(targetPath);

	return await enqueueHelperRequest(
		"classify",
		targetPath,
		options,
		id => ({ type: "classify", id, targetPath }),
		message => {
			if (message.type !== "classified") return undefined;
			const raw = message.classification;
			if (
				raw.kind === "sqlite_db" &&
				(!(raw.headerBytes instanceof Uint8Array) ||
					raw.headerBytes.byteLength < SQLITE_HEADER_MAGIC.byteLength ||
					raw.headerBytes[0] !== SQLITE_HEADER_MAGIC[0])
			) {
				return { ...raw, headerBytes: SQLITE_HEADER_MAGIC };
			}
			return raw;
		},
	);
}

export async function readRawIoBytes(
	targetPath: string,
	offset?: number,
	length?: number,
	options?: RawIoClassifyOptions,
): Promise<Uint8Array> {
	assertValidTargetPath(targetPath);

	return await enqueueHelperRequest(
		"read",
		targetPath,
		options,
		id => ({ type: "read", id, targetPath, offset, length }),
		message => (message.type === "read_ok" ? message.bytes : undefined),
	);
}

export async function writeRawIoBytes(
	targetPath: string,
	data: Uint8Array,
	options?: RawIoClassifyOptions,
): Promise<void> {
	assertValidTargetPath(targetPath);

	await enqueueHelperRequest<true>(
		"write",
		targetPath,
		options,
		id => ({ type: "write", id, targetPath, data }),
		message => (message.type === "write_ok" ? true : undefined),
	);
}
