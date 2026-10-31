import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as workerSelectors from "@oh-my-pi/pi-coding-agent/cli/worker-selectors";
import {
	RAW_IO_HELPER_CONTRACT,
	RAW_IO_WORKER_ARG,
	RawIoClassificationMismatchError,
	RawIoInvalidTargetPathError,
	SQLITE_HEADER_MAGIC,
	SQLITE_SIDECAR_SUFFIXES,
	validateClassificationRecord,
	validateHelperFailureError,
	validateTargetPath,
} from "../../../../contracts/raw_io_helper.contract";
import type { ClassifyResolvedTargetInput } from "../../../../contracts/raw_io_helper.contract";

// =============================================================================
// CONTRACT VERIFICATION (supporting tests for pure contract validators, not RED)
// =============================================================================

describe("raw_io_helper.contract — contract validator verification (supporting, not RED)", () => {
	it("enforces PRE-RAWIO-1, POST-RAWIO-1, ERRORS-RAWIO-1, and FORBIDDEN-RAWIO-2 on pure inputs", () => {
		expect(RAW_IO_HELPER_CONTRACT["PRE-RAWIO-1"].verification).toBe("test");
		expect(validateTargetPath("/tmp/test.db")).toBe("/tmp/test.db");
		expect(() => validateTargetPath("relative/path.db")).toThrow(RawIoInvalidTargetPathError);
		expect(() => validateTargetPath("")).toThrow(RawIoInvalidTargetPathError);

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
// RED PHASE — Implementation tests against @oh-my-pi/pi-coding-agent/tools/raw-io-client
// =============================================================================

interface RawIoClientModule {
	readonly classifyRawIoTarget?: (
		targetPath: string,
		options?: { readonly helperSpawnCommand?: { readonly cmd: readonly string[] } },
	) => Promise<unknown>;
	readonly stopRawIoHelper?: () => Promise<void>;
}

const RAW_IO_CLIENT_SPECIFIER = "@oh-my-pi/pi-coding-agent/tools/raw-io-client";

// Exception to ts-no-dynamic-import: RED test intentionally exercises module loading
// before @oh-my-pi/pi-coding-agent/tools/raw-io-client exists in GREEN, so tsc --noEmit
// passes while the RED test fails with its 5-point contract error message.
async function tryLoadRawIoClient(): Promise<RawIoClientModule | undefined> {
	try {
		const mod: unknown = await import(RAW_IO_CLIENT_SPECIFIER);
		if (typeof mod === "object" && mod !== null) {
			return mod;
		}
		return undefined;
	} catch {
		return undefined;
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

function peerWriteBlocked(dbPath: string): boolean {
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
				'  console.log("LOCKED:" + (e instanceof Error ? e.message : String(e)));',
				"} finally {",
				"  db.close();",
				"}",
			].join(" "),
			dbPath,
		],
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = new TextDecoder().decode(proc.stdout).trim();
	return out.startsWith("LOCKED:");
}

describe("Raw-I/O Helper target classification and failure handling (SLICE-4 Batch 1 RED)", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-raw-io-red-"));
	});

	afterEach(async () => {
		const client = await tryLoadRawIoClient();
		if (client && typeof client.stopRawIoHelper === "function") {
			await client.stopRawIoHelper();
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("classifies SQLite databases, resolved sidecars, and non-SQLite files in a real child OS process while preserving in-process WAL locks", async () => {
		/**
		 * CONTRACT TRACEABILITY:
		 * - Contract: contracts/raw_io_helper.contract.ts (RAW_IO_HELPER_CONTRACT)
		 * - Enforces: PRE-RAWIO-1, POST-RAWIO-1, FORBIDDEN-RAWIO-1, FORBIDDEN-RAWIO-2, FORBIDDEN-RAWIO-2b
		 * - Category: integration (real OS child process + live WAL SQLite lock retention)
		 * - Risk tier: HIGH — guards the exact POSIX fcntl lock-loss mechanism (#15586)
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites PRE-RAWIO-1, POST-RAWIO-1, FORBIDDEN-RAWIO-1, FORBIDDEN-RAWIO-2, FORBIDDEN-RAWIO-2b
		 *   [✓] C2 VALUABLE: an in-process classifier closes the descriptor on dbPath / -shm and drops the BEGIN IMMEDIATE lock so peerWriteBlocked becomes false; a fake PID fails kill(helperPid, 0)
		 *   [✓] C3 NON-DUPLICATIVE: sole test of out-of-process target classification and WAL lock retention on the Raw-I/O Helper client surface
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current SLICE-4 contracted helper behavior
		 */
		const workerSelector = Reflect.get(workerSelectors, "RAW_IO_WORKER_ARG");
		if (workerSelector !== RAW_IO_WORKER_ARG) {
			throw new Error(
				[
					"1. WHAT: Raw-I/O Helper worker-selector constant alignment FAILED",
					"2. WHY: POST-RAWIO-1 violation - RAW_IO_WORKER_ARG in worker-selectors does not match the contract constant",
					`3. EXPECTED: RAW_IO_WORKER_ARG === ${JSON.stringify(RAW_IO_WORKER_ARG)}`,
					`4. ACTUAL: RAW_IO_WORKER_ARG === ${JSON.stringify(workerSelector)}`,
					"5. GUIDANCE: Export RAW_IO_WORKER_ARG matching the contract selector in cli/worker-selectors and re-declare it in raw-io-client",
				].join("\n"),
			);
		}

		const client = await tryLoadRawIoClient();
		const classifyTarget = client?.classifyRawIoTarget;
		if (typeof classifyTarget !== "function") {
			throw new Error(
				[
					"1. WHAT: classifyRawIoTarget export check FAILED",
					"2. WHY: POST-RAWIO-1 violation - classifyRawIoTarget is not exported by tools/raw-io-client",
					"3. EXPECTED: typeof classifyRawIoTarget === 'function'",
					`4. ACTUAL: typeof classifyRawIoTarget === ${JSON.stringify(typeof classifyTarget)}`,
					"5. GUIDANCE: Export classifyRawIoTarget(targetPath) to classify host file targets via the Raw-I/O Helper process",
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
			expect(peerWriteBlocked(dbPath)).toBe(true);

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
						"1. WHAT: classifyRawIoTarget relative-path rejection FAILED",
						"2. WHY: PRE-RAWIO-1 violation - non-absolute targetPath was not rejected with PRE-RAWIO-1",
						"3. EXPECTED: rejection citing PRE-RAWIO-1",
						`4. ACTUAL: preRejected=${String(preRejected)}`,
						"5. GUIDANCE: Validate that targetPath is a non-empty POSIX absolute path starting with '/' before sending to the helper",
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
						"5. GUIDANCE: Spawn the Raw-I/O Helper as a separate OS child process and report its real OS process.pid",
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
						"5. GUIDANCE: Resolve realpath in the helper; classify -wal/-shm/-journal suffixes as sqlite_sidecar and 'SQLite format 3\\0' headers as sqlite_db",
					].join("\n"),
				);
			}

			// INV-L15586-01 / POST-RAWIO-1 / FORBIDDEN-RAWIO-2b: our held WAL transaction lock MUST still block a peer writer
			if (!peerWriteBlocked(dbPath)) {
				throw new Error(
					[
						"1. WHAT: POSIX WAL lock retention across classification of db, -shm, and -wal alias FAILED",
						"2. WHY: POST-RAWIO-1 / FORBIDDEN-RAWIO-2b violation - classifying held.db and held.db-shm released this process's POSIX advisory locks",
						"3. EXPECTED: peerWriteBlocked(dbPath) === true while BEGIN IMMEDIATE transaction is open",
						"4. ACTUAL: peerWriteBlocked(dbPath) === false (peer acquired BEGIN IMMEDIATE lock)",
						"5. GUIDANCE: Perform all file opens, reads, and closes inside the separate Raw-I/O Helper OS process without opening or closing descriptors in omp",
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
		 * - Enforces: ERRORS-RAWIO-1, FORBIDDEN-RAWIO-1b
		 * - Category: error / negative-space (no in-process fallback when helper cannot start or fails)
		 * - Risk tier: HIGH — silent fallback restores the #15586 lock-loss bug (CL9)
		 * - Adversarial: Contract-governed, implementation-aware
		 *
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites ERRORS-RAWIO-1 and FORBIDDEN-RAWIO-1b
		 *   [✓] C2 VALUABLE: an implementation that falls back to an in-process open either succeeds instead of throwing or drops the held WAL lock on shmPath
		 *   [✓] C3 NON-DUPLICATIVE: sole test of the helper-unavailable failure path and no-fallback guarantee
		 *   [✓] C4 NOT FUTURE-EDIT: enforces current contracted failure behavior (REQ-L15586-08, INV-L15586-03)
		 */
		const client = await tryLoadRawIoClient();
		const classifyTarget = client?.classifyRawIoTarget;
		if (typeof classifyTarget !== "function") {
			throw new Error(
				[
					"1. WHAT: classifyRawIoTarget export check FAILED",
					"2. WHY: ERRORS-RAWIO-1 violation - classifyRawIoTarget is not exported by tools/raw-io-client",
					"3. EXPECTED: typeof classifyRawIoTarget === 'function'",
					`4. ACTUAL: typeof classifyRawIoTarget === ${JSON.stringify(typeof classifyTarget)}`,
					"5. GUIDANCE: Export classifyRawIoTarget with helper failure handling per ERRORS-RAWIO-1 and FORBIDDEN-RAWIO-1b",
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
			expect(peerWriteBlocked(dbPath)).toBe(true);

			let caughtError: unknown;
			try {
				await classifyTarget(shmPath, {
					helperSpawnCommand: { cmd: [path.join(tempDir, "nonexistent-raw-io-helper-binary")] },
				});
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
						"5. GUIDANCE: When the Raw-I/O Helper cannot start, crashes, or fails, reject with an error naming both the operation and target path",
					].join("\n"),
				);
			}

			if (!peerWriteBlocked(dbPath)) {
				throw new Error(
					[
						"1. WHAT: No-in-process-fallback guarantee on helper failure FAILED",
						"2. WHY: FORBIDDEN-RAWIO-1b violation - held WAL lock was lost after helper failure, indicating an in-process open occurred",
						"3. EXPECTED: peerWriteBlocked(dbPath) === true after helper failure",
						"4. ACTUAL: peerWriteBlocked(dbPath) === false",
						"5. GUIDANCE: Never fall back to opening the target in-process when the Raw-I/O Helper is unavailable or fails",
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
