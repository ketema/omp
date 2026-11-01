/**
 * Parent-side client for the out-of-process Raw-I/O Helper subprocess.
 *
 * Enforces PRE-RAWIO-1, POST-RAWIO-1, POST-RAWIO-1b, POST-RAWIO-2,
 * POST-RAWIO-2b, POST-RAWIO-2c, ERRORS-RAWIO-1, ERRORS-RAWIO-1b,
 * ERRORS-RAWIO-1c, FORBIDDEN-RAWIO-1, FORBIDDEN-RAWIO-1b, FORBIDDEN-RAWIO-2,
 * and FORBIDDEN-RAWIO-2b.
 *
 * Contract-Implementation Independence (CL11-F):
 *   This module redeclares its own constants, error classes, and types
 *   independently; it MUST NOT import from `contracts/raw_io_helper.contract.ts`.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
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
	RAW_IO_KILL_WAIT_TIMEOUT_MS,
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
	RAW_IO_KILL_WAIT_TIMEOUT_MS,
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

export interface ResolveTimeoutAfterKillWaitInput {
	readonly operation: RawIoHelperOperation;
	readonly targetPath: string;
	readonly timeoutMs: number;
	readonly helperExited: boolean;
	readonly queuedRequests: ReadonlyArray<RawIoHelperRequestEntry>;
}

export interface RawIoKillWaitResolution {
	readonly activeError: string;
	readonly retryQueueOnFreshHelper: boolean;
	readonly queuedErrors: ReadonlyArray<string>;
	readonly blockFutureWritesToTarget?: string | undefined;
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

	constructor(clauseId: string, operation: string, targetPath: string, reason: string, options?: ErrorOptions) {
		super(clauseId, `Raw-I/O Helper failed during ${operation} for '${targetPath}': ${reason}`, options);
		this.operation = operation;
		this.targetPath = targetPath;
	}

	static fromFormattedMessage(
		clauseId: string,
		operation: string,
		targetPath: string,
		formattedMessage: string,
	): RawIoHelperOperationError {
		const err = new RawIoHelperOperationError(clauseId, operation, targetPath, "");
		err.message = formattedMessage;
		return err;
	}
}

export function resolveTimeoutAfterKillWait(input: ResolveTimeoutAfterKillWaitInput): RawIoKillWaitResolution {
	if (input.helperExited) {
		const activeReason =
			input.operation === "write"
				? `timed out after ${String(input.timeoutMs)}ms; write outcome is unknown`
				: `timed out after ${String(input.timeoutMs)}ms`;
		const activeError = new RawIoHelperOperationError(
			"ERRORS-RAWIO-1b",
			input.operation,
			input.targetPath,
			activeReason,
		).message;
		return Object.freeze({
			activeError,
			retryQueueOnFreshHelper: input.queuedRequests.length > 0,
			queuedErrors: Object.freeze([]),
			blockFutureWritesToTarget: undefined,
		});
	}

	const activeReason =
		input.operation === "write"
			? `timed out after ${String(input.timeoutMs)}ms; write outcome is unknown and may still land`
			: `timed out after ${String(input.timeoutMs)}ms; helper did not exit within ${String(RAW_IO_KILL_WAIT_TIMEOUT_MS)}ms`;
	const activeError = new RawIoHelperOperationError("ERRORS-RAWIO-1c", input.operation, input.targetPath, activeReason)
		.message;
	const queuedErrors = input.queuedRequests.map(
		q =>
			new RawIoHelperOperationError(
				"ERRORS-RAWIO-1c",
				q.operation,
				q.targetPath,
				"previous helper could not be stopped",
			).message,
	);
	return Object.freeze({
		activeError,
		retryQueueOnFreshHelper: false,
		queuedErrors: Object.freeze(queuedErrors),
		blockFutureWritesToTarget: input.operation === "write" ? input.targetPath : undefined,
	});
}

interface RawIoWorkerHandle extends WorkerHandle<RawIoWorkerInbound, RawIoWorkerOutbound> {
	readonly exited: Promise<unknown>;
	terminateAndWait(waitMs: number): Promise<boolean>;
}

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
const unexitedWriteTargets = new Map<string, Set<Promise<unknown>>>();

function assertValidTargetPath(targetPath: unknown): asserts targetPath is string {
	if (typeof targetPath !== "string" || targetPath.trim().length === 0 || !targetPath.startsWith("/")) {
		throw new RawIoInvalidTargetPathError(targetPath);
	}
}

const MAX_SYMLINK_HOPS = 40;

/**
 * Resolve symlinks and relative segments using only `lstatSync` and
 * `readlinkSync` (never `realpathSync`, which on macOS opens the file and
 * closes the descriptor, releasing in-process POSIX locks).
 */
