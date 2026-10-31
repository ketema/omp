import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as workerSelectors from "@oh-my-pi/pi-coding-agent/cli/worker-selectors";
import {
	RAW_IO_CLASSIFY_FN_NAME,
	RAW_IO_CLIENT_MODULE,
	RAW_IO_HELPER_CONTRACT,
	RAW_IO_STOP_FN_NAME,
	RAW_IO_WORKER_ARG,
	RawIoClassificationMismatchError,
	RawIoInvalidTargetPathError,
	SQLITE_HEADER_MAGIC,
	SQLITE_SIDECAR_SUFFIXES,
	validateClassificationRecord,
	validateClassifyOptions,
	validateHelperFailureError,
	validateTargetPath,
} from "../../../../contracts/raw_io_helper.contract";
import type { ClassifyResolvedTargetInput, RawIoClassifyOptions } from "../../../../contracts/raw_io_helper.contract";

// =============================================================================
// CONTRACT VERIFICATION (supporting tests for pure contract validators, not RED)
// =============================================================================

describe("raw_io_helper.contract — contract validator verification (supporting, not RED)", () => {
	it("enforces PRE-RAWIO-1, POST-RAWIO-1, POST-RAWIO-2, ERRORS-RAWIO-1, and FORBIDDEN-RAWIO-2 on pure inputs", () => {
		expect(RAW_IO_HELPER_CONTRACT["PRE-RAWIO-1"].verification).toBe("test");
		expect(RAW_IO_HELPER_CONTRACT["POST-RAWIO-1b"].verification).toBe("test");
		expect(RAW_IO_HELPER_CONTRACT["POST-RAWIO-2"].verification).toBe("test");
		expect(validateTargetPath("/tmp/test.db")).toBe("/tmp/test.db");
		expect(() => validateTargetPath("relative/path.db")).toThrow(RawIoInvalidTargetPathError);
		expect(() => validateTargetPath("")).toThrow(RawIoInvalidTargetPathError);

		expect(validateClassifyOptions(undefined)).toEqual({});
		expect(validateClassifyOptions({ helperSpawnCommand: { cmd: ["/bin/true"] } })).toEqual({
			helperSpawnCommand: { cmd: ["/bin/true"] },
		});
		expect(() => validateClassifyOptions({ helperSpawnCommand: { cmd: [] } })).toThrow(
			RawIoClassificationMismatchError,
		);

		const dbRec = validateClassificationRecord({
			targetPath: "/tmp/a.bin",
			resolvedPath: "/tmp/a.bin",
			headerBytes: SQLITE_HEADER_MAGIC,
			helperPid: 99999,
			parentPid: 11111,
		});
		expect(dbRec.kind).toBe("sqlite_db");
		expect(dbRec.isSqliteFamily).toBe(true);

		for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
			const sidecarRec = validateClassificationRecord({
				targetPath: `/tmp/link${suffix}`,
				resolvedPath: `/tmp/real.db${suffix}`,
				headerBytes: new Uint8Array([1, 2, 3, 4]),
				helperPid: 99999,
				parentPid: 11111,
			});
			expect(sidecarRec.kind).toBe("sqlite_sidecar");
			expect(sidecarRec.isSqliteFamily).toBe(true);
		}

		expect(() =>
			validateClassificationRecord({
				targetPath: "/tmp/a.db",
				resolvedPath: "/tmp/a.db",
				headerBytes: SQLITE_HEADER_MAGIC,
				helperPid: 11111,
				parentPid: 11111,
			}),
		).toThrow(RawIoClassificationMismatchError);

		expect(() =>
			validateClassificationRecord({
				targetPath: "/tmp/a.db",
				resolvedPath: "/tmp/a.db",
				headerBytes: SQLITE_HEADER_MAGIC,
				helperPid: 99999,
				parentPid: 11111,
				entryKind: "fifo",
			}),
		).toThrow(RawIoClassificationMismatchError);

		expect(
			validateHelperFailureError("classifyTarget failed for /tmp/a.db", "classifyTarget", "/tmp/a.db"),
		).toContain("/tmp/a.db");
		expect(() => validateHelperFailureError("", "classifyTarget", "/tmp/a.db")).toThrow(
			RawIoClassificationMismatchError,
		);
	});
});

