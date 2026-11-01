import { Database } from "bun:sqlite";
import { dlopen, FFIType, read } from "bun:ffi";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as workerSelectors from "@oh-my-pi/pi-coding-agent/cli/worker-selectors";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import {
	type ClassifyResolvedTargetInput,
	evaluateTimeoutSemantics,
	RAW_IO_CLASSIFY_FN_NAME,
	RAW_IO_CLIENT_MODULE,
	RAW_IO_DEFAULT_TIMEOUT_MS,
	RAW_IO_HELPER_CONTRACT,
	RAW_IO_KILL_WAIT_TIMEOUT_MS,
	RAW_IO_PROGRESS_CHUNK_BYTES,
	RAW_IO_READ_BYTES_FN_NAME,
	RAW_IO_REGISTER_UNEXITED_WRITE_FN_NAME,
	RAW_IO_RESOLVE_KILL_WAIT_FN_NAME,
	RAW_IO_STOP_FN_NAME,
	RAW_IO_WORKER_ARG,
	RAW_IO_WRITE_BYTES_FN_NAME,
	type RawIoClassifyOptions,
	RawIoClassificationMismatchError,
	type RawIoHelperRequestEntry,
	RawIoInvalidTargetPathError,
	type ResolveTimeoutAfterKillWaitInput,
	SQLITE_HEADER_MAGIC,
	SQLITE_SIDECAR_SUFFIXES,
	validateClassificationRecord,
	validateClassifyOptions,
	validateHelperFailureError,
	validateKillWaitResolution,
	validateNonSqliteHelperLog,
	validateSqliteFamilyHelperLog,
	validateTargetPath,
	validateToolAccessRoute,
} from "../../../../contracts/raw_io_helper.contract";

function assertionContext(clause: string, expected: string): string {
	return [
		"1. WHAT: Contract-bound assertion FAILED",
		`2. WHY: ${clause} violation`,
		`3. EXPECTED: ${expected}`,
		"4. ACTUAL: Shown by the matcher diagnostic below",
		"5. GUIDANCE: Preserve the specified value or error outcome",
	].join("\n");
}

function assertReportedClassification(
	raw: unknown,
	expected: {
		targetPath: string;
		resolvedPath: string;
		kind: string;
		isSqliteFamily: boolean;
		entryKind: string;
		headerBytes: Uint8Array;
	},
): void {
	const { headerBytes, ...fields } = expected;
	expect(raw, assertionContext("POST-RAWIO-1", JSON.stringify(fields))).toMatchObject(fields);
	const actualHeader = typeof raw === "object" && raw !== null ? Reflect.get(raw, "headerBytes") : undefined;
	expect(actualHeader, assertionContext("POST-RAWIO-1", "exact independently observed header bytes")).toEqual(
		headerBytes,
	);
}

