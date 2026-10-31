/**
 * Parent-side client for the out-of-process Raw-I/O Helper subprocess.
 *
 * Enforces PRE-RAWIO-1, POST-RAWIO-1, POST-RAWIO-1b, POST-RAWIO-2,
 * ERRORS-RAWIO-1, FORBIDDEN-RAWIO-1, FORBIDDEN-RAWIO-1b, FORBIDDEN-RAWIO-2,
 * and FORBIDDEN-RAWIO-2b.
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
	type RawIoTargetClassification,
	type RawIoWorkerInbound,
	type RawIoWorkerOutbound,
} from "./raw-io-protocol";

export { RAW_IO_WORKER_ARG, type RawIoTargetClassification } from "./raw-io-protocol";

export interface RawIoClassifyOptions {
	readonly helperSpawnCommand?: {
		readonly cmd: readonly string[];
	};
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

async function runClassifyOnHandle(
	handle: RawIoWorkerHandle,
	targetPath: string,
	disposeAfter: boolean,
): Promise<RawIoTargetClassification> {
	const requestId = crypto.randomUUID();
	const { promise, resolve, reject } = Promise.withResolvers<RawIoTargetClassification>();

	const unsubscribeMessage = handle.onMessage(message => {
		if (message.type === "log") {
			logWorkerMessage(message);
			return;
		}
		if (message.id !== requestId) return;
		if (message.type === "classified") {
			resolve(message.classification);
			return;
		}
		if (message.type === "error") {
			reject(new RawIoHelperOperationError("classify", targetPath, message.error));
		}
	});

	const unsubscribeError = handle.onError(err => {
		reject(new RawIoHelperOperationError("classify", targetPath, err.message, { cause: err }));
	});

	try {
		handle.send({ type: "classify", id: requestId, targetPath });
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

	const customCmd = options?.helperSpawnCommand?.cmd;
	if (customCmd !== undefined) {
		if (
			!Array.isArray(customCmd) ||
			customCmd.length === 0 ||
			!customCmd.every(part => typeof part === "string" && part.trim().length > 0)
		) {
			throw new RawIoHelperOperationError("classify", targetPath, "invalid helperSpawnCommand.cmd");
		}
		// ERRORS-RAWIO-1 / FORBIDDEN-RAWIO-1b: fail closed naming operation and targetPath; never open in-process.
		let customHandle: RawIoWorkerHandle;
		try {
			customHandle = createRawIoWorkerHandle({ cmd: [...customCmd] });
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			throw new RawIoHelperOperationError("classify", targetPath, reason, { cause: err });
		}
		return await runClassifyOnHandle(customHandle, targetPath, true);
	}

	let handle: RawIoWorkerHandle;
	try {
		handle = acquireSharedHelper();
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new RawIoHelperOperationError("classify", targetPath, reason, { cause: err });
	}
	return await runClassifyOnHandle(handle, targetPath, false);
}