function resolveTargetKey(targetPath: string): string {
	// ERRORS-RAWIO-1d: expand symlinks before consuming later '..' components.
	let pending = targetPath;
	let hops = 0;
	while (hops <= MAX_SYMLINK_HOPS) {
		const segments = pending.split("/").filter(seg => seg.length > 0);
		let current = "/";
		let followedSymlink = false;
		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];
			if (!seg || seg === ".") continue;
			if (seg === "..") {
				current = path.posix.dirname(current);
				continue;
			}
			const candidate = current === "/" ? `/${seg}` : `${current}/${seg}`;
			let stat: fs.Stats;
			try {
				stat = fs.lstatSync(candidate);
			} catch (err: unknown) {
				const code = err instanceof Error && "code" in err ? err.code : undefined;
				if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
				// POST-RAWIO-2b: only a missing/non-directory path uses the supplied key.
				return targetPath;
			}
			if (stat.isSymbolicLink()) {
				hops++;
				if (hops > MAX_SYMLINK_HOPS) {
					return candidate;
				}
				let linkTarget: string;
				try {
					linkTarget = fs.readlinkSync(candidate);
				} catch (err: unknown) {
					const code = err instanceof Error && "code" in err ? err.code : undefined;
					if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
					return targetPath;
				}
				const resolvedLink = linkTarget.startsWith("/") ? linkTarget : `${current}/${linkTarget}`;
				const tail = segments.slice(i + 1).join("/");
				pending = tail.length > 0 ? `${resolvedLink}/${tail}` : resolvedLink;
				followedSymlink = true;
				break;
			}
			current = candidate;
		}
		if (!followedSymlink) {
			return current;
		}
	}
	return pending;
}

