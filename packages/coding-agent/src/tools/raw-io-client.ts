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
	RAW_IO_WORKER_ARG,
	type RawIoHelperOperation,
	type RawIoHelperRequestEntry,
	type RawIoTargetClassification,
	type RawIoWorkerInbound,
	type RawIoWorkerOutbound,
} from "./raw-io-protocol";

export {
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

let sharedHelper: RawIoWorkerHandle | null = null;
let cleanupRegistered = false;

function assertValidTargetPath(targetPath: unknown): asserts targetPath is string {
	if (typeof targetPath !== "string" || targetPath.trim().length === 0 || !targetPath.startsWith("/")) {
		throw new RawIoInvalidTargetPathError(targetPath);
	}
}

function validateOptionsShape(
	operation: RawIoHelperOperation,
	targetPath: string,
	options?: RawIoClassifyOptions,
): readonly string[] | undefined {
	if (options === undefined) {
		return undefined;
	}
	if (options.timeoutMs !== undefined) {
		if (typeof options.timeoutMs !== "number" || !Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
			throw new RawIoHelperOperationError(operation, targetPath, "invalid timeoutMs");
		}
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
		return customCmd;
	}
	return undefined;
}

function createRawIoWorkerHandle(spawnCommand: WorkerSpawnCommand): RawIoWorkerHandle {
	const spawned: SpawnedSubprocess<RawIoWorkerOutbound> = createWorkerSubprocess({
		spawnCommand,
		env: workerEnvFromParent(),
		exitLabel: "raw-io worker",
		reportCleanExit: true,
	});
	return createWorkerHandle(spawned, message => {
		safeSend(spawned.proc, message, "raw-io worker");
	});
}

function acquireSharedHelper(): RawIoWorkerHandle {
	if (sharedHelper !== null) {
		return sharedHelper;
	}
	// SEQ-5: start the Raw-I/O Helper from the same executable on first request.
	const handle = createRawIoWorkerHandle(resolveWorkerSpawnCmd(RAW_IO_WORKER_ARG));
	sharedHelper = handle;
	handle.onError(() => {
		if (sharedHelper === handle) {
			sharedHelper = null;
		}
	});
	// SEQ-6: terminate the Raw-I/O Helper at omp exit.
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
	if (current !== null) {
		await current.terminate();
	}
}

function acquireHandleForRequest(
	operation: RawIoHelperOperation,
	targetPath: string,
	options?: RawIoClassifyOptions,
): { readonly handle: RawIoWorkerHandle; readonly disposeAfter: boolean } {
	const customCmd = validateOptionsShape(operation, targetPath, options);
	if (customCmd !== undefined) {
		try {
			return {
				handle: createRawIoWorkerHandle({ cmd: [...customCmd] }),
				disposeAfter: true,
			};
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			throw new RawIoHelperOperationError(operation, targetPath, reason, { cause: err });
		}
	}
	try {
		return {
			handle: acquireSharedHelper(),
			disposeAfter: false,
		};
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new RawIoHelperOperationError(operation, targetPath, reason, { cause: err });
	}
}

async function runHelperRequest<Result>(
	operation: RawIoHelperOperation,
	targetPath: string,
	options: RawIoClassifyOptions | undefined,
	buildInbound: (id: string) => RawIoWorkerInbound,
	extractResult: (
		message: Exclude<RawIoWorkerOutbound, { readonly type: "log" | "pong" | "error" }>,
	) => Result | undefined,
): Promise<Result> {
	const { handle, disposeAfter } = acquireHandleForRequest(operation, targetPath, options);
	const requestId = crypto.randomUUID();
	const { promise, resolve, reject } = Promise.withResolvers<Result>();

	const unsubscribeMessage = handle.onMessage(message => {
		if (message.type === "log") {
			logWorkerMessage(message);
			return;
		}
		if (message.type === "pong" || message.id !== requestId) return;
		if (message.type === "error") {
			reject(new RawIoHelperOperationError(operation, targetPath, message.error));
			return;
		}
		const result = extractResult(message);
		if (result !== undefined) {
			resolve(result);
		}
	});

	const unsubscribeError = handle.onError(err => {
		reject(new RawIoHelperOperationError(operation, targetPath, err.message, { cause: err }));
	});

	try {
		// POST-RAWIO-2b (B4): invoke onRequest exactly once for each request sent to the helper.
		options?.onRequest?.({ operation, targetPath });
		handle.send(buildInbound(requestId));
		return await promise;
	} finally {
		unsubscribeMessage();
		unsubscribeError();
		if (disposeAfter) {
			await handle.terminate();
		}
	}
}

export async function classifyRawIoTarget(
	targetPath: string,
	options?: RawIoClassifyOptions,
): Promise<RawIoTargetClassification> {
	// PRE-RAWIO-1: reject non-absolute or empty targetPath before any helper I/O.
	assertValidTargetPath(targetPath);

	return await runHelperRequest(
		"classify",
		targetPath,
		options,
		id => ({ type: "classify", id, targetPath }),
		message => (message.type === "classified" ? message.classification : undefined),
	);
}

export async function readRawIoBytes(
	targetPath: string,
	offset?: number,
	length?: number,
	options?: RawIoClassifyOptions,
): Promise<Uint8Array> {
	assertValidTargetPath(targetPath);

	return await runHelperRequest(
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

	await runHelperRequest<true>(
		"write",
		targetPath,
		options,
		id => ({ type: "write", id, targetPath, data }),
		message => (message.type === "write_ok" ? true : undefined),
	);
}
