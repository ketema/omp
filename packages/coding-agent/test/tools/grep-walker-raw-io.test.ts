import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { type RawIoHelperRequestEntry, stopRawIoHelper } from "@oh-my-pi/pi-coding-agent/tools/raw-io-client";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { RAW_IO_HELPER_CONTRACT } from "../../../../contracts/raw_io_helper.contract";
import { acquireInProcessPosixWriteLock, peerPosixWriteLockBlocked } from "../utils/posix-lock-probe";

describe("SLICE-3 (POST-RAWIO-6): native Rust grep, pi-walker ignore-file reads, and GrepTool snapshot tags via Raw-I/O Helper", () => {
	let tempDir = "";
	const heldLockFds: number[] = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-slice3-grep-walker-"));
	});

	afterEach(async () => {
		await stopRawIoHelper();
		for (const fd of heldLockFds.splice(0)) {
			try {
				fsSync.closeSync(fd);
			} catch {
				// Best-effort cleanup.
			}
		}
		if (tempDir) {
			await removeWithRetries(tempDir);
		}
	});

	it("declares POST-RAWIO-6 in the domain contract", () => {
		expect(RAW_IO_HELPER_CONTRACT["POST-RAWIO-6"].verification).toBe("test");
		expect(RAW_IO_HELPER_CONTRACT["POST-RAWIO-6"].text).toContain("pi-walker");
	});

	it("POST-RAWIO-6: native grep, pi-walker ignore-file reads (.gitignore, .ignore), and GrepTool.execute retain in-process POSIX locks", async () => {
		const gitignorePath = path.join(tempDir, ".gitignore");
		const ignorePath = path.join(tempDir, ".ignore");
		const dbPath = path.join(tempDir, "agent.db");
		const shmPath = path.join(tempDir, "agent.db-shm");

		await fs.writeFile(gitignorePath, "*.ignored-by-git\n", "utf8");
		await fs.writeFile(ignorePath, "*.ignored-by-rg\n", "utf8");
		await fs.writeFile(dbPath, "SQLite format 3\0database-header-payload\n", "utf8");
		await fs.writeFile(shmPath, "shm-lock-table-needle-in-shm\n", "utf8");

		heldLockFds.push(acquireInProcessPosixWriteLock(gitignorePath));
		heldLockFds.push(acquireInProcessPosixWriteLock(ignorePath));
		heldLockFds.push(acquireInProcessPosixWriteLock(dbPath));
		heldLockFds.push(acquireInProcessPosixWriteLock(shmPath));

		const requests: RawIoHelperRequestEntry[] = [];
		const tool = new GrepTool({
			cwd: tempDir,
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			rawIoHelperOptions: {
				onRequest: entry => {
					requests.push(entry);
				},
			},
		});

		const res = await tool.execute("call-slice3-1", {
			pattern: "needle-in-shm",
			path: tempDir,
		});
		const text = res.content.map(part => ("text" in part ? part.text : "")).join("\n");
		expect(text).toContain("needle-in-shm");

		const gitignoreLocked = peerPosixWriteLockBlocked(gitignorePath);
		const ignoreLocked = peerPosixWriteLockBlocked(ignorePath);
		const dbLocked = peerPosixWriteLockBlocked(dbPath);
		const shmLocked = peerPosixWriteLockBlocked(shmPath);
		const readTargets = requests.filter(r => r.operation === "read").map(r => r.targetPath);

		expect(
			{
				gitignoreLocked: gitignoreLocked.blocked,
				ignoreLocked: ignoreLocked.blocked,
				dbLocked: dbLocked.blocked,
				shmLocked: shmLocked.blocked,
				recordedShmSnapshotRead: readTargets.includes(shmPath),
			},
			[
				"1. WHAT: POST-RAWIO-6 grep/walker/GrepTool POSIX lock retention FAILED",
				"2. WHY: GrepTool recordSnapshotTags called in-process EditStore.recordSnapshotFile instead of readRawIoBytes + recordSnapshot",
				`3. EXPECTED: all 4 locks true and readTargets includes ${shmPath}`,
				`4. ACTUAL: gitignore=${String(gitignoreLocked.blocked)} ignore=${String(ignoreLocked.blocked)} db=${String(dbLocked.blocked)} shm=${String(shmLocked.blocked)} readTargets=${JSON.stringify(readTargets)}`,
				"5. GUIDANCE: Route recordSnapshotTags in packages/coding-agent/src/tools/grep.ts through readRawIoBytes and EditStore.recordSnapshot",
			].join("\n"),
		).toEqual({
			gitignoreLocked: true,
			ignoreLocked: true,
			dbLocked: true,
			shmLocked: true,
			recordedShmSnapshotRead: true,
		});
	});

	it("POST-RAWIO-6 / ERRORS-RAWIO-1b / FORBIDDEN-RAWIO-1b: when Raw-I/O Helper fails during GrepTool or native grep/walker, it fails naming operation and path without in-process fallback", async () => {
		const shmPath = path.join(tempDir, "no-fallback-shm.db-shm");
		await fs.writeFile(shmPath, "shm-lock-table-needle-in-shm\n", "utf8");
		heldLockFds.push(acquireInProcessPosixWriteLock(shmPath));

		const tool = new GrepTool({
			cwd: tempDir,
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			rawIoHelperOptions: {
				helperSpawnCommand: { cmd: [process.execPath, "-e", "process.exit(2)"] },
				timeoutMs: 1500,
			},
		});

		let caught: unknown;
		try {
			await tool.execute("call-slice3-fail", {
				pattern: "needle-in-shm",
				path: shmPath,
			});
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		const errMessage = caught instanceof Error ? caught.message : String(caught);
		expect(errMessage).toContain("read");
		expect(errMessage).toContain(shmPath);
		expect(peerPosixWriteLockBlocked(shmPath).blocked).toBe(true);

		const inlineScript = [
			'import { grep } from "@oh-my-pi/pi-natives";',
			"const target = process.env.OMP_SLICE3_TARGET ?? '';",
			"try {",
			"  await grep({ pattern: 'needle', path: target });",
			"  console.log(JSON.stringify({ ok: true, error: '' }));",
			"} catch (err) {",
			"  console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));",
			"}",
		].join("\n");

		const proc = Bun.spawnSync({
			cmd: [process.execPath, "-e", inlineScript],
			cwd: path.resolve(import.meta.dir, "../.."),
			env: {
				...process.env,
				OMP_RAW_IO_VFS_HELPER_CMD: "/nonexistent/omp-raw-io-vfs-helper-binary",
				OMP_SLICE3_TARGET: shmPath,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = new TextDecoder().decode(proc.stdout).trim();
		const parsed = stdout ? (JSON.parse(stdout) as { ok: boolean; error: string }) : { ok: true, error: "" };
		expect(parsed.ok).toBe(false);
		expect(parsed.error).toContain("open");
		expect(parsed.error).toContain(shmPath);
		expect(peerPosixWriteLockBlocked(shmPath).blocked).toBe(true);
	});
});