export function registerUnexitedWriteTarget(targetPath: string, exitPromise: Promise<unknown>): void {
	assertValidTargetPath(targetPath);
	const key = resolveTargetKey(targetPath);
	let pendingSet = unexitedWriteTargets.get(key);
	if (!pendingSet) {
		pendingSet = new Set<Promise<unknown>>();
		unexitedWriteTargets.set(key, pendingSet);
	}
	pendingSet.add(exitPromise);
	void exitPromise.finally(() => {
		const currentSet = unexitedWriteTargets.get(key);
		if (!currentSet) return;
		currentSet.delete(exitPromise);
		if (currentSet.size === 0) {
			unexitedWriteTargets.delete(key);
		}
	});
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
		throw new RawIoHelperOperationError("ERRORS-RAWIO-1b", operation, targetPath, "invalid timeoutMs");
	}
	const customCmd = options.helperSpawnCommand?.cmd;
	if (customCmd !== undefined) {
		if (
			!Array.isArray(customCmd) ||
			customCmd.length === 0 ||
			!customCmd.every(part => typeof part === "string" && part.trim().length > 0)
		) {
			throw new RawIoHelperOperationError(
				"ERRORS-RAWIO-1b",
				operation,
				targetPath,
				"invalid helperSpawnCommand.cmd",
			);
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
	const terminateAndWait = async (waitMs: number): Promise<boolean> => {
		await baseHandle.terminate();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<false>(resolve => {
			timer = setTimeout(() => resolve(false), waitMs);
		});
		const exitedPromise = spawned.proc.exited.then(
			() => true as const,
			() => true as const,
		);
		try {
			return await Promise.race([exitedPromise, timeoutPromise]);
		} finally {
			clearTimeout(timer);
		}
	};
	return {
		...baseHandle,
		exited: spawned.proc.exited,
		terminateAndWait,
		async terminate() {
			await terminateAndWait(RAW_IO_KILL_WAIT_TIMEOUT_MS);
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

export async function stopRawIoHelper(): Promise<void> {
	const current = sharedHelper;
	sharedHelper = null;
	sharedHelperCmdKey = null;
	if (current !== null) {
		await current.terminate();
	}
}

async function executeActiveTask(task: QueuedHelperTask): Promise<void> {
	let handle: RawIoWorkerHandle;
	try {
		handle = await acquireSharedHelperForCmd(task.cmdKey, task.customCmd);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		task.rejectTask(
			new RawIoHelperOperationError("ERRORS-RAWIO-1b", task.operation, task.targetPath, reason, { cause: err }),
		);
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

	const armTimer = (): void => {
		clearCurrentTimer();
		timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			if (sharedHelper === handle) {
				sharedHelper = null;
				sharedHelperCmdKey = null;
			}
			void handle.terminateAndWait(RAW_IO_KILL_WAIT_TIMEOUT_MS).then(helperExited => {
				const matchingIndices: number[] = [];
				const matchingEntries: RawIoHelperRequestEntry[] = [];
				for (let i = 0; i < requestQueue.length; i++) {
					const q = requestQueue[i];
					if (q && q.cmdKey === task.cmdKey) {
						matchingIndices.push(i);
						matchingEntries.push({ operation: q.operation, targetPath: q.targetPath });
					}
				}
				const resolution = resolveTimeoutAfterKillWait({
					operation: task.operation,
					targetPath: task.targetPath,
					timeoutMs: task.timeoutMs,
					helperExited,
					queuedRequests: matchingEntries,
				});
				if (resolution.blockFutureWritesToTarget !== undefined) {
					registerUnexitedWriteTarget(resolution.blockFutureWritesToTarget, handle.exited);
				}
				const activeClauseId = helperExited ? "ERRORS-RAWIO-1b" : "ERRORS-RAWIO-1c";
				if (!resolution.retryQueueOnFreshHelper && matchingIndices.length > 0) {
					for (let k = matchingIndices.length - 1; k >= 0; k--) {
						const idx = matchingIndices[k];
						if (idx === undefined) continue;
						const [removed] = requestQueue.splice(idx, 1);
						const errMsg = resolution.queuedErrors[k];
						if (removed && errMsg !== undefined) {
							removed.rejectTask(
								RawIoHelperOperationError.fromFormattedMessage(
									"ERRORS-RAWIO-1c",
									removed.operation,
									removed.targetPath,
									errMsg,
								),
							);
						}
					}
				}
				task.rejectTask(
					RawIoHelperOperationError.fromFormattedMessage(
						activeClauseId,
						task.operation,
						task.targetPath,
						resolution.activeError,
					),
				);
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
			armTimer();
			return;
		}
		if (message.type === "progress") {
			if (task.operation === "read" || task.operation === "write") {
				armTimer();
			}
			return;
		}
		if (message.type === "error") {
			// ERRORS-RAWIO-1: per-request error from a live helper fails only the active request
			// and leaves the live helper and queue untouched.
			settled = true;
			clearCurrentTimer();
			task.rejectTask(
				new RawIoHelperOperationError("ERRORS-RAWIO-1", task.operation, task.targetPath, message.error),
			);
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
		// ERRORS-RAWIO-1b (Q1 = a): helper crash fails only the active request;
		// requests still in requestQueue are dispatched once in original order on a fresh helper.
		task.rejectTask(
			new RawIoHelperOperationError("ERRORS-RAWIO-1b", task.operation, task.targetPath, err.message, { cause: err }),
		);
		resolve();
	});

	try {
		task.onRequest?.({ operation: task.operation, targetPath: task.targetPath });
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
	if (unexitedWriteTargets.size > 0 && unexitedWriteTargets.has(resolveTargetKey(targetPath))) {
		throw new RawIoHelperOperationError(
			"ERRORS-RAWIO-1d",
			"write",
			targetPath,
			"previous helper is still alive; fix the mount or restart omp",
		);
	}

	await enqueueHelperRequest<true>(
		"write",
		targetPath,
		options,
		id => ({ type: "write", id, targetPath, data }),
		message => (message.type === "write_ok" ? true : undefined),
	);
}