function peerHeaderBytes(target: string): Uint8Array {
	const probe = Bun.spawnSync({
		cmd: [
			process.execPath,
			"-e",
			"process.stdout.write(await Bun.file(process.argv[1]).slice(0,16).bytes());",
			target,
		],
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(probe.exitCode, assertionContext("POST-RAWIO-1", "independent header observation succeeds")).toBe(0);
	return probe.stdout;
}

// =============================================================================
// CONTRACT VERIFICATION (supporting tests for pure contract validators, not RED)
// =============================================================================

describe("raw_io_helper.contract - contract validator verification (supporting, not RED)", () => {
	it("enforces PRE-RAWIO-1, POST-RAWIO-1, POST-RAWIO-2/2b/2c, POST-RAWIO-3/3b/3c, ERRORS-RAWIO-1, FORBIDDEN-RAWIO-2, and FORBIDDEN-RAWIO-3 on pure inputs", () => {
		expect(RAW_IO_HELPER_CONTRACT["PRE-RAWIO-1"].verification, assertionContext("PRE-RAWIO-1", 'toBe("test")')).toBe(
			"test",
		);
		expect(validateTargetPath("/tmp/test.db"), assertionContext("PRE-RAWIO-1", 'toBe("/tmp/test.db")')).toBe(
			"/tmp/test.db",
		);
		expect(
			() => validateTargetPath("relative/path.db"),
			assertionContext("PRE-RAWIO-1", "toThrow(RawIoInvalidTargetPathError)"),
		).toThrow(RawIoInvalidTargetPathError);
		expect(
			() => validateTargetPath(""),
			assertionContext("PRE-RAWIO-1", "toThrow(RawIoInvalidTargetPathError)"),
		).toThrow(RawIoInvalidTargetPathError);

		expect(
			validateClassifyOptions(undefined),
			assertionContext("POST-RAWIO-2b", "toMatchObject({\n\t\t\thelperSpawnCmd: undefined,\n\t\t})"),
		).toMatchObject({
			helperSpawnCmd: undefined,
		});
		expect(
			validateClassifyOptions({
				helperSpawnCommand: { cmd: ["/bin/false"] },
			}),
			assertionContext("POST-RAWIO-2b", 'toMatchObject({\n\t\t\thelperSpawnCmd: ["/bin/false"],\n\t\t})'),
		).toMatchObject({
			helperSpawnCmd: ["/bin/false"],
		});
		expect(
			() => validateClassifyOptions({ helperSpawnCommand: { cmd: [] } }),
			assertionContext("POST-RAWIO-2b", "toThrow(RawIoClassificationMismatchError)"),
		).toThrow(RawIoClassificationMismatchError);
		const dbRec = validateClassificationRecord({
			targetPath: "/tmp/a.db",
			resolvedPath: "/tmp/a.db",
			headerBytes: SQLITE_HEADER_MAGIC,
			helperPid: process.pid + 1,
			parentPid: process.pid,
			entryKind: "file",
		});
		expect(dbRec.kind, assertionContext("POST-RAWIO-1", 'toBe("sqlite_db")')).toBe("sqlite_db");
		expect(dbRec.isSqliteFamily, assertionContext("POST-RAWIO-1", "toBe(true)")).toBe(true);

		for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
			const sidecarRec = validateClassificationRecord({
				targetPath: `/tmp/alias.txt`,
				resolvedPath: `/tmp/a.db${suffix}`,
				headerBytes: new Uint8Array([1, 2, 3, 4]),
				helperPid: process.pid + 1,
				parentPid: process.pid,
				entryKind: "file",
			});
			expect(sidecarRec.kind, assertionContext("POST-RAWIO-1", 'toBe("sqlite_sidecar")')).toBe("sqlite_sidecar");
			expect(sidecarRec.isSqliteFamily, assertionContext("POST-RAWIO-1", "toBe(true)")).toBe(true);

			// R3: missing sidecar path returns kind='missing' with isSqliteFamily=false
			const missingSidecar = validateClassificationRecord({
				targetPath: `/tmp/a.db${suffix}`,
				resolvedPath: `/tmp/a.db${suffix}`,
				headerBytes: new Uint8Array(0),
				helperPid: process.pid + 1,
				parentPid: process.pid,
				entryKind: "missing",
			});
			expect(missingSidecar.kind, assertionContext("POST-RAWIO-1", 'toBe("missing")')).toBe("missing");
			expect(missingSidecar.isSqliteFamily, assertionContext("POST-RAWIO-1", "toBe(false)")).toBe(false);
		}

		// R2: requested path ending in -wal that resolves to non-SQLite regular file is 'non_sqlite'
		const reverseSymlink = validateClassificationRecord({
			targetPath: "/tmp/fake.db-wal",
			resolvedPath: "/tmp/ordinary.txt",
			headerBytes: new TextEncoder().encode("hello world\n"),
			helperPid: process.pid + 1,
			parentPid: process.pid,
			entryKind: "file",
		});
		expect(reverseSymlink.kind, assertionContext("POST-RAWIO-1", 'toBe("non_sqlite")')).toBe("non_sqlite");
		expect(reverseSymlink.isSqliteFamily, assertionContext("POST-RAWIO-1", "toBe(false)")).toBe(false);

		expect(
			() =>
				validateClassificationRecord({
					targetPath: "/tmp/a.db",
					resolvedPath: "/tmp/a.db",
					headerBytes: SQLITE_HEADER_MAGIC,
					helperPid: process.pid,
					parentPid: process.pid,
					entryKind: "file",
				}),
			assertionContext("FORBIDDEN-RAWIO-2", "toThrow(RawIoClassificationMismatchError)"),
		).toThrow(RawIoClassificationMismatchError);

		expect(
			validateHelperFailureError(
				"Raw-I/O Helper failed during classify for '/tmp/a.db': timed out after 100ms",
				"classify",
				"/tmp/a.db",
			),
			assertionContext("ERRORS-RAWIO-1b", 'toContain("/tmp/a.db")'),
		).toContain("/tmp/a.db");
		expect(
			() => validateHelperFailureError("", "classify", "/tmp/a.db"),
			assertionContext("ERRORS-RAWIO-1b", "toThrow(RawIoClassificationMismatchError)"),
		).toThrow(RawIoClassificationMismatchError);

		expect(
			validateToolAccessRoute("read", dbRec, "sqlite_connection", true).accessChannel,
			assertionContext("POST-RAWIO-3", 'toBe("sqlite_connection")'),
		).toBe("sqlite_connection");
		expect(
			validateToolAccessRoute("write", dbRec, "raw_io_helper", true).accessChannel,
			assertionContext("POST-RAWIO-3b", 'toBe("raw_io_helper")'),
		).toBe("raw_io_helper");
		expect(
			validateToolAccessRoute("read", reverseSymlink, "in_process", true).accessChannel,
			assertionContext("POST-RAWIO-3c", 'toBe("in_process")'),
		).toBe("in_process");
		expect(
			() => validateToolAccessRoute("read", dbRec, "in_process", true),
			assertionContext("FORBIDDEN-RAWIO-3", "toThrow(RawIoClassificationMismatchError)"),
		).toThrow(RawIoClassificationMismatchError);
		expect(
			() => validateToolAccessRoute("write", dbRec, "sqlite_connection", false),
			assertionContext("POST-RAWIO-3b", "toThrow(RawIoClassificationMismatchError)"),
		).toThrow(RawIoClassificationMismatchError);
		expect(
			() => validateToolAccessRoute("read", reverseSymlink, "raw_io_helper", true),
			assertionContext("POST-RAWIO-3c", "toThrow(RawIoClassificationMismatchError)"),
		).toThrow(RawIoClassificationMismatchError);

		const sampleLog: RawIoHelperRequestEntry[] = [
			{ operation: "classify", targetPath: "/tmp/a.db-journal" },
			{ operation: "read", targetPath: "/tmp/a.db-journal" },
			{ operation: "write", targetPath: "/tmp/a.db-journal" },
			{ operation: "classify", targetPath: "/tmp/ordinary.txt" },
		];
		expect(
			validateSqliteFamilyHelperLog(sampleLog, "/tmp/a.db-journal", ["classify", "read", "write"]).length,
			assertionContext("POST-RAWIO-2b", "toBe(4)"),
		).toBe(4);
		expect(
			validateNonSqliteHelperLog(sampleLog, "/tmp/ordinary.txt").length,
			assertionContext("POST-RAWIO-3c", "toBe(4)"),
		).toBe(4);
		expect(
			() =>
				validateSqliteFamilyHelperLog(
					[{ operation: "classify", targetPath: "/tmp/a.db-journal" }],
					"/tmp/a.db-journal",
					["classify", "read"],
				),
			assertionContext("POST-RAWIO-2b", "toThrow(RawIoClassificationMismatchError)"),
		).toThrow(RawIoClassificationMismatchError);
		expect(
			() =>
				validateNonSqliteHelperLog(
					[
						{ operation: "classify", targetPath: "/tmp/ordinary.txt" },
						{ operation: "read", targetPath: "/tmp/ordinary.txt" },
					],
					"/tmp/ordinary.txt",
				),
			assertionContext("POST-RAWIO-3c", "toThrow(RawIoClassificationMismatchError)"),
		).toThrow(RawIoClassificationMismatchError);

		expect(RAW_IO_DEFAULT_TIMEOUT_MS, assertionContext("ERRORS-RAWIO-1b", "toBe(5000)")).toBe(5000);
		expect(RAW_IO_PROGRESS_CHUNK_BYTES, assertionContext("POST-RAWIO-2b", "toBe(65536)")).toBe(65536);
		expect(
			evaluateTimeoutSemantics({
				operation: "classify",
				timeoutMs: 100,
				queuedWaitMs: 500,
				startedReceived: true,
				elapsedBeforeStartMs: 10,
				elapsedSinceStartMs: 100,
				elapsedSinceProgressMs: 20,
				helperKilled: true,
			}).timedOut,
			assertionContext("ERRORS-RAWIO-1b", "toBe(true)"),
		).toBe(true);
		expect(
			evaluateTimeoutSemantics({
				operation: "read",
				timeoutMs: 100,
				queuedWaitMs: 500,
				startedReceived: true,
				elapsedBeforeStartMs: 10,
				elapsedSinceStartMs: 250,
				elapsedSinceProgressMs: 40,
				helperKilled: false,
			}).timedOut,
			assertionContext("POST-RAWIO-2b", "toBe(false)"),
		).toBe(false);
		expect(
			evaluateTimeoutSemantics({
				operation: "classify",
				timeoutMs: 100,
				queuedWaitMs: 0,
				startedReceived: false,
				elapsedBeforeStartMs: 100,
				elapsedSinceStartMs: 0,
				elapsedSinceProgressMs: 0,
				helperKilled: true,
			}).timedOut,
			assertionContext("ERRORS-RAWIO-1b", "toBe(true)"),
		).toBe(true);
		expect(
			() =>
				evaluateTimeoutSemantics({
					operation: "write",
					timeoutMs: 100,
					startedReceived: true,
					elapsedSinceStartMs: 120,
					elapsedSinceProgressMs: 120,
					helperKilled: false,
				}),
			assertionContext("ERRORS-RAWIO-1b", "toThrow(RawIoClassificationMismatchError)"),
		).toThrow(RawIoClassificationMismatchError);
		expect(
			validateHelperFailureError(
				"Raw-I/O Helper failed during write for '/tmp/a.db-journal': timed out after 100ms; write outcome is unknown",
				"write",
				"/tmp/a.db-journal",
				{ timedOut: true },
			),
			assertionContext("ERRORS-RAWIO-1b", 'toContain("outcome is unknown")'),
		).toContain("outcome is unknown");
		expect(
			() =>
				validateHelperFailureError(
					"Raw-I/O Helper failed during write for '/tmp/a.db-journal': timed out after 100ms",
					"write",
					"/tmp/a.db-journal",
					{ timedOut: true },
				),
			assertionContext("ERRORS-RAWIO-1b", "toThrow(RawIoClassificationMismatchError)"),
		).toThrow(RawIoClassificationMismatchError);
		expect(RAW_IO_KILL_WAIT_TIMEOUT_MS, assertionContext("ERRORS-RAWIO-1c", "toBe(5000)")).toBe(5000);
		expect(
			evaluateTimeoutSemantics({
				operation: "classify",
				timeoutMs: 500,
				startedReceived: true,
				elapsedSinceStartMs: 500,
				elapsedSinceProgressMs: 500,
				helperKilled: true,
				queuedRequestsCount: 2,
				killWaitElapsedMs: 50,
			}).queuedAction,
			assertionContext("ERRORS-RAWIO-1b", 'toBe("retry_on_fresh_helper")'),
		).toBe("retry_on_fresh_helper");
		expect(
			evaluateTimeoutSemantics({
				operation: "write",
				timeoutMs: 500,
				startedReceived: true,
				elapsedSinceStartMs: 500,
				elapsedSinceProgressMs: 500,
				helperKilled: true,
				queuedRequestsCount: 2,
				killWaitElapsedMs: 5000,
			}).queuedAction,
			assertionContext("ERRORS-RAWIO-1c", 'toBe("fail_queued_helper_not_stopped")'),
		).toBe("fail_queued_helper_not_stopped");
		expect(
			validateKillWaitResolution(
				{
					activeError:
						"ERRORS-RAWIO-1b violation: Raw-I/O Helper failed during write for '/tmp/a.db-journal': timed out after 500ms; write outcome is unknown and may still land",
					retryQueueOnFreshHelper: false,
					queuedErrors: [
						"ERRORS-RAWIO-1c violation: Raw-I/O Helper failed during read for '/tmp/b.db': previous helper could not be stopped",
					],
					blockFutureWritesToTarget: "/tmp/a.db-journal",
				},
				{
					operation: "write",
					targetPath: "/tmp/a.db-journal",
					helperExited: false,
					queuedRequests: [{ operation: "read", targetPath: "/tmp/b.db" }],
				},
			).retryQueueOnFreshHelper,
			assertionContext("ERRORS-RAWIO-1c", "toBe(false)"),
		).toBe(false);
	});
});

// =============================================================================
// RED PHASE - Implementation tests against contracted Raw-I/O Helper, ReadTool,
// and WriteTool surfaces
// =============================================================================

interface RawIoClientModule {
	readonly classifyRawIoTarget?: (targetPath: string, options?: RawIoClassifyOptions) => Promise<unknown>;
	readonly readRawIoBytes?: (
		targetPath: string,
		offset?: number,
		length?: number,
		options?: RawIoClassifyOptions,
	) => Promise<Uint8Array>;
	readonly writeRawIoBytes?: (targetPath: string, data: Uint8Array, options?: RawIoClassifyOptions) => Promise<void>;
	readonly stopRawIoHelper?: () => Promise<void>;
	readonly resolveTimeoutAfterKillWait?: (input: ResolveTimeoutAfterKillWaitInput) => unknown;
	readonly registerUnexitedWriteTarget?: (targetPath: string, exitPromise: Promise<unknown>) => void;
}

interface RawIoClientLoadResult {
	readonly module: RawIoClientModule | undefined;
	readonly loadError: string | undefined;
}

// Exception to ts-no-dynamic-import: RED test intentionally exercises module loading
// on the contracted client specifier so tsc --noEmit passes while the RED test fails
// with its 5-point contract error message when an export is absent.
async function tryLoadRawIoClient(): Promise<RawIoClientLoadResult> {
	const relativeSpecifier = RAW_IO_CLIENT_MODULE.replace(/^@oh-my-pi\/pi-coding-agent\//, "../../src/");
	try {
		const mod: unknown = await import(relativeSpecifier);
		if (typeof mod === "object" && mod !== null) {
			return { module: mod, loadError: undefined };
		}
		return { module: undefined, loadError: `non-object module export (${typeof mod})` };
	} catch (err) {
		return {
			module: undefined,
			loadError: err instanceof Error ? err.message : String(err),
		};
	}
}

function toClassificationInput(raw: unknown, parentPid: number): ClassifyResolvedTargetInput {
	if (typeof raw !== "object" || raw === null) {
		return {
			targetPath: undefined,
			resolvedPath: undefined,
			headerBytes: undefined,
			helperPid: undefined,
			parentPid,
		};
	}
	return {
		targetPath: Reflect.get(raw, "targetPath"),
		resolvedPath: Reflect.get(raw, "resolvedPath"),
		headerBytes: Reflect.get(raw, "headerBytes"),
		helperPid: Reflect.get(raw, "helperPid"),
		parentPid,
		entryKind: Reflect.get(raw, "entryKind"),
	};
}

function isPositiveLivePid(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

interface PeerWriteProbeResult {
	readonly blocked: boolean;
	readonly detail: string;
}

/**
 * Probe whether an independent OS process is blocked by SQLITE_BUSY when trying
 * to acquire a write lock on `dbPath`. If the parent `omp` process accidentally
 * opens and closes `dbPath` or its `-shm` sidecar in-process, the kernel drops
 * `omp`'s POSIX advisory locks and the child process succeeds (`ACQUIRED`).
 * Only a real SQLITE_BUSY / "database is locked" error counts as `blocked: true`.
 */
function peerWriteBlocked(dbPath: string): PeerWriteProbeResult {
	const script = [
		'import { Database } from "bun:sqlite";',
		"const db = new Database(process.argv[1]);",
		"try {",
		'  db.run("PRAGMA busy_timeout = 0;");',
		'  db.run("BEGIN IMMEDIATE;");',
		'  db.run("ROLLBACK;");',
		'  console.log("ACQUIRED");',
		"} catch (e) {",
		'  const msg = e instanceof Error ? e.name + ":" + e.message : String(e);',
		'  console.log("ERROR:" + msg);',
		"} finally {",
		"  db.close();",
		"}",
	].join("\n");
	const proc = Bun.spawnSync({
		cmd: [process.execPath, "-e", script, dbPath],
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new TextDecoder().decode(proc.stdout).trim();
	const stderr = new TextDecoder().decode(proc.stderr).trim();
	const detail = `exit=${String(proc.exitCode)} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`;
	if (proc.exitCode !== 0) {
		return { blocked: false, detail };
	}
	const isBusyLock =
		stdout.startsWith("ERROR:") &&
		(stdout.includes("SQLITE_BUSY") || stdout.toLowerCase().includes("database is locked"));
	return { blocked: isBusyLock, detail };
}

const libcName = process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6";
const isDarwin = process.platform === "darwin";
const errnoSymbolName = isDarwin ? "__error" : "__errno_location";
const libc = dlopen(libcName, {
	lockf: { args: [FFIType.i32, FFIType.i32, FFIType.i64], returns: FFIType.i32 },
	[errnoSymbolName]: { args: [], returns: FFIType.ptr },
});
const F_TLOCK = 2;

function currentErrno(): number {
	const errnoFn = libc.symbols[errnoSymbolName];
	if (typeof errnoFn !== "function") return -1;
	const errnoPtr = errnoFn();
	return errnoPtr ? read.i32(errnoPtr, 0) : -1;
}

/**
 * Acquire a real POSIX `lockf(fd, F_TLOCK, 0n)` advisory record lock (backed by
 * kernel `fcntl` record locks on both Linux and macOS, with fixed 3-argument
 * C ABI on darwin-arm64 and linux-x64) inside the current `omp` process.
 * Closing *any* file descriptor for the same inode inside `omp` causes the
 * kernel to release this lock immediately.
 */
function acquireInProcessPosixWriteLock(filePath: string): number {
	const fd = fsSync.openSync(filePath, "r+");
	const rc = libc.symbols.lockf(fd, F_TLOCK, 0n);
	if (rc !== 0) {
		const errnoVal = currentErrno();
		fsSync.closeSync(fd);
		throw new Error(
			`POST-RAWIO-1b setup: failed to acquire in-process POSIX lockf write lock on ${filePath} (rc=${String(rc)}, errno=${String(errnoVal)})`,
		);
	}
	return fd;
}

/**
 * Probe from a separate OS child process whether `filePath` currently holds a
 * conflicting POSIX record lock via `lockf(fd, F_TLOCK=2, 0n)`.
 * Only `EAGAIN` or `EACCES` counts as `LOCKED`; any other non-zero result throws
 * with `errno` so a broken probe can never masquerade as locked.
 */
function peerPosixWriteLockBlocked(filePath: string): PeerWriteProbeResult {
	const script = [
		'import { dlopen, FFIType, read } from "bun:ffi";',
		'import * as fs from "node:fs";',
		'import * as os from "node:os";',
		'const isDarwin = process.platform === "darwin";',
		'const libcName = isDarwin ? "libSystem.B.dylib" : "libc.so.6";',
		'const errnoSym = isDarwin ? "__error" : "__errno_location";',
		"const libc = dlopen(libcName, {",
		"  lockf: { args: [FFIType.i32, FFIType.i32, FFIType.i64], returns: FFIType.i32 },",
		"  [errnoSym]: { args: [], returns: FFIType.ptr },",
		"});",
		'const fd = fs.openSync(process.argv[1], "r+");',
		"const rc = libc.symbols.lockf(fd, 2, 0n);",
		"const errPtr = libc.symbols[errnoSym]();",
		"const errno = rc === 0 ? 0 : (errPtr ? read.i32(errPtr, 0) : -1);",
		"fs.closeSync(fd);",
		"if (rc === 0) {",
		'  console.log("ACQUIRED");',
		"} else if (rc === -1 && (errno === os.constants.errno.EAGAIN || errno === os.constants.errno.EACCES)) {",
		'  console.log("LOCKED:" + String(errno));',
		"} else {",
		'  console.log("UNEXPECTED_ERRNO:" + String(rc) + ":" + String(errno));',
		"  process.exit(2);",
		"}",
	].join("\n");
	const proc = Bun.spawnSync({
		cmd: [process.execPath, "-e", script, filePath],
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new TextDecoder().decode(proc.stdout).trim();
	const stderr = new TextDecoder().decode(proc.stderr).trim();
	const detail = `exit=${String(proc.exitCode)} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`;
	if (proc.exitCode !== 0 || (!stdout.startsWith("LOCKED:") && stdout !== "ACQUIRED")) {
		throw new Error(`POST-RAWIO-1b setup: POSIX lockf probe failed on ${filePath}: ${detail}`);
	}
	return {
		blocked: stdout.startsWith("LOCKED:"),
		detail,
	};
}

function createTestToolSession(
	cwd: string,
	rawIoHelperOptions?: RawIoClassifyOptions,
): ToolSession & { readonly rawIoHelperOptions?: RawIoClassifyOptions } {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		...(rawIoHelperOptions ? { rawIoHelperOptions } : {}),
	};
}

function extractToolText(result: {
	readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

describe("Raw-I/O Helper target classification, ReadTool/WriteTool routing, and failure handling (SLICE-4)", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-slice4-raw-io-"));
	});

	afterEach(async () => {
		const loaded = await tryLoadRawIoClient();
		const stopFn = loaded.module ? Reflect.get(loaded.module, RAW_IO_STOP_FN_NAME) : undefined;
		if (typeof stopFn === "function") {
			await stopFn();
		}
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("classifies SQLite databases, resolved sidecars, missing paths, and reverse symlinks in a real child OS process while preserving in-process WAL locks", async () => {
		/*
		 * CONTRACT TRACEABILITY:
		 *   - Contract: contracts/raw_io_helper.contract.ts (RAW_IO_HELPER_CONTRACT)
		 *   - Enforces: PRE-RAWIO-1, POST-RAWIO-1, POST-RAWIO-1b, POST-RAWIO-2, POST-RAWIO-2b, POST-RAWIO-2c, FORBIDDEN-RAWIO-1, FORBIDDEN-RAWIO-2, FORBIDDEN-RAWIO-2b
		 *   - Category: integration (real OS child process + live WAL SQLite lock retention + R2/R3 symlink/missing edge cases)
		 *   - Risk tier: HIGH - guards the exact POSIX fcntl lock-loss mechanism (#15586)
		 *   - Adversarial: Contract-governed, implementation-aware
		 *   - FOUR-CRITERIA TEST VALIDITY GATE:
		 *     [v] C1 VALID: cites PRE-RAWIO-1, POST-RAWIO-1, POST-RAWIO-1b, POST-RAWIO-2, POST-RAWIO-2b, POST-RAWIO-2c, FORBIDDEN-RAWIO-1, FORBIDDEN-RAWIO-2, FORBIDDEN-RAWIO-2b
		 *     [v] C2 VALUABLE: an in-process classifier closes the descriptor on dbPath / -shm and drops the BEGIN IMMEDIATE lock; R2/R3 catch targetPath vs resolvedPath and missing-sidecar bugs
		 *     [v] C3 NON-DUPLICATIVE: sole test of direct Raw-I/O Helper classification and R2/R3 symlink/missing rules
		 *     [v] C4 NOT FUTURE-EDIT: enforces current SLICE-4 contracted helper behavior
		 */
		const workerSelector = Reflect.get(workerSelectors, "RAW_IO_WORKER_ARG");
		if (workerSelector !== RAW_IO_WORKER_ARG) {
			throw new Error(
				[
					"1. WHAT: Raw-I/O Helper worker-selector constant alignment FAILED",
					"2. WHY: POST-RAWIO-2 violation - worker-selector constant does not match the contracted value",
					`3. EXPECTED: RAW_IO_WORKER_ARG === ${JSON.stringify(RAW_IO_WORKER_ARG)}`,
					`4. ACTUAL: RAW_IO_WORKER_ARG === ${JSON.stringify(workerSelector)}`,
					"5. GUIDANCE: The worker-selector surface must expose the exact contracted selector value",
				].join("\n"),
			);
		}

		const loaded = await tryLoadRawIoClient();
		const classifyFn = loaded.module?.[RAW_IO_CLASSIFY_FN_NAME];
		if (typeof classifyFn !== "function") {
			throw new Error(
				[
					"1. WHAT: Raw-I/O Helper classification entry point FAILED to load",
					"2. WHY: POST-RAWIO-2b violation - classification function is not exported on the contracted client surface",
					`3. EXPECTED: typeof ${RAW_IO_CLASSIFY_FN_NAME} === 'function' (loadError === undefined)`,
					`4. ACTUAL: typeof ${RAW_IO_CLASSIFY_FN_NAME} === ${JSON.stringify(typeof classifyFn)} (loadError=${JSON.stringify(loaded.loadError)})`,
					"5. GUIDANCE: The contracted client surface must provide the out-of-process target classification entry point",
				].join("\n"),
			);
		}

		const dbPath = path.join(tempDir, "test.db");
		const walPath = `${dbPath}-wal`;
		const shmPath = `${dbPath}-shm`;
		const existingJournalPath = `${dbPath}-journal`;
		const missingWalPath = path.join(tempDir, "missing.db-wal");
		const plainPath = path.join(tempDir, "notes.txt");
		const symlinkToWalPath = path.join(tempDir, "plain-alias.txt");
		const fakeWalSymlinkToPlainPath = path.join(tempDir, "fake.db-wal");
		const directoryPath = path.join(tempDir, "directory.db-shm");
		const specialPath = path.join(tempDir, "fifo.db-journal");
		// Canonicalize only the fixture directory before acquiring any file locks.
		const canonicalDir = await fs.realpath(tempDir);
		await fs.mkdir(directoryPath);
		const mkfifo = Bun.spawnSync(["mkfifo", specialPath], { stdout: "pipe", stderr: "pipe" });
		expect(mkfifo.exitCode, assertionContext("POST-RAWIO-1", "real special-file fixture exists")).toBe(0);

		await fs.writeFile(plainPath, "ordinary plain text file\n", "utf8");

		const db = new Database(dbPath);
		try {
			db.run("PRAGMA journal_mode = WAL;");
			db.run("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);");
			db.run("INSERT INTO items (name) VALUES ('alpha');");
			db.run("BEGIN IMMEDIATE;");
			db.run("INSERT INTO items (name) VALUES ('held-in-wal');");
			await fs.writeFile(existingJournalPath, "journal-header-bytes", "utf8");
			await fs.symlink(walPath, symlinkToWalPath);
			await fs.symlink(plainPath, fakeWalSymlinkToPlainPath);

			const preLockProbe = peerWriteBlocked(dbPath);
			if (!preLockProbe.blocked) {
				throw new Error(
					`POST-RAWIO-1b setup: expected BEGIN IMMEDIATE to block peer writer on ${dbPath} (${preLockProbe.detail})`,
				);
			}

			// 1. Classify the SQLite database file while omp holds BEGIN IMMEDIATE
			const rawDbResult = await classifyFn(dbPath);
			assertReportedClassification(rawDbResult, {
				targetPath: dbPath,
				resolvedPath: path.join(canonicalDir, "test.db"),
				kind: "sqlite_db",
				isSqliteFamily: true,
				entryKind: "file",
				headerBytes: SQLITE_HEADER_MAGIC,
			});
			const dbClassification = validateClassificationRecord(toClassificationInput(rawDbResult, process.pid));
			if (
				dbClassification.kind !== "sqlite_db" ||
				!dbClassification.isSqliteFamily ||
				!isPositiveLivePid(dbClassification.helperPid) ||
				dbClassification.helperPid === process.pid
			) {
				throw new Error(
					[
						"1. WHAT: Out-of-process SQLite database classification FAILED",
						"2. WHY: POST-RAWIO-1 / FORBIDDEN-RAWIO-2 violation - helper did not return sqlite_db from a live child OS process",
						`3. EXPECTED: kind='sqlite_db', isSqliteFamily=true, live helperPid !== ${String(process.pid)}`,
						`4. ACTUAL: ${JSON.stringify(dbClassification)}`,
						"5. GUIDANCE: Target classification must execute in a separate live OS process and identify SQLite format 3 header bytes",
					].join("\n"),
				);
			}

			// 2. R2 positive case: symlink whose requested name does NOT end in -wal
			//    but whose resolved real path ends in -wal -> sqlite_sidecar
			const rawSymlinkWalResult = await classifyFn(symlinkToWalPath);
			assertReportedClassification(rawSymlinkWalResult, {
				targetPath: symlinkToWalPath,
				resolvedPath: path.join(canonicalDir, "test.db-wal"),
				kind: "sqlite_sidecar",
				isSqliteFamily: true,
				entryKind: "file",
				headerBytes: peerHeaderBytes(walPath),
			});
			const symlinkWalClassification = validateClassificationRecord(
				toClassificationInput(rawSymlinkWalResult, process.pid),
			);
			if (
				symlinkWalClassification.kind !== "sqlite_sidecar" ||
				!symlinkWalClassification.isSqliteFamily ||
				!symlinkWalClassification.resolvedPath.endsWith("-wal")
			) {
				throw new Error(
					[
						"1. WHAT: Symlinked WAL sidecar classification FAILED",
						"2. WHY: POST-RAWIO-1 (R2) violation - a regular file whose resolved real path ends in -wal must classify as sqlite_sidecar even when targetPath does not",
						"3. EXPECTED: kind='sqlite_sidecar', isSqliteFamily=true, resolvedPath ending with '-wal'",
						`4. ACTUAL: ${JSON.stringify(symlinkWalClassification)}`,
						"5. GUIDANCE: Sidecar suffix classification must be determined from the resolved real path",
					].join("\n"),
				);
			}

			// 3. R2 reverse case: symlink whose requested name ends in -wal
			//    but whose resolved real path is an ordinary non-SQLite file -> non_sqlite
			const rawReverseSymlinkResult = await classifyFn(fakeWalSymlinkToPlainPath);
			assertReportedClassification(rawReverseSymlinkResult, {
				targetPath: fakeWalSymlinkToPlainPath,
				resolvedPath: path.join(canonicalDir, "notes.txt"),
				kind: "non_sqlite",
				isSqliteFamily: false,
				entryKind: "file",
				headerBytes: new TextEncoder().encode("ordinary plain text file\n").subarray(0, 16),
			});
			const reverseSymlinkClassification = validateClassificationRecord(
				toClassificationInput(rawReverseSymlinkResult, process.pid),
			);
			const actualReverseKind =
				typeof rawReverseSymlinkResult === "object" && rawReverseSymlinkResult !== null
					? Reflect.get(rawReverseSymlinkResult, "kind")
					: undefined;
			const actualReverseSqliteFamily =
				typeof rawReverseSymlinkResult === "object" && rawReverseSymlinkResult !== null
					? Reflect.get(rawReverseSymlinkResult, "isSqliteFamily")
					: undefined;
			if (
				actualReverseKind !== "non_sqlite" ||
				actualReverseSqliteFamily !== false ||
				reverseSymlinkClassification.kind !== "non_sqlite" ||
				reverseSymlinkClassification.isSqliteFamily
			) {
				throw new Error(
					[
						"1. WHAT: Reverse symlink (-wal alias to ordinary file) classification FAILED",
						"2. WHY: POST-RAWIO-1 (R2) violation - sidecar suffix on targetPath must not classify a resolved non-SQLite file as sqlite_sidecar",
						"3. EXPECTED: kind='non_sqlite', isSqliteFamily=false",
						`4. ACTUAL: kind=${JSON.stringify(actualReverseKind)}, isSqliteFamily=${JSON.stringify(actualReverseSqliteFamily)}`,
						"5. GUIDANCE: Sidecar suffix classification must inspect only resolvedPath, never the un-resolved targetPath alias",
					].join("\n"),
				);
			}

			// 4. R3: missing path ending in -wal -> kind='missing', isSqliteFamily=false
			const rawMissingWalResult = await classifyFn(missingWalPath);
			assertReportedClassification(rawMissingWalResult, {
				targetPath: missingWalPath,
				resolvedPath: missingWalPath,
				kind: "missing",
				isSqliteFamily: false,
				entryKind: "missing",
				headerBytes: new Uint8Array(0),
			});
			const missingWalClassification = validateClassificationRecord(
				toClassificationInput(rawMissingWalResult, process.pid),
			);
			const actualMissingKind =
				typeof rawMissingWalResult === "object" && rawMissingWalResult !== null
					? Reflect.get(rawMissingWalResult, "kind")
					: undefined;
			const actualMissingSqliteFamily =
				typeof rawMissingWalResult === "object" && rawMissingWalResult !== null
					? Reflect.get(rawMissingWalResult, "isSqliteFamily")
					: undefined;
			if (
				actualMissingKind !== "missing" ||
				actualMissingSqliteFamily !== false ||
				missingWalClassification.kind !== "missing" ||
				missingWalClassification.isSqliteFamily
			) {
				throw new Error(
					[
						"1. WHAT: Missing sidecar path classification FAILED",
						"2. WHY: POST-RAWIO-1 (R3) violation - a non-existent path ending in -wal must return kind='missing' and isSqliteFamily=false",
						"3. EXPECTED: kind='missing', isSqliteFamily=false",
						`4. ACTUAL: kind=${JSON.stringify(actualMissingKind)}, isSqliteFamily=${JSON.stringify(actualMissingSqliteFamily)}`,
						"5. GUIDANCE: Non-existent targets must classify as kind='missing' regardless of path suffix",
					].join("\n"),
				);
			}
			// 5. Existing -shm and -journal sidecars -> sqlite_sidecar
			const rawShmResult = await classifyFn(shmPath);
			assertReportedClassification(rawShmResult, {
				targetPath: shmPath,
				resolvedPath: path.join(canonicalDir, "test.db-shm"),
				kind: "sqlite_sidecar",
				isSqliteFamily: true,
				entryKind: "file",
				headerBytes: peerHeaderBytes(shmPath),
			});
			const shmClassification = validateClassificationRecord(toClassificationInput(rawShmResult, process.pid));
			const rawJournalResult = await classifyFn(existingJournalPath);
			assertReportedClassification(rawJournalResult, {
				targetPath: existingJournalPath,
				resolvedPath: path.join(canonicalDir, "test.db-journal"),
				kind: "sqlite_sidecar",
				isSqliteFamily: true,
				entryKind: "file",
				headerBytes: new TextEncoder().encode("journal-header-bytes").subarray(0, 16),
			});
			const journalClassification = validateClassificationRecord(
				toClassificationInput(rawJournalResult, process.pid),
			);
			if (shmClassification.kind !== "sqlite_sidecar" || journalClassification.kind !== "sqlite_sidecar") {
				throw new Error(
					[
						"1. WHAT: Existing -shm/-journal sidecar classification FAILED",
						"2. WHY: POST-RAWIO-1 violation - existing -shm and -journal files were not classified as sqlite_sidecar",
						"3. EXPECTED: shm.kind === 'sqlite_sidecar' && journal.kind === 'sqlite_sidecar'",
						`4. ACTUAL: shm=${JSON.stringify(shmClassification.kind)}, journal=${JSON.stringify(journalClassification.kind)}`,
						"5. GUIDANCE: Existing regular files whose resolved real path ends in -wal, -shm, or -journal must classify as sqlite_sidecar",
					].join("\n"),
				);
			}

			assertReportedClassification(await classifyFn(directoryPath), {
				targetPath: directoryPath,
				resolvedPath: path.join(canonicalDir, "directory.db-shm"),
				kind: "directory",
				isSqliteFamily: false,
				entryKind: "directory",
				headerBytes: new Uint8Array(0),
			});
			assertReportedClassification(await classifyFn(specialPath), {
				targetPath: specialPath,
				resolvedPath: path.join(canonicalDir, "fifo.db-journal"),
				kind: "special",
				isSqliteFamily: false,
				entryKind: "special",
				headerBytes: new Uint8Array(0),
			});

			// 6. Verify that omp's held WAL write lock on dbPath was NOT released
			const postLockProbe = peerWriteBlocked(dbPath);
			if (!postLockProbe.blocked) {
				throw new Error(
					[
						"1. WHAT: In-process POSIX WAL lock retention FAILED during target classification",
						"2. WHY: POST-RAWIO-1b / FORBIDDEN-RAWIO-2 violation - held WAL lock on test.db was released while classifying targets",
						`3. EXPECTED: peerWriteBlocked(${JSON.stringify(dbPath)}).blocked === true`,
						`4. ACTUAL: peerWriteBlocked(${JSON.stringify(dbPath)}).blocked === false (${postLockProbe.detail})`,
						"5. GUIDANCE: Classifying SQLite database and sidecar targets must not close any descriptor for those inodes inside omp",
					].join("\n"),
				);
			}
		} finally {
			try {
				db.run("ROLLBACK;");
			} catch {}
			db.close();
		}
	});

	it("surfaces an error naming the operation and target path without falling back to an in-process open when the Raw-I/O Helper fails", async () => {
		/*
		 * CONTRACT TRACEABILITY:
		 *   - Contract: contracts/raw_io_helper.contract.ts (RAW_IO_HELPER_CONTRACT)
		 *   - Enforces: PRE-RAWIO-1, POST-RAWIO-2b, ERRORS-RAWIO-1b, FORBIDDEN-RAWIO-1b
		 *   - Category: error boundary
		 *   - Risk tier: HIGH - silent in-process fallback on helper failure drops POSIX locks (#15586)
		 *   - Adversarial: Contract-governed, implementation-aware
		 *   - FOUR-CRITERIA TEST VALIDITY GATE:
		 *     [v] C1 VALID: cites PRE-RAWIO-1, POST-RAWIO-2b, ERRORS-RAWIO-1b, FORBIDDEN-RAWIO-1b
		 *     [v] C2 VALUABLE: catches unformatted errors or in-process open fallback
		 *     [v] C3 NON-DUPLICATIVE: sole test of ERRORS-RAWIO-1b crash and FORBIDDEN-RAWIO-1b no-fallback
		 *     [v] C4 NOT FUTURE-EDIT: enforces current SLICE-4 error behavior
		 */
		const loaded = await tryLoadRawIoClient();
		const classifyFn = loaded.module?.[RAW_IO_CLASSIFY_FN_NAME];
		if (typeof classifyFn !== "function") {
			throw new Error(
				[
					"1. WHAT: Raw-I/O Helper classification entry point FAILED to load for failure-handling test",
					"2. WHY: POST-RAWIO-2b / ERRORS-RAWIO-1b violation - classification function is not exported on the contracted client surface",
					`3. EXPECTED: typeof ${RAW_IO_CLASSIFY_FN_NAME} === 'function' (loadError === undefined)`,
					`4. ACTUAL: typeof ${RAW_IO_CLASSIFY_FN_NAME} === ${JSON.stringify(typeof classifyFn)} (loadError=${JSON.stringify(loaded.loadError)})`,
					"5. GUIDANCE: The contracted client surface must provide the classification entry point with failure and timeout propagation",
				].join("\n"),
			);
		}

		const dbPath = path.join(tempDir, "fail-closed.db");
		const db = new Database(dbPath);
		const heldInodeFds: number[] = [];
		try {
			db.run("PRAGMA journal_mode = WAL;");
			db.run("CREATE TABLE t (id INTEGER PRIMARY KEY);");
			db.run("BEGIN IMMEDIATE;");
			db.run("INSERT INTO t DEFAULT VALUES;");

			let relativeErr: unknown;
			try {
				await classifyFn("relative/not-allowed.db");
			} catch (err) {
				relativeErr = err;
			}
			if (!(relativeErr instanceof Error)) {
				throw new Error(
					[
						"1. WHAT: PRE-RAWIO-1 relative-path rejection FAILED",
						"2. WHY: PRE-RAWIO-1 violation - relative path was not rejected before helper dispatch",
						"3. EXPECTED: Error thrown for non-absolute targetPath 'relative/not-allowed.db'",
						`4. ACTUAL: ${JSON.stringify(relativeErr)}`,
						"5. GUIDANCE: Non-absolute or empty target paths must be rejected before any helper I/O",
					].join("\n"),
				);
			}

			// Probe the exact inode on both failure paths. SQLite's WAL writer
			// oracle alone can stay blocked after a parent open/close drops this lock.
			const inodeTarget = path.join(tempDir, "inode-proof.db-journal");
			await fs.writeFile(inodeTarget, "held-inode-proof\n");
			expect(
				peerPosixWriteLockBlocked(inodeTarget).blocked,
				assertionContext("FORBIDDEN-RAWIO-1b", "the independent inode-lock control starts unlocked"),
			).toBe(false);
			const observations: { mode: string; clauseId: unknown; lockRetained: boolean }[] = [];
			const messageFailures: string[] = [];
			for (const [mode, executable] of [
				["cannot-start", path.join(tempDir, "missing-helper-executable")],
				["crash", "/bin/false"],
			]) {
				heldInodeFds.push(acquireInProcessPosixWriteLock(inodeTarget));
				expect(
					peerPosixWriteLockBlocked(inodeTarget).blocked,
					assertionContext("FORBIDDEN-RAWIO-1b", `${mode}: the actual caller-owned inode lock is held`),
				).toBe(true);
				let failure: unknown;
				try {
					await classifyFn(inodeTarget, { helperSpawnCommand: { cmd: [executable] } });
				} catch (err) {
					failure = err;
				}
				// Observe before closing any parent descriptor, including when a
				// preceding case failed; each case independently reacquires its lock.
				observations.push({
					mode,
					clauseId: failure instanceof Error ? Reflect.get(failure, "clauseId") : undefined,
					lockRetained: peerPosixWriteLockBlocked(inodeTarget).blocked,
				});
				try {
					validateHelperFailureError(failure instanceof Error ? failure.message : "", "classify", inodeTarget);
				} catch (err) {
					messageFailures.push(`${mode}: ${String(err)}`);
				}
			}
			expect(
				messageFailures,
				assertionContext("ERRORS-RAWIO-1b", "both startup and crash failures name the operation and target"),
			).toEqual([]);
			expect(
				observations,
				assertionContext(
					"FORBIDDEN-RAWIO-1b / ERRORS-RAWIO-1b",
					"each helper failure retains the exact held inode lock",
				),
			).toEqual([
				{ mode: "cannot-start", clauseId: "ERRORS-RAWIO-1b", lockRetained: true },
				{ mode: "crash", clauseId: "ERRORS-RAWIO-1b", lockRetained: true },
			]);
			const postFailureLockProbe = peerWriteBlocked(dbPath);
			if (!postFailureLockProbe.blocked) {
				throw new Error(
					[
						"1. WHAT: No-in-process-fallback guarantee FAILED on Raw-I/O Helper failure/timeout",
						"2. WHY: FORBIDDEN-RAWIO-1b violation - held WAL lock on fail-closed.db was lost after helper failure/timeout",
						`3. EXPECTED: peerWriteBlocked(${JSON.stringify(dbPath)}).blocked === true`,
						`4. ACTUAL: peerWriteBlocked(${JSON.stringify(dbPath)}).blocked === false (${postFailureLockProbe.detail})`,
						"5. GUIDANCE: Helper failure or timeout must never fall back to an in-process file open; omp must retain all held POSIX locks",
					].join("\n"),
				);
			}
		} finally {
			for (const fd of heldInodeFds) fsSync.closeSync(fd);
			try {
				db.run("ROLLBACK;");
			} catch {}
			db.close();
		}
	});

	it("enforces T4 timeout semantics: started signal, classify fixed limit, read/write no-progress limit, helper kill on timeout, write outcome-unknown error, and queued request survival/fail-closed", async () => {
		/*
		 * CONTRACT TRACEABILITY:
		 *   - Contract: contracts/raw_io_helper.contract.ts (RAW_IO_HELPER_CONTRACT)
		 *   - Enforces: POST-RAWIO-2b, ERRORS-RAWIO-1, FORBIDDEN-RAWIO-1b
		 *   - Category: timeout & queue lifecycle boundary (T4.1 - T4.5)
		 *   - Risk tier: HIGH - hung helper or late-landing write after timeout corrupts state or drops POSIX locks (#15586)
		 *   - Adversarial: Contract-governed, implementation-aware
		 *   - FOUR-CRITERIA TEST VALIDITY GATE:
		 *     [v] C1 VALID: cites POST-RAWIO-2b, ERRORS-RAWIO-1, FORBIDDEN-RAWIO-1b
		 *     [v] C2 VALUABLE: verifies classify fixed timeout + PID kill, read no-progress vs total duration, missing started timeout, write outcome-unknown + no late write, and queue survival + fail-closed
		 *     [v] C3 NON-DUPLICATIVE: sole test of T4/R1 = A & B7 timeout and queue semantics
		 *     [v] C4 NOT FUTURE-EDIT: enforces current SLICE-4 contracted timeout behavior
		 */
		const loaded = await tryLoadRawIoClient();
		const classifyFn = loaded.module?.[RAW_IO_CLASSIFY_FN_NAME];
		const readBytesFn = loaded.module?.[RAW_IO_READ_BYTES_FN_NAME];
		const writeBytesFn = loaded.module?.[RAW_IO_WRITE_BYTES_FN_NAME];
		const stopFn = loaded.module?.[RAW_IO_STOP_FN_NAME];
		if (
			typeof classifyFn !== "function" ||
			typeof readBytesFn !== "function" ||
			typeof writeBytesFn !== "function" ||
			typeof stopFn !== "function"
		) {
			throw new Error(
				[
					"1. WHAT: Raw-I/O Helper client functions FAILED to load for T4 timeout test",
					"2. WHY: POST-RAWIO-2b / POST-RAWIO-2c violation - required exports missing on raw-io-client",
					"3. EXPECTED: classifyRawIoTarget, readRawIoBytes, writeRawIoBytes, and stopRawIoHelper exported as functions",
					`4. ACTUAL: classify=${typeof classifyFn}, read=${typeof readBytesFn}, write=${typeof writeBytesFn}, stop=${typeof stopFn}`,
					"5. GUIDANCE: The contracted client surface must export all four functions with T4 timeout support",
				].join("\n"),
			);
		}

		// Controlled child helper script using Atomics.wait so every operation has a hard
		// ceiling (<= 2000ms) and cannot hang the test suite if the parent fails to time out.
		const helperScriptPath = path.join(tempDir, "t4-controlled-helper.mjs");
		const pidFilePath = path.join(tempDir, "t4-helper.pid");
		const spawnCountPath = path.join(tempDir, "t4-spawn-count.txt");
		const helperScript = [
			'import * as fs from "node:fs";',
			"const mode = process.argv[2];",
			"const auxFile = process.argv[3];",
			"let spawnNumber = 1;",
			'if (auxFile && auxFile !== "none") {',
			'  if (mode.startsWith("queue-retry-")) {',
			"    let prev = 0;",
			'    try { prev = Number(fs.readFileSync(auxFile, "utf8").trim()) || 0; } catch {}',
			"    spawnNumber = prev + 1;",
			'    fs.writeFileSync(auxFile, String(spawnNumber), "utf8");',
			"  } else {",
			'    fs.writeFileSync(auxFile, String(process.pid), "utf8");',
			"  }",
			"}",
			"const waitMs = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };",
			"let reqIndex = 0;",
			'process.on("message", (msg) => {',
			'  if (!msg || typeof msg !== "object") return;',
			"  const idx = reqIndex++;",
			'  if (mode === "classify-hang-after-started") {',
			'    process.send({ type: "started", id: msg.id });',
			"    waitMs(1500);",
			"    process.exit(0);",
			'  } else if (mode === "read-progress-succeeds") {',
			'    process.send({ type: "started", id: msg.id });',
			"    for (let i = 1; i <= 4; i++) {",
			"      waitMs(100);",
			'      process.send({ type: "progress", id: msg.id, bytesProcessed: i * 4 });',
			"    }",
			'    process.send({ type: "read_ok", id: msg.id, bytes: new Uint8Array([1, 2, 3, 4]) });',
			'  } else if (mode === "read-stall-after-progress") {',
			'    process.send({ type: "started", id: msg.id });',
			"    waitMs(100);",
			'    process.send({ type: "progress", id: msg.id, bytesProcessed: 4 });',
			"    waitMs(1500);",
			"    process.exit(0);",
			'  } else if (mode === "never-started") {',
			"    waitMs(1500);",
			"    process.exit(0);",
			'  } else if (mode === "write-late-after-stall") {',
			'    process.send({ type: "started", id: msg.id });',
			"    waitMs(2000);",
			"    fs.writeFileSync(msg.targetPath, msg.data);",
			'    process.send({ type: "write_ok", id: msg.id });',
			'  } else if (mode === "queue-first-slow-second-fast") {',
			"    if (idx === 0) {",
			'      if (msg.type !== "read") {',
			'        process.send({ type: "error", id: msg.id, operation: msg.type, targetPath: msg.targetPath, error: "second request was not queued on shared helper" });',
			"        return;",
			"      }",
			'      process.send({ type: "started", id: msg.id });',
			"      for (let i = 1; i <= 4; i++) {",
			"        waitMs(100);",
			'        process.send({ type: "progress", id: msg.id, bytesProcessed: i * 4 });',
			"      }",
			'      process.send({ type: "read_ok", id: msg.id, bytes: new Uint8Array([9, 8, 7, 6]) });',
			"    } else {",
			'      process.send({ type: "started", id: msg.id });',
			"      process.send({",
			'        type: "classified",',
			"        id: msg.id,",
			"        classification: {",
			"          targetPath: msg.targetPath,",
			"          resolvedPath: msg.targetPath,",
			'          kind: "sqlite_db",',
			"          isSqliteFamily: true,",
			"          helperPid: process.pid,",
			"          headerBytes: new Uint8Array(16),",
			'          entryKind: "file",',
			"        },",
			"      });",
			"    }",
			'  } else if (mode === "queue-retry-timeout-then-succeed") {',
			"    if (spawnNumber === 1) {",
			'      process.send({ type: "started", id: msg.id });',
			"      waitMs(1500);",
			"      process.exit(0);",
			"    } else {",
			'      process.send({ type: "started", id: msg.id });',
			'      process.send({ type: "progress", id: msg.id, bytesProcessed: 4 });',
			'      process.send({ type: "read_ok", id: msg.id, bytes: new Uint8Array([42, 43, 44, 45]) });',
			"    }",
			'  } else if (mode === "queue-retry-timeout-both-fail") {',
			'    process.send({ type: "started", id: msg.id });',
			"    waitMs(1500);",
			"    process.exit(0);",
			'  } else if (mode === "queue-retry-crash-then-succeed") {',
			"    if (spawnNumber === 1) {",
			'      process.send({ type: "started", id: msg.id });',
			"      process.exit(1);",
			"    } else {",
			'      process.send({ type: "started", id: msg.id });',
			'      process.send({ type: "progress", id: msg.id, bytesProcessed: 4 });',
			'      process.send({ type: "read_ok", id: msg.id, bytes: new Uint8Array([7, 8, 9, 10]) });',
			"    }",
			'  } else if (mode === "queue-retry-readtool-classify-timeout") {',
			"    if (spawnNumber === 1) {",
			'      process.send({ type: "started", id: msg.id });',
			"      waitMs(1500);",
			"      process.exit(0);",
			"    } else {",
			'      process.send({ type: "started", id: msg.id });',
			"      process.send({",
			'        type: "classified",',
			"        id: msg.id,",
			"        classification: {",
			"          targetPath: msg.targetPath,",
			"          resolvedPath: msg.targetPath,",
			'          kind: "non_sqlite",',
			"          isSqliteFamily: false,",
			"          helperPid: process.pid,",
			"          headerBytes: new Uint8Array([65, 66, 67, 68]),",
			'          entryKind: "file",',
			"        },",
			"      });",
			"    }",
			"  }",
			"});",
		].join("\n");
		await fs.writeFile(helperScriptPath, helperScript, "utf8");

		const waitForPidDead = (pid: number): boolean => {
			const probeScript = [
				"const pid = Number(process.argv[1]);",
				"const waitMs = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };",
				"for (let i = 0; i < 20; i++) {",
				"  try { process.kill(pid, 0); } catch { console.log('DEAD'); process.exit(0); }",
				"  waitMs(10);",
				"}",
				"console.log('ALIVE');",
			].join("\n");
			const proc = Bun.spawnSync({
				cmd: [process.execPath, "-e", probeScript, String(pid)],
				stdout: "pipe",
			});
			return new TextDecoder().decode(proc.stdout).trim() === "DEAD";
		};

		const dbPath = path.join(tempDir, "t4-locked.db");
		const secondDbPath = path.join(tempDir, "t4-second-locked.db");
		const writeTargetPath = path.join(tempDir, "t4-write-target.db-journal");
		await fs.writeFile(writeTargetPath, "original-safe-bytes\n", "utf8");

		const db1 = new Database(dbPath);
		const db2 = new Database(secondDbPath);
		const failures: string[] = [];

		try {
			db1.run("PRAGMA journal_mode = WAL; CREATE TABLE t (id INT); BEGIN IMMEDIATE; INSERT INTO t VALUES (1);");
			db2.run("PRAGMA journal_mode = WAL; CREATE TABLE t (id INT); BEGIN IMMEDIATE; INSERT INTO t VALUES (1);");

			// T4.1: classify sends 'started' and never answers -> times out within bounded time,
			// names 'classify' and dbPath, and kills the helper PID.
			await stopFn();
			const t41Start = performance.now();
			let t41Err: unknown;
			try {
				await classifyFn(dbPath, {
					helperSpawnCommand: {
						cmd: [process.execPath, helperScriptPath, "classify-hang-after-started", pidFilePath],
					},
					timeoutMs: 500,
				});
			} catch (err) {
				t41Err = err;
			}
			const t41Elapsed = performance.now() - t41Start;
			const t41Msg = t41Err instanceof Error ? t41Err.message : "";
			const t41Pid = Number((await fs.readFile(pidFilePath, "utf8").catch(() => "0")).trim());
			const t41Dead = t41Pid > 0 ? waitForPidDead(t41Pid) : false;
			try {
				validateHelperFailureError(t41Msg, "classify", dbPath, { timedOut: true });
				if (t41Elapsed >= 1200 || !t41Dead) {
					failures.push(
						`T4.1 FAILED: expected classify timeout <1200ms and killed helper PID (elapsed=${Math.round(t41Elapsed)}ms, pid=${String(t41Pid)}, dead=${String(t41Dead)}, msg=${JSON.stringify(t41Msg)})`,
					);
				}
			} catch (validationErr) {
				failures.push(
					`T4.1 FAILED (classify fixed timeout & helper kill): ${validationErr instanceof Error ? validationErr.message : String(validationErr)} (elapsed=${Math.round(t41Elapsed)}ms, msg=${JSON.stringify(t41Msg)})`,
				);
			}

			// T4.2a: read that keeps sending 'progress' for longer than timeoutMs in total MUST NOT time out.
			await stopFn();
			try {
				const bytes = await readBytesFn(dbPath, 0, 4, {
					helperSpawnCommand: { cmd: [process.execPath, helperScriptPath, "read-progress-succeeds", "none"] },
					timeoutMs: 500,
				});
				if (bytes.byteLength !== 4 || bytes[0] !== 1 || bytes[3] !== 4) {
					failures.push(`T4.2a FAILED: unexpected bytes from progressing read: ${JSON.stringify([...bytes])}`);
				}
			} catch (err) {
				failures.push(
					`T4.2a FAILED (progressing read should not time out): ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			// T4.2b: read that stops sending 'progress' MUST time out.
			await stopFn();
			let t42bErr: unknown;
			try {
				await readBytesFn(dbPath, 0, 8, {
					helperSpawnCommand: { cmd: [process.execPath, helperScriptPath, "read-stall-after-progress", "none"] },
					timeoutMs: 500,
				});
			} catch (err) {
				t42bErr = err;
			}
			const t42bMsg = t42bErr instanceof Error ? t42bErr.message : "";
			try {
				validateHelperFailureError(t42bMsg, "read", dbPath, { timedOut: true });
			} catch (validationErr) {
				failures.push(
					`T4.2b FAILED (stalled read after progress must time out): ${validationErr instanceof Error ? validationErr.message : String(validationErr)} (msg=${JSON.stringify(t42bMsg)})`,
				);
			}

			// T4.3: helper that never sends 'started' MUST time out.
			await stopFn();
			let t43Err: unknown;
			try {
				await classifyFn(dbPath, {
					helperSpawnCommand: { cmd: [process.execPath, helperScriptPath, "never-started", "none"] },
					timeoutMs: 500,
				});
			} catch (err) {
				t43Err = err;
			}
			const t43Msg = t43Err instanceof Error ? t43Err.message : "";
			try {
				validateHelperFailureError(t43Msg, "classify", dbPath, { timedOut: true });
			} catch (validationErr) {
				failures.push(
					`T4.3 FAILED (missing 'started' signal must time out): ${validationErr instanceof Error ? validationErr.message : String(validationErr)} (msg=${JSON.stringify(t43Msg)})`,
				);
			}

			// T4.4: write timeout states outcome is unknown and kills helper before late write lands.
			await stopFn();
			const writePidFile = path.join(tempDir, "t4-write.pid");
			let t44Err: unknown;
			try {
				await writeBytesFn(writeTargetPath, new TextEncoder().encode("CORRUPTED-LATE-WRITE\n"), {
					helperSpawnCommand: {
						cmd: [process.execPath, helperScriptPath, "write-late-after-stall", writePidFile],
					},
					timeoutMs: 500,
				});
			} catch (err) {
				t44Err = err;
			}
			const t44Msg = t44Err instanceof Error ? t44Err.message : "";
			const t44Pid = Number((await fs.readFile(writePidFile, "utf8").catch(() => "0")).trim());
			if (t44Pid > 0) {
				waitForPidDead(t44Pid);
			}
			// Wait past the helper's 2000ms late-write point using a child probe to prove
			// the killed helper never lands the write afterwards.
			Bun.spawnSync({
				cmd: [process.execPath, "-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1700);"],
			});
			const postTimeoutWriteContent = await fs.readFile(writeTargetPath, "utf8");
			try {
				validateHelperFailureError(t44Msg, "write", writeTargetPath, { timedOut: true });
				if (postTimeoutWriteContent !== "original-safe-bytes\n") {
					failures.push(
						`T4.4 FAILED: late write landed after timeout (content=${JSON.stringify(postTimeoutWriteContent)})`,
					);
				}
			} catch (validationErr) {
				failures.push(
					`T4.4 FAILED (write timeout unknown-outcome & no late write): ${validationErr instanceof Error ? validationErr.message : String(validationErr)} (msg=${JSON.stringify(t44Msg)}, content=${JSON.stringify(postTimeoutWriteContent)})`,
				);
			}

			// T4.5a: request queued behind a slow-but-progressing active request does NOT time out while waiting.
			await stopFn();
			const sharedQueueCmd = [process.execPath, helperScriptPath, "queue-first-slow-second-fast", "none"];
			try {
				const [firstBytes, secondClassified] = await Promise.all([
					readBytesFn(dbPath, 0, 4, {
						helperSpawnCommand: { cmd: sharedQueueCmd },
						timeoutMs: 500,
					}),
					classifyFn(secondDbPath, {
						helperSpawnCommand: { cmd: sharedQueueCmd },
						timeoutMs: 500,
					}),
				]);
				const secondRec = validateClassificationRecord(toClassificationInput(secondClassified, process.pid));
				if (firstBytes.byteLength !== 4 || secondRec.kind !== "sqlite_db") {
					failures.push(`T4.5a FAILED: unexpected queued results`);
				}
			} catch (err) {
				failures.push(
					`T4.5a FAILED (queued request behind slow active request must not time out while waiting): ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			// T4.5b: when the active request times out and kills the shared helper, the queued request
			// (never sent to the killed helper) is retried once on a fresh helper and succeeds, with
			// onRequest firing once for each request sent.
			await stopFn();
			await fs.rm(spawnCountPath, { force: true });
			const retrySuccessLog: RawIoHelperRequestEntry[] = [];
			const sharedRetrySuccessCmd = [
				process.execPath,
				helperScriptPath,
				"queue-retry-timeout-then-succeed",
				spawnCountPath,
			];
			const [activeTimeoutSettled, queuedRetriedSettled] = await Promise.allSettled([
				classifyFn(dbPath, {
					helperSpawnCommand: { cmd: sharedRetrySuccessCmd },
					timeoutMs: 500,
					onRequest(entry) {
						retrySuccessLog.push(entry);
					},
				}),
				readBytesFn(secondDbPath, 0, 4, {
					helperSpawnCommand: { cmd: sharedRetrySuccessCmd },
					timeoutMs: 500,
					onRequest(entry) {
						retrySuccessLog.push(entry);
					},
				}),
			]);
			const activeTimeoutMsg =
				activeTimeoutSettled.status === "rejected" && activeTimeoutSettled.reason instanceof Error
					? activeTimeoutSettled.reason.message
					: "";
			try {
				validateHelperFailureError(activeTimeoutMsg, "classify", dbPath, { timedOut: true });
				if (
					queuedRetriedSettled.status !== "fulfilled" ||
					queuedRetriedSettled.value.byteLength !== 4 ||
					queuedRetriedSettled.value[0] !== 42 ||
					retrySuccessLog.length !== 2 ||
					retrySuccessLog[0]?.operation !== "classify" ||
					retrySuccessLog[1]?.operation !== "read"
				) {
					const qDetail =
						queuedRetriedSettled.status === "rejected"
							? String(queuedRetriedSettled.reason)
							: JSON.stringify([...queuedRetriedSettled.value]);
					failures.push(
						`T4.5b FAILED (queued request behind timed-out active request must succeed on fresh helper with 1 onRequest each): queued=${qDetail}, log=${JSON.stringify(retrySuccessLog)}`,
					);
				}
			} catch (validationErr) {
				failures.push(
					`T4.5b FAILED (active timeout error validation): ${validationErr instanceof Error ? validationErr.message : String(validationErr)} (active=${JSON.stringify(activeTimeoutMsg)})`,
				);
			}

			// T4.5c: when the fresh helper ALSO times out on the retried request, the retried request
			// fails naming its own operation and target path, with no second retry (spawnCount === 2).
			await stopFn();
			await fs.rm(spawnCountPath, { force: true });
			const sharedRetryBothFailCmd = [
				process.execPath,
				helperScriptPath,
				"queue-retry-timeout-both-fail",
				spawnCountPath,
			];
			const [firstFailSettled, secondFailSettled] = await Promise.allSettled([
				classifyFn(dbPath, {
					helperSpawnCommand: { cmd: sharedRetryBothFailCmd },
					timeoutMs: 500,
				}),
				readBytesFn(secondDbPath, 0, 16, {
					helperSpawnCommand: { cmd: sharedRetryBothFailCmd },
					timeoutMs: 500,
				}),
			]);
			const firstFailMsg =
				firstFailSettled.status === "rejected" && firstFailSettled.reason instanceof Error
					? firstFailSettled.reason.message
					: "";
			const secondFailMsg =
				secondFailSettled.status === "rejected" && secondFailSettled.reason instanceof Error
					? secondFailSettled.reason.message
					: "";
			const bothFailSpawns = Number((await fs.readFile(spawnCountPath, "utf8").catch(() => "0")).trim());
			try {
				validateHelperFailureError(firstFailMsg, "classify", dbPath, { timedOut: true });
				validateHelperFailureError(secondFailMsg, "read", secondDbPath, { timedOut: true });
				if (bothFailSpawns !== 2) {
					failures.push(
						`T4.5c FAILED: expected exactly 2 helper spawns (initial + 1 retry, no second retry); got ${String(bothFailSpawns)}`,
					);
				}
			} catch (validationErr) {
				failures.push(
					`T4.5c FAILED (retried request on fresh helper that also times out must fail naming its own operation and path): ${validationErr instanceof Error ? validationErr.message : String(validationErr)} (first=${JSON.stringify(firstFailMsg)}, second=${JSON.stringify(secondFailMsg)}, spawns=${String(bothFailSpawns)})`,
				);
			}

			// T4.6 (Q1 = a): when the active helper CRASHES, only the active request fails and the
			// queued request is retried once on a fresh helper and succeeds.
			await stopFn();
			await fs.rm(spawnCountPath, { force: true });
			const sharedCrashRetryCmd = [
				process.execPath,
				helperScriptPath,
				"queue-retry-crash-then-succeed",
				spawnCountPath,
			];
			const [crashActiveSettled, crashQueuedSettled] = await Promise.allSettled([
				classifyFn(dbPath, {
					helperSpawnCommand: { cmd: sharedCrashRetryCmd },
					timeoutMs: 500,
				}),
				readBytesFn(secondDbPath, 0, 4, {
					helperSpawnCommand: { cmd: sharedCrashRetryCmd },
					timeoutMs: 500,
				}),
			]);
			const crashActiveMsg =
				crashActiveSettled.status === "rejected" && crashActiveSettled.reason instanceof Error
					? crashActiveSettled.reason.message
					: "";
			try {
				validateHelperFailureError(crashActiveMsg, "classify", dbPath);
				if (
					crashQueuedSettled.status !== "fulfilled" ||
					crashQueuedSettled.value.byteLength !== 4 ||
					crashQueuedSettled.value[0] !== 7
				) {
					const qCrashDetail =
						crashQueuedSettled.status === "rejected"
							? String(crashQueuedSettled.reason)
							: JSON.stringify([...crashQueuedSettled.value]);
					failures.push(
						`T4.6 FAILED (queued request behind crashed helper must succeed on fresh helper): queued=${qCrashDetail}`,
					);
				}
			} catch (validationErr) {
				failures.push(
					`T4.6 FAILED (crash active error validation): ${validationErr instanceof Error ? validationErr.message : String(validationErr)} (active=${JSON.stringify(crashActiveMsg)})`,
				);
			}

			// T4.7 (ERRORS-RAWIO-1c & POST-RAWIO-2b): unit test of exported resolveTimeoutAfterKillWait
			// production function with helperExited=false and helperExited=true.
			const resolveKillWaitFn = loaded.module?.[RAW_IO_RESOLVE_KILL_WAIT_FN_NAME];
			if (typeof resolveKillWaitFn !== "function") {
				failures.push(
					`T4.7 FAILED (ERRORS-RAWIO-1c / POST-RAWIO-2b): ${RAW_IO_RESOLVE_KILL_WAIT_FN_NAME} is not exported as a function on ${RAW_IO_CLIENT_MODULE} (got ${typeof resolveKillWaitFn})`,
				);
			} else {
				try {
					const sampleQueued: RawIoHelperRequestEntry[] = [
						{ operation: "read", targetPath: secondDbPath },
						{ operation: "classify", targetPath: dbPath },
					];
					const unexitedRes = resolveKillWaitFn({
						operation: "write",
						targetPath: writeTargetPath,
						timeoutMs: 500,
						helperExited: false,
						queuedRequests: sampleQueued,
					});
					validateKillWaitResolution(unexitedRes, {
						operation: "write",
						targetPath: writeTargetPath,
						helperExited: false,
						queuedRequests: sampleQueued,
					});
					const exitedRes = resolveKillWaitFn({
						operation: "write",
						targetPath: writeTargetPath,
						timeoutMs: 500,
						helperExited: true,
						queuedRequests: sampleQueued,
					});
					validateKillWaitResolution(exitedRes, {
						operation: "write",
						targetPath: writeTargetPath,
						helperExited: true,
						queuedRequests: sampleQueued,
					});
				} catch (validationErr) {
					failures.push(
						`T4.7 FAILED (resolveTimeoutAfterKillWait validation): ${validationErr instanceof Error ? validationErr.message : String(validationErr)}`,
					);
				}
			}
			// T4.8 (G1): ReadTool on a real .db whose classify times out must reject on the first
			// classify attempt naming 'classify' and dbPath without isSqliteFile swallowing the
			// timeout error into false and falling through to an in-process read.
			await stopFn();
			await fs.rm(spawnCountPath, { force: true });
			const g1Requests: RawIoHelperRequestEntry[] = [];
			const g1Session = createTestToolSession(tempDir, {
				helperSpawnCommand: {
					cmd: [process.execPath, helperScriptPath, "queue-retry-readtool-classify-timeout", spawnCountPath],
				},
				timeoutMs: 500,
				onRequest(entry) {
					g1Requests.push(entry);
				},
			});
			const g1ReadTool = new ReadTool(g1Session);
			let g1Err: unknown;
			let g1ReturnedText: string | undefined;
			try {
				const g1Result = await g1ReadTool.execute("call-g1-read-db-timeout", { path: dbPath });
				g1ReturnedText = extractToolText(g1Result);
			} catch (err) {
				g1Err = err;
			}
			const g1ErrMsg = g1Err instanceof Error ? g1Err.message : "";
			const db1LockAfter = peerWriteBlocked(dbPath);
			const db2LockAfter = peerWriteBlocked(secondDbPath);
			try {
				validateHelperFailureError(g1ErrMsg, "classify", dbPath, { timedOut: true });
				if (g1Requests.length !== 1 || g1ReturnedText !== undefined || !db1LockAfter.blocked) {
					failures.push(
						`T4.8 FAILED (ReadTool classify timeout must fail on 1st classify without falling through in-process): requests=${g1Requests.length}, text=${JSON.stringify(g1ReturnedText)}, db1Lock=${db1LockAfter.detail}`,
					);
				}
			} catch (validationErr) {
				failures.push(
					`T4.8 FAILED (G1 ReadTool classify timeout): ${validationErr instanceof Error ? validationErr.message : String(validationErr)} (err=${JSON.stringify(g1ErrMsg)}, text=${JSON.stringify(g1ReturnedText)}, requests=${g1Requests.length}, db1Lock=${db1LockAfter.detail})`,
				);
			}
			// T4.9 (ERRORS-RAWIO-1d / G3 = a): while a timed-out write's helper has not exited,
			// refuse new writes to the same target (including symlink alias and differently spelled
			// path), allow reads on that target and writes to other files on a fresh helper, and
			// lift the block when exitPromise settles.
			await stopFn();
			const registerUnexitedFn = loaded.module?.[RAW_IO_REGISTER_UNEXITED_WRITE_FN_NAME];
			if (typeof registerUnexitedFn !== "function") {
				failures.push(
					`T4.9 FAILED (ERRORS-RAWIO-1d / POST-RAWIO-2b): ${RAW_IO_REGISTER_UNEXITED_WRITE_FN_NAME} is not exported as a function on ${RAW_IO_CLIENT_MODULE} (got ${typeof registerUnexitedFn})`,
				);
			} else {
				const symlinkWriteAlias = path.join(tempDir, "t4-write-alias-symlink.db-journal");
				const dotSpelledWritePath = `${tempDir}/./t4-write-target.db-journal`;
				const otherWritePath = path.join(tempDir, "t4-other-target.db-journal");
				await fs.symlink(writeTargetPath, symlinkWriteAlias);
				const exitDeferred = Promise.withResolvers<void>();
				try {
					registerUnexitedFn(writeTargetPath, exitDeferred.promise);

					let directRefusalErr: unknown;
					try {
						await writeBytesFn(writeTargetPath, new TextEncoder().encode("blocked-direct\n"));
					} catch (err) {
						directRefusalErr = err;
					}
					let symlinkRefusalErr: unknown;
					try {
						await writeBytesFn(symlinkWriteAlias, new TextEncoder().encode("blocked-symlink\n"));
					} catch (err) {
						symlinkRefusalErr = err;
					}
					let dotSpelledRefusalErr: unknown;
					try {
						await writeBytesFn(dotSpelledWritePath, new TextEncoder().encode("blocked-dot\n"));
					} catch (err) {
						dotSpelledRefusalErr = err;
					}
					const directRefusalMsg = directRefusalErr instanceof Error ? directRefusalErr.message : "";
					const symlinkRefusalMsg = symlinkRefusalErr instanceof Error ? symlinkRefusalErr.message : "";
					const dotSpelledRefusalMsg = dotSpelledRefusalErr instanceof Error ? dotSpelledRefusalErr.message : "";
					validateHelperFailureError(directRefusalMsg, "write", writeTargetPath, {
						unexitedWriteTargetRefusal: true,
					});
					validateHelperFailureError(symlinkRefusalMsg, "write", symlinkWriteAlias, {
						unexitedWriteTargetRefusal: true,
					});
					validateHelperFailureError(dotSpelledRefusalMsg, "write", dotSpelledWritePath, {
						unexitedWriteTargetRefusal: true,
					});

					// Read on the blocked target and write to another file both proceed on a fresh helper.
					const readDuringBlock = await readBytesFn(writeTargetPath, 0, 8);
					await writeBytesFn(otherWritePath, new TextEncoder().encode("other-file-ok\n"));
					const otherFileText = await fs.readFile(otherWritePath, "utf8");
					if (readDuringBlock.byteLength !== 8 || otherFileText !== "other-file-ok\n") {
						failures.push(
							`T4.9 FAILED: read or other-file write blocked during unexited write guard (readLen=${readDuringBlock.byteLength}, other=${JSON.stringify(otherFileText)})`,
						);
					}

					// Settling exitPromise lifts the block so a subsequent write to writeTargetPath succeeds.
					exitDeferred.resolve();
					await exitDeferred.promise;
					await writeBytesFn(writeTargetPath, new TextEncoder().encode("after-lift-ok\n"));
					const afterLiftText = await fs.readFile(writeTargetPath, "utf8");
					if (afterLiftText !== "after-lift-ok\n") {
						failures.push(`T4.9 FAILED: write after exitPromise lift produced ${JSON.stringify(afterLiftText)}`);
					}
				} catch (validationErr) {
					failures.push(
						`T4.9 FAILED (ERRORS-RAWIO-1d unexited write guard & lift): ${validationErr instanceof Error ? validationErr.message : String(validationErr)}`,
					);
				} finally {
					exitDeferred.resolve();
				}
			}

			if (!db1LockAfter.blocked || !db2LockAfter.blocked) {
				failures.push(`T4 lock retention FAILED: db1=${db1LockAfter.detail}, db2=${db2LockAfter.detail}`);
			}
			if (failures.length > 0) {
				throw new Error(
					[
						"1. WHAT: Raw-I/O Helper T4 timeout, crash-retry, kill-wait, and unexited-write guard semantics FAILED",
						"2. WHY: POST-RAWIO-2b / ERRORS-RAWIO-1 / ERRORS-RAWIO-1b / ERRORS-RAWIO-1c / ERRORS-RAWIO-1d / FORBIDDEN-RAWIO-1b violation",
						"3. EXPECTED: All T4 sub-scenarios (T4.1-T4.9) pass",
						`4. ACTUAL:\n${failures.map(f => `  - ${f}`).join("\n")}`,
						"5. GUIDANCE: Enforce timeout, crash-retry, resolveTimeoutAfterKillWait, and registerUnexitedWriteTarget write refusal and lift",
					].join("\n"),
				);
			}
		} finally {
			await stopFn();
			try {
				db1.run("ROLLBACK;");
			} catch {}
			try {
				db2.run("ROLLBACK;");
			} catch {}
			db1.close();
			db2.close();
		}
	}, 20000);

	it("retains a held db-shm POSIX lock during ReadTool :conflicts (audit #1/#13)", async () => {
		/*
		 * CONTRACT AUTHORITY: contracts/raw_io_helper.contract.ts (RAW_IO_HELPER_CONTRACT).
		 * Enforces: POST-RAWIO-3, FORBIDDEN-RAWIO-3; REGRESSION: audit #1/#13.
		 * Category: integration, negative-space; Risk tier: HIGH (SQLite lock loss).
		 * C1 VALID: existing clauses forbid raw parent descriptors on SQLite-Family targets.
		 * C2 VALUABLE: a real parent open/close releases the lock observed by the peer.
		 * C3 NON-DUPLICATIVE: covers :conflicts, not the existing ordinary read path.
		 * C4 NOT FUTURE-EDIT: the current public conflict scan already violates the clauses.
		 * No test doubles; the lock acquisition and peer probe use the real kernel.
		 */
		const target = path.join(tempDir, "conflict-scan.db-shm");
		await fs.writeFile(target, "sidecar text without merge conflicts\n", "utf8");
		const readTool = new ReadTool(createTestToolSession(tempDir));
		const unlocked = peerPosixWriteLockBlocked(target);
		expect(
			unlocked.blocked,
			[
				"1. WHAT: ReadTool :conflicts lock-probe setup FAILED",
				"2. WHY: POST-RAWIO-3 / FORBIDDEN-RAWIO-3 observation requires an unlocked control",
				"3. EXPECTED: peer acquires the lock before the parent locks the target",
				`4. ACTUAL: ${unlocked.detail}`,
				"5. GUIDANCE: Establish an independently observable POSIX lock before exercising the tool",
			].join("\n"),
		).toBe(false);
		const fd = acquireInProcessPosixWriteLock(target);
		try {
			const before = peerPosixWriteLockBlocked(target);
			expect(
				before.blocked,
				[
					"1. WHAT: ReadTool :conflicts held-lock setup FAILED",
					"2. WHY: POST-RAWIO-3 / FORBIDDEN-RAWIO-3 require a genuinely held lock",
					"3. EXPECTED: the peer is blocked before the tool call",
					`4. ACTUAL: ${before.detail}`,
					"5. GUIDANCE: Verify the parent holds a conflicting lock before observing retention",
				].join("\n"),
			).toBe(true);
			const result = await readTool.execute("audit-read-conflicts", { path: `${target}:conflicts` });
			// Probe BEFORE any parent read/close of the target can invalidate the observation.
			const after = peerPosixWriteLockBlocked(target);
			expect(
				{ text: extractToolText(result), blocked: after.blocked },
				[
					"1. WHAT: ReadTool :conflicts held db-shm lock retention FAILED",
					"2. WHY: POST-RAWIO-3 / FORBIDDEN-RAWIO-3 apply to auxiliary conflict scanning",
					"3. EXPECTED: conflict reporting completes and the peer remains blocked",
					`4. ACTUAL: text=${JSON.stringify(extractToolText(result))}; before=${before.detail}; after=${after.detail}`,
					"5. GUIDANCE: Preserve the held SQLite-Family lock throughout conflict reporting",
				].join("\n"),
			).toEqual({ text: "No unresolved git merge conflicts in conflict-scan.db-shm.", blocked: true });
		} finally {
			fsSync.closeSync(fd);
		}
	});

	it("retains a held db-shm POSIX lock when WriteTool refuses an incomplete projection (audit #2/#13)", async () => {
		/*
		 * CONTRACT AUTHORITY: contracts/raw_io_helper.contract.ts (RAW_IO_HELPER_CONTRACT).
		 * Enforces: POST-RAWIO-3b, FORBIDDEN-RAWIO-3; REGRESSION: audit #2/#13.
		 * Category: integration, refusal path; Risk tier: HIGH (SQLite lock loss).
		 * C1 VALID: existing clauses cover all SQLite-Family byte access, even refused writes.
		 * C2 VALUABLE: the current refusal raw-reads the held inode and releases its lock.
		 * C3 NON-DUPLICATIVE: refusal is distinct from the existing successful byte write.
		 * C4 NOT FUTURE-EDIT: exercises the existing incomplete-projection guard.
		 * No test doubles; real WriteTool, POSIX lock and independent kernel probe.
		 */
		const target = path.join(tempDir, "projection.db-shm");
		const original = Array.from({ length: 1000 }, (_, i) => `sidecar line ${i}\n`).join("");
		await fs.writeFile(target, original, "utf8");
		// A real public ReadTool projection, obtained BEFORE acquiring the lock.
		const session = createTestToolSession(tempDir);
		const readResult = await new ReadTool(session).execute("audit-projection-source", { path: `${target}:1-8` });
		const projection = `${extractToolText(readResult)}\n\n[Showing lines 1-8 of 1000. Use :9 to continue]`;
		const writeTool = new WriteTool(session);
		const unlocked = peerPosixWriteLockBlocked(target);
		expect(
			unlocked.blocked,
			[
				"1. WHAT: WriteTool projection-refusal lock-probe setup FAILED",
				"2. WHY: POST-RAWIO-3b / FORBIDDEN-RAWIO-3 observation requires an unlocked control",
				"3. EXPECTED: peer acquires the lock before the parent locks the target",
				`4. ACTUAL: ${unlocked.detail}`,
				"5. GUIDANCE: Establish an independently observable POSIX lock before exercising the tool",
			].join("\n"),
		).toBe(false);
		const fd = acquireInProcessPosixWriteLock(target);
		try {
			const before = peerPosixWriteLockBlocked(target);
			expect(
				before.blocked,
				[
					"1. WHAT: WriteTool projection-refusal held-lock setup FAILED",
					"2. WHY: POST-RAWIO-3b / FORBIDDEN-RAWIO-3 require a genuinely held lock",
					"3. EXPECTED: the peer is blocked before the tool call",
					`4. ACTUAL: ${before.detail}`,
					"5. GUIDANCE: Verify the parent holds a conflicting lock before observing retention",
				].join("\n"),
			).toBe(true);
			let refusal: unknown;
			try {
				await writeTool.execute("audit-refuse-projection", { path: target, content: projection });
			} catch (error: unknown) {
				refusal = error;
			}
			// Collect BOTH refusal and retention before asserting; no first-assertion blindness.
			const after = peerPosixWriteLockBlocked(target);
			const message = refusal instanceof Error ? refusal.message : String(refusal);
			expect(
				{ refusedProjection: message.includes("with an incomplete read projection"), blocked: after.blocked },
				[
					"1. WHAT: WriteTool incomplete-projection refusal held db-shm lock retention FAILED",
					"2. WHY: POST-RAWIO-3b / FORBIDDEN-RAWIO-3 also govern byte access before a refused write",
					"3. EXPECTED: incomplete projection is refused and the peer remains blocked",
					`4. ACTUAL: refusal=${JSON.stringify(message)}; before=${before.detail}; after=${after.detail}`,
					"5. GUIDANCE: Preserve the held SQLite-Family lock even when the write is refused",
				].join("\n"),
			).toEqual({ refusedProjection: true, blocked: true });
		} finally {
			fsSync.closeSync(fd);
		}
	});

	it("routes ReadTool and WriteTool SQLite-Family targets through the Raw-I/O Helper or a SQLite connection while retaining held POSIX locks and keeping non_sqlite files on the in-process fast path", async () => {
		/*
		 * CONTRACT TRACEABILITY:
		 *   - Contract: contracts/raw_io_helper.contract.ts (RAW_IO_HELPER_CONTRACT)
		 *   - Enforces: POST-RAWIO-2b, POST-RAWIO-3, POST-RAWIO-3b, POST-RAWIO-3c, FORBIDDEN-RAWIO-3
		 *   - Category: integration (real ReadTool + WriteTool + live POSIX fcntl and WAL locks)
		 *   - Risk tier: HIGH - guards ReadTool and WriteTool Trigger Paths against in-process fd close lock loss (#15586)
		 *   - Adversarial: Contract-governed, implementation-aware
		 *   - FOUR-CRITERIA TEST VALIDITY GATE:
		 *     [v] C1 VALID: cites POST-RAWIO-2b, POST-RAWIO-3, POST-RAWIO-3b, POST-RAWIO-3c, FORBIDDEN-RAWIO-3
		 *     [v] C2 VALUABLE: any in-process open/close in ReadTool or WriteTool (e.g. Bun.file.slice in sqlite-reader, readWholeFile on -wal/-shm, or Bun.write on sidecar) drops the kernel POSIX lock and fails this test
		 *     [v] C3 NON-DUPLICATIVE: sole end-to-end test of ReadTool and WriteTool lock retention (T1/T2) and non_sqlite in-process fast path (T3)
		 *     [v] C4 NOT FUTURE-EDIT: enforces current SLICE-4 Batch 2 contracted behavior
		 */
		const dbPath = path.join(tempDir, "live-session.db");
		const walPath = `${dbPath}-wal`;
		const shmPath = `${dbPath}-shm`;
		const journalPath = path.join(tempDir, "sidecar-target.db-journal");
		const symlinkToDbTxt = path.join(tempDir, "session-mirror.txt");
		const symlinkToJournalTxt = path.join(tempDir, "journal-mirror.txt");
		const ordinaryPath = path.join(tempDir, "ordinary.txt");

		await fs.writeFile(ordinaryPath, "ordinary line 1\n", "utf8");

		const helperRequests: RawIoHelperRequestEntry[] = [];
		const session = createTestToolSession(tempDir, {
			onRequest(entry) {
				helperRequests.push(entry);
			},
		});
		const readTool = new ReadTool(session);
		const writeTool = new WriteTool(session);

		const db = new Database(dbPath);
		let journalLockFd: number | null = null;
		let walLockFd: number | null = null;

		try {
			db.run("PRAGMA journal_mode = WAL;");
			db.run("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL);");
			db.run("INSERT INTO items (label) VALUES ('committed-row');");
			db.run("BEGIN IMMEDIATE;");
			db.run("INSERT INTO items (label) VALUES ('uncommitted-wal-row');");
			await fs.writeFile(journalPath, "initial-journal-line\n", "utf8");
			await fs.symlink(dbPath, symlinkToDbTxt);
			await fs.symlink(journalPath, symlinkToJournalTxt);

			// B5 self-check before locking journalPath: unlocked file MUST report ACQUIRED.
			const unlockedJournalProbe = peerPosixWriteLockBlocked(journalPath);
			if (unlockedJournalProbe.blocked) {
				throw new Error(
					`POST-RAWIO-3b setup: expected unlocked journal file to report ACQUIRED (journal=${unlockedJournalProbe.detail})`,
				);
			}

			// Hold a real POSIX record write lock inside omp on journalPath
			// in addition to SQLite's WAL locks on dbPath and shmPath.
			journalLockFd = acquireInProcessPosixWriteLock(journalPath);

			const lockedDbProbe = peerWriteBlocked(dbPath);
			const lockedJournalProbe = peerPosixWriteLockBlocked(journalPath);
			if (!lockedDbProbe.blocked || !lockedJournalProbe.blocked) {
				throw new Error(
					`POST-RAWIO-3 / POST-RAWIO-3b setup: expected held locks to report LOCKED before tool execution (db=${lockedDbProbe.detail}, journal=${lockedJournalProbe.detail})`,
				);
			}

			// T1 & T2 (ReadTool): Read dbPath and symlinkToDbTxt (.txt alias to SQLite DB)
			const dbReadResult = await readTool.execute("call-read-db", { path: dbPath });
			const dbReadText = extractToolText(dbReadResult);
			if (!dbReadText.includes("items")) {
				throw new Error(
					`POST-RAWIO-3: expected ReadTool on ${dbPath} to list SQLite table 'items', got: ${dbReadText}`,
				);
			}

			// T2 ordering proof: symlinkToDbTxt has a .txt extension, so only out-of-process
			// classification before open prevents ReadTool from opening it in-process.
			const symlinkDbReadResult = await readTool.execute("call-read-symlink-db", { path: symlinkToDbTxt });
			const symlinkDbReadText = extractToolText(symlinkDbReadResult);
			if (!symlinkDbReadText.includes("items")) {
				throw new Error(
					[
						"1. WHAT: ReadTool out-of-process classification on .txt symlink to SQLite DB FAILED",
						"2. WHY: POST-RAWIO-3 violation - ReadTool did not classify the .txt symlink as sqlite_db before opening",
						"3. EXPECTED: SQLite table listing containing 'items'",
						`4. ACTUAL: ${JSON.stringify(symlinkDbReadText)}`,
						"5. GUIDANCE: ReadTool must classify every host file target via the Raw-I/O Helper before any in-process open and route sqlite_db targets through the SQLite reader or helper",
					].join("\n"),
				);
			}

			// Q-SLICE4-01 = B: Acquire the POSIX record lock on walPath after the .db SQLite
			// connection reads and before the raw helper read of walPath:raw (B9).
			const unlockedWalProbe = peerPosixWriteLockBlocked(walPath);
			if (unlockedWalProbe.blocked) {
				throw new Error(
					`POST-RAWIO-3 setup: expected unlocked walPath to report ACQUIRED (wal=${unlockedWalProbe.detail})`,
				);
			}
			walLockFd = acquireInProcessPosixWriteLock(walPath);
			const lockedWalProbe = peerPosixWriteLockBlocked(walPath);
			if (!lockedWalProbe.blocked) {
				throw new Error(
					`POST-RAWIO-3 setup: expected held walPath lock to report LOCKED (wal=${lockedWalProbe.detail})`,
				);
			}

			await readTool.execute("call-read-wal", { path: `${walPath}:raw` });
			await readTool.execute("call-read-shm", { path: `${shmPath}:raw` });
			const journalReadResult = await readTool.execute("call-read-journal-symlink", {
				path: symlinkToJournalTxt,
			});
			if (!extractToolText(journalReadResult).includes("initial-journal-line")) {
				throw new Error(
					`POST-RAWIO-3: expected ReadTool on ${symlinkToJournalTxt} to return sidecar text, got: ${extractToolText(journalReadResult)}`,
				);
			}

			const afterReadDbLock = peerWriteBlocked(dbPath);
			const afterReadWalLock = peerPosixWriteLockBlocked(walPath);
			const afterReadJournalLock = peerPosixWriteLockBlocked(journalPath);
			if (!afterReadDbLock.blocked || !afterReadWalLock.blocked || !afterReadJournalLock.blocked) {
				throw new Error(
					[
						"1. WHAT: ReadTool POSIX advisory lock retention on SQLite-Family targets FAILED",
						"2. WHY: POST-RAWIO-3 / FORBIDDEN-RAWIO-3 violation - ReadTool opened and closed a SQLite-Family target in-process, dropping omp's POSIX advisory lock",
						"3. EXPECTED: dbLock.blocked === true && walLock.blocked === true && journalLock.blocked === true",
						`4. ACTUAL: dbLock=${afterReadDbLock.detail}, walLock=${afterReadWalLock.detail}, journalLock=${afterReadJournalLock.detail}`,
						"5. GUIDANCE: ReadTool must classify targets out of process and never open or close a raw in-process descriptor on any SQLite-Family file",
					].join("\n"),
				);
			}

			// T1 & T2 (WriteTool): Write to symlinkToJournalTxt (.txt symlink resolving to test.db-journal)
			// while omp holds a POSIX fcntl lock on journalPath and BEGIN IMMEDIATE on dbPath.
			await writeTool.execute("call-write-journal-symlink", {
				path: symlinkToJournalTxt,
				content: "updated-journal-line\n",
			});
			const afterWriteDbLock = peerWriteBlocked(dbPath);
			const afterWriteJournalLock = peerPosixWriteLockBlocked(journalPath);
			const updatedJournalText = await fs.readFile(journalPath, "utf8");
			if (
				updatedJournalText !== "updated-journal-line\n" ||
				!afterWriteDbLock.blocked ||
				!afterWriteJournalLock.blocked
			) {
				throw new Error(
					[
						"1. WHAT: WriteTool POSIX advisory lock retention on SQLite-Family target FAILED",
						"2. WHY: POST-RAWIO-3b / FORBIDDEN-RAWIO-3 violation - WriteTool opened and closed the SQLite-Family target in-process, dropping omp's POSIX advisory lock",
						"3. EXPECTED: content='updated-journal-line\\n', dbLock.blocked=true, journalLock.blocked=true",
						`4. ACTUAL: content=${JSON.stringify(updatedJournalText)}, dbLock=${afterWriteDbLock.detail}, journalLock=${afterWriteJournalLock.detail}`,
						"5. GUIDANCE: WriteTool must classify targets out of process before any in-process open and access SQLite-Family files only through the Raw-I/O Helper or a SQLite connection",
					].join("\n"),
				);
			}
			// B4 positive control (POST-RAWIO-2b, POST-RAWIO-3, POST-RAWIO-3b):
			// Verify that the same session.rawIoHelperOptions.onRequest hook recorded
			// 'classify', 'read', and 'write' entries for the SQLite-Family sidecar
			// target, proving the hook is live for read/write operations.
			try {
				validateSqliteFamilyHelperLog(helperRequests, symlinkToJournalTxt, ["classify", "read", "write"]);
			} catch (validationErr) {
				throw new Error(
					[
						"1. WHAT: SQLite-Family helper request-log positive control FAILED",
						`2. WHY: POST-RAWIO-2b / POST-RAWIO-3 / POST-RAWIO-3b violation - ${validationErr instanceof Error ? validationErr.message : String(validationErr)}`,
						`3. EXPECTED: helperRequests contains 'classify', 'read', and 'write' for ${JSON.stringify(symlinkToJournalTxt)}`,
						`4. ACTUAL: ${JSON.stringify(helperRequests)}`,
						"5. GUIDANCE: ReadTool and WriteTool must forward session.rawIoHelperOptions on every helper request and invoke onRequest for classify, read, and write operations",
					].join("\n"),
				);
			}

			// T3 (POST-RAWIO-3c): Verify that a non_sqlite file (ordinary.txt) is read
			// and written on the in-process fast path so the same onRequest hook records
			// a 'classify' request and zero 'read' or 'write' byte requests for ordinary.txt.
			const ordinaryReadResult = await readTool.execute("call-read-ordinary", { path: ordinaryPath });
			const ordinaryReadText = extractToolText(ordinaryReadResult);
			await writeTool.execute("call-write-ordinary", {
				path: ordinaryPath,
				content: "ordinary line 2\n",
			});
			const ordinaryDiskContent = await fs.readFile(ordinaryPath, "utf8");
			if (!ordinaryReadText.includes("ordinary line 1") || ordinaryDiskContent !== "ordinary line 2\n") {
				throw new Error(
					[
						"1. WHAT: ReadTool/WriteTool content round-trip on non_sqlite file FAILED",
						"2. WHY: POST-RAWIO-3c violation - non_sqlite read or write returned unexpected content",
						"3. EXPECTED: read contains 'ordinary line 1' and write produces 'ordinary line 2\\n'",
						`4. ACTUAL: read=${JSON.stringify(ordinaryReadText)}, write=${JSON.stringify(ordinaryDiskContent)}`,
						"5. GUIDANCE: ReadTool and WriteTool must preserve normal in-process read/write content semantics for non_sqlite files",
					].join("\n"),
				);
			}
			try {
				validateNonSqliteHelperLog(helperRequests, ordinaryPath);
			} catch (validationErr) {
				throw new Error(
					[
						"1. WHAT: In-process fast path helper-request log check for non_sqlite file FAILED",
						`2. WHY: POST-RAWIO-3c violation - ${validationErr instanceof Error ? validationErr.message : String(validationErr)}`,
						`3. EXPECTED: helperRequests contains 'classify' and zero 'read' or 'write' entries for ${JSON.stringify(ordinaryPath)}`,
						`4. ACTUAL: ${JSON.stringify(helperRequests)}`,
						"5. GUIDANCE: Files classified as non_sqlite must remain on the in-process fast path without sending read or write byte requests to the Raw-I/O Helper",
					].join("\n"),
				);
			}

			const loaded = await tryLoadRawIoClient();
			const readBytesFn = loaded.module?.[RAW_IO_READ_BYTES_FN_NAME];
			const writeBytesFn = loaded.module?.[RAW_IO_WRITE_BYTES_FN_NAME];
			if (typeof readBytesFn !== "function" || typeof writeBytesFn !== "function") {
				throw new Error(
					[
						"1. WHAT: Raw-I/O Helper byte read/write client exports FAILED to load",
						"2. WHY: POST-RAWIO-2b violation - readRawIoBytes and/or writeRawIoBytes are missing from the client surface",
						`3. EXPECTED: typeof ${RAW_IO_READ_BYTES_FN_NAME} === 'function' && typeof ${RAW_IO_WRITE_BYTES_FN_NAME} === 'function'`,
						`4. ACTUAL: readRawIoBytes=${JSON.stringify(typeof readBytesFn)}, writeRawIoBytes=${JSON.stringify(typeof writeBytesFn)}`,
						"5. GUIDANCE: The contracted client surface must export readRawIoBytes and writeRawIoBytes for out-of-process SQLite-Family byte access",
					].join("\n"),
				);
			}
		} finally {
			if (journalLockFd !== null) {
				try {
					fsSync.closeSync(journalLockFd);
				} catch {}
			}
			if (walLockFd !== null) {
				try {
					fsSync.closeSync(walLockFd);
				} catch {}
			}
			try {
				db.run("ROLLBACK;");
			} catch {}
			db.close();
		}
	});
});