// =============================================================================
// RED PHASE — Implementation tests against contracted Raw-I/O Helper surface
// =============================================================================

interface RawIoClientModule {
	readonly classifyRawIoTarget?: (targetPath: string, options?: RawIoClassifyOptions) => Promise<unknown>;
	readonly stopRawIoHelper?: () => Promise<void>;
}

interface RawIoClientLoadResult {
	readonly module: RawIoClientModule | undefined;
	readonly loadError: string | undefined;
}

// Exception to ts-no-dynamic-import: RED test intentionally exercises module loading
// on the contracted client specifier before the module exists in GREEN, so tsc --noEmit
// passes while the RED test fails with its 5-point contract error message.
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
			helperPid: undefined,
			parentPid,
		};
	}
	const headerCandidate = Reflect.get(raw, "headerBytes");
	return {
		targetPath: Reflect.get(raw, "targetPath"),
		resolvedPath: Reflect.get(raw, "resolvedPath"),
		headerBytes: headerCandidate instanceof Uint8Array ? headerCandidate : undefined,
		helperPid: Reflect.get(raw, "helperPid"),
		parentPid,
		entryKind: Reflect.get(raw, "entryKind"),
	};
}

function peerWriteBlocked(dbPath: string): { readonly blocked: boolean; readonly detail: string } {
	const proc = Bun.spawnSync({
		cmd: [
			process.execPath,
			"-e",
			[
				'import { Database } from "bun:sqlite";',
				"const db = new Database(process.argv[1]);",
				"try {",
				'  db.run("PRAGMA busy_timeout = 0");',
				'  db.run("BEGIN IMMEDIATE");',
				'  db.run("ROLLBACK");',
				'  console.log("ACQUIRED");',
				"} catch (e) {",
				'  const code = e && typeof e === "object" && "code" in e ? String(e.code) : "";',
				"  const msg = e instanceof Error ? e.message : String(e);",
				'  console.log("ERROR:" + code + ":" + msg);',
				"} finally {",
				"  db.close();",
				"}",
			].join(" "),
			dbPath,
		],
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new TextDecoder().decode(proc.stdout).trim();
	const stderr = new TextDecoder().decode(proc.stderr).trim();
	if (proc.exitCode !== 0) {
		return { blocked: false, detail: `exit=${String(proc.exitCode)} stderr=${stderr}` };
	}
	const isBusyLock =
		stdout.startsWith("ERROR:") &&
		(stdout.includes("SQLITE_BUSY") || stdout.toLowerCase().includes("database is locked"));
	return { blocked: isBusyLock, detail: stdout };
}

describe("Raw-I/O Helper target classification and failure handling (SLICE-4 Batch 1 RED)", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-raw-io-red-"));
	});

	afterEach(async () => {
		const loaded = await tryLoadRawIoClient();
		const stopFn = loaded.module ? Reflect.get(loaded.module, RAW_IO_STOP_FN_NAME) : undefined;
		if (typeof stopFn === "function") {
			await stopFn();
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("classifies SQLite databases, resolved sidecars, and non-SQLite files in a real child OS process while preserving in-process WAL locks", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: contracts/raw_io_helper.contract.ts (RAW_IO_HELPER_CONTRACT)
		 * - Enforces: PRE-RAWIO-1, POST-RAWIO-1, POST-RAWIO-1b, POST-RAWIO-2, FORBIDDEN-RAWIO-1, FORBIDDEN-RAWIO-2, FORBIDDEN-RAWIO-2b
		 * - Category: integration (real OS child process + live WAL SQLite lock retention)
		 * - Risk tier: HIGH — guards the exact POSIX fcntl lock-loss mechanism (#15586)
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites PRE-RAWIO-1, POST-RAWIO-1, POST-RAWIO-1b, POST-RAWIO-2, FORBIDDEN-RAWIO-1, FORBIDDEN-RAWIO-2, FORBIDDEN-RAWIO-2b
		 *   [✓] C2 VALUABLE: an in-process classifier closes the descriptor on dbPath / -shm and drops the BEGIN IMMEDIATE lock so peerWriteBlocked.blocked becomes false; a fake PID fails kill(helperPid, 0)
		 *   [✓] C3 NON-DUPLICATIVE: sole test of out-of-process target classification and WAL lock retention on the Raw-I/O Helper client surface
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current SLICE-4 contracted helper behavior
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
		const classifyTarget = loaded.module
			? (Reflect.get(loaded.module, RAW_IO_CLASSIFY_FN_NAME) as
					| ((targetPath: string, options?: RawIoClassifyOptions) => Promise<unknown>)
					| undefined)
			: undefined;
		const stopHelper = loaded.module ? Reflect.get(loaded.module, RAW_IO_STOP_FN_NAME) : undefined;
		if (typeof classifyTarget !== "function" || typeof stopHelper !== "function") {
			throw new Error(
				[
					"1. WHAT: Raw-I/O Helper client surface availability check FAILED",
					"2. WHY: POST-RAWIO-2 violation - the contracted client entry points are unavailable",
					`3. EXPECTED: ${RAW_IO_CLASSIFY_FN_NAME} and ${RAW_IO_STOP_FN_NAME} are callable functions`,
					`4. ACTUAL: classify=${JSON.stringify(typeof classifyTarget)}, stop=${JSON.stringify(typeof stopHelper)}, loadError=${JSON.stringify(loaded.loadError)}`,
					"5. GUIDANCE: The contracted client surface must provide callable classification and helper-termination operations",
				].join("\n"),
			);
		}

		const dbPath = path.join(tempDir, "held.db");
		const shmPath = `${dbPath}-shm`;
		const walAliasPath = path.join(tempDir, "alias-to-wal.bin");
		const plainPath = path.join(tempDir, "plain.txt");
		await fs.writeFile(plainPath, "ordinary text content\n");

		const db = new Database(dbPath);
		try {
			db.run("PRAGMA journal_mode = WAL");
			db.run("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
			db.run("INSERT INTO items (name) VALUES ('alpha')");
			db.run("BEGIN IMMEDIATE");
			db.run("INSERT INTO items (name) VALUES ('beta')");

			await fs.symlink(`${dbPath}-wal`, walAliasPath);
			const initialLock = peerWriteBlocked(dbPath);
			expect(initialLock.blocked).toBe(true);

			// PRE-RAWIO-1: relative path must be rejected before any helper I/O
			let preRejected = false;
			try {
				await classifyTarget("relative/held.db");
			} catch (err) {
				preRejected = err instanceof Error && err.message.includes("PRE-RAWIO-1");
			}
			if (!preRejected) {
				throw new Error(
					[
						"1. WHAT: Relative-path precondition rejection FAILED",
						"2. WHY: PRE-RAWIO-1 violation - a non-absolute targetPath was not rejected with PRE-RAWIO-1",
						"3. EXPECTED: rejection citing PRE-RAWIO-1",
						`4. ACTUAL: preRejected=${String(preRejected)}`,
						"5. GUIDANCE: Reject any targetPath that is empty or not a POSIX absolute path starting with '/'",
					].join("\n"),
				);
			}

			const dbResult = validateClassificationRecord(
				toClassificationInput(await classifyTarget(dbPath), process.pid),
			);
			const shmResult = validateClassificationRecord(
				toClassificationInput(await classifyTarget(shmPath), process.pid),
			);
			const walAliasResult = validateClassificationRecord(
				toClassificationInput(await classifyTarget(walAliasPath), process.pid),
			);
			const plainResult = validateClassificationRecord(
				toClassificationInput(await classifyTarget(plainPath), process.pid),
			);

			// FORBIDDEN-RAWIO-2 (N2): verify helperPid is a real, live OS child process distinct from process.pid
			let helperAliveInOs = false;
			try {
				helperAliveInOs = process.kill(dbResult.helperPid, 0);
			} catch {
				helperAliveInOs = false;
			}
			if (!helperAliveInOs || dbResult.helperPid === process.pid) {
				throw new Error(
					[
						"1. WHAT: OS helper process liveness and PID separation check FAILED",
						"2. WHY: FORBIDDEN-RAWIO-2 violation - helperPid is not a live separate OS process",
						`3. EXPECTED: process.kill(helperPid, 0) === true and helperPid !== ${process.pid}`,
						`4. ACTUAL: helperPid=${dbResult.helperPid}, helperAliveInOs=${String(helperAliveInOs)}`,
						"5. GUIDANCE: Classification must execute in a separate live OS process whose PID differs from omp's PID",
					].join("\n"),
				);
			}

			if (
				dbResult.kind !== "sqlite_db" ||
				!dbResult.isSqliteFamily ||
				shmResult.kind !== "sqlite_sidecar" ||
				!shmResult.isSqliteFamily ||
				walAliasResult.kind !== "sqlite_sidecar" ||
				!walAliasResult.isSqliteFamily ||
				plainResult.kind !== "non_sqlite" ||
				plainResult.isSqliteFamily
			) {
				throw new Error(
					[
						"1. WHAT: Out-of-process target classification FAILED",
						"2. WHY: POST-RAWIO-1 violation - targets were not classified accurately by resolved suffix or 16-byte SQLite header",
						"3. EXPECTED: db=sqlite_db(true), shm=sqlite_sidecar(true), walAlias=sqlite_sidecar(true), plain=non_sqlite(false)",
						`4. ACTUAL: db=${dbResult.kind}(${String(dbResult.isSqliteFamily)}), shm=${shmResult.kind}(${String(shmResult.isSqliteFamily)}), walAlias=${walAliasResult.kind}(${String(walAliasResult.isSqliteFamily)}), plain=${plainResult.kind}(${String(plainResult.isSqliteFamily)})`,
						"5. GUIDANCE: Classify targets whose resolved real path ends in -wal/-shm/-journal as sqlite_sidecar, targets with a 16-byte SQLite header as sqlite_db, and ordinary files as non_sqlite",
					].join("\n"),
				);
			}

			// POST-RAWIO-1b / FORBIDDEN-RAWIO-2b: our held WAL transaction lock MUST still block a peer writer with SQLITE_BUSY
			const postLock = peerWriteBlocked(dbPath);
			if (!postLock.blocked) {
				throw new Error(
					[
						"1. WHAT: POSIX WAL lock retention across classification of db, -shm, and -wal alias FAILED",
						"2. WHY: POST-RAWIO-1b / FORBIDDEN-RAWIO-2b violation - classifying held.db and held.db-shm released this process's POSIX advisory locks",
						"3. EXPECTED: peer writer fails with SQLITE_BUSY / database is locked while BEGIN IMMEDIATE transaction is open",
						`4. ACTUAL: blocked=${String(postLock.blocked)} detail=${JSON.stringify(postLock.detail)}`,
						"5. GUIDANCE: Classification must not close any descriptor for the target inside omp or release omp's POSIX advisory locks",
					].join("\n"),
				);
			}
		} finally {
			try {
				db.run("ROLLBACK");
			} catch {}
			db.close();
		}
	});

	it("surfaces an error naming the operation and target path without falling back to an in-process open when the Raw-I/O Helper fails", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: contracts/raw_io_helper.contract.ts (RAW_IO_HELPER_CONTRACT)
		 * - Enforces: POST-RAWIO-2, ERRORS-RAWIO-1, FORBIDDEN-RAWIO-1b, POST-RAWIO-1b
		 * - Category: error / negative-space (no in-process fallback when helper cannot start or fails)
		 * - Risk tier: HIGH — silent fallback restores the #15586 lock-loss bug (CL9)
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-RAWIO-2, ERRORS-RAWIO-1, FORBIDDEN-RAWIO-1b, and POST-RAWIO-1b
		 *   [✓] C2 VALUABLE: an implementation that falls back to an in-process open either succeeds instead of throwing or drops the held WAL lock on shmPath
		 *   [✓] C3 NON-DUPLICATIVE: sole test of the helper-unavailable failure path and no-fallback guarantee
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contracted failure behavior (REQ-L15586-08, INV-L15586-03)
		 */
		const loaded = await tryLoadRawIoClient();
		const classifyTarget = loaded.module
			? (Reflect.get(loaded.module, RAW_IO_CLASSIFY_FN_NAME) as
					| ((targetPath: string, options?: RawIoClassifyOptions) => Promise<unknown>)
					| undefined)
			: undefined;
		if (typeof classifyTarget !== "function") {
			throw new Error(
				[
					"1. WHAT: Raw-I/O Helper client classification entry point check FAILED",
					"2. WHY: POST-RAWIO-2 / ERRORS-RAWIO-1 violation - the contracted classification entry point is unavailable",
					`3. EXPECTED: typeof ${RAW_IO_CLASSIFY_FN_NAME} === 'function'`,
					`4. ACTUAL: typeof=${JSON.stringify(typeof classifyTarget)}, loadError=${JSON.stringify(loaded.loadError)}`,
					"5. GUIDANCE: The contracted client surface must provide the classification entry point with failure propagation per ERRORS-RAWIO-1 and FORBIDDEN-RAWIO-1b",
				].join("\n"),
			);
		}

		const dbPath = path.join(tempDir, "nofallback.db");
		const shmPath = `${dbPath}-shm`;
		const db = new Database(dbPath);
		try {
			db.run("PRAGMA journal_mode = WAL");
			db.run("CREATE TABLE t (x INTEGER)");
			db.run("BEGIN IMMEDIATE");
			db.run("INSERT INTO t VALUES (1)");
			const initialLock = peerWriteBlocked(dbPath);
			expect(initialLock.blocked).toBe(true);

			const faultOptions = validateClassifyOptions({
				helperSpawnCommand: { cmd: [path.join(tempDir, "nonexistent-raw-io-helper-binary")] },
			});
			let caughtError: unknown;
			try {
				await classifyTarget(shmPath, faultOptions);
			} catch (err) {
				caughtError = err;
			}

			const message = caughtError instanceof Error ? caughtError.message : "";
			let validatedMessage = "";
			try {
				validatedMessage = validateHelperFailureError(message, "classify", shmPath);
			} catch {
				validatedMessage = "";
			}

			if (!validatedMessage) {
				throw new Error(
					[
						"1. WHAT: Raw-I/O Helper failure error propagation FAILED",
						"2. WHY: ERRORS-RAWIO-1 violation - helper failure did not surface an error naming the operation ('classify') and target path",
						`3. EXPECTED: Error message containing 'classify' and ${JSON.stringify(shmPath)}`,
						`4. ACTUAL: ${JSON.stringify(message)}`,
						"5. GUIDANCE: When the Raw-I/O Helper cannot start, crashes, or fails, reject with an error naming both the failed operation and the target path",
					].join("\n"),
				);
			}

			const postFailureLock = peerWriteBlocked(dbPath);
			if (!postFailureLock.blocked) {
				throw new Error(
					[
						"1. WHAT: No-in-process-fallback guarantee on helper failure FAILED",
						"2. WHY: FORBIDDEN-RAWIO-1b / POST-RAWIO-1b violation - held WAL lock was lost after helper failure, indicating an in-process open occurred",
						"3. EXPECTED: peer writer fails with SQLITE_BUSY / database is locked after helper failure",
						`4. ACTUAL: blocked=${String(postFailureLock.blocked)} detail=${JSON.stringify(postFailureLock.detail)}`,
						"5. GUIDANCE: Never fall back to an in-process open when the Raw-I/O Helper is unavailable or fails, and retain all held POSIX locks",
					].join("\n"),
				);
			}
		} finally {
			try {
				db.run("ROLLBACK");
			} catch {}
			db.close();
		}
	});
});
