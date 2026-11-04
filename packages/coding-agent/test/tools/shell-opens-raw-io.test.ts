import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InternalUrlFilesystem } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import { executeShell, type ShellExecuteOptions } from "@oh-my-pi/pi-natives";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { RAW_IO_HELPER_CONTRACT } from "../../../../contracts/raw_io_helper.contract";
import { acquireInProcessPosixWriteLock, peerPosixWriteLockBlocked } from "../utils/posix-lock-probe";

async function runShell(options: ShellExecuteOptions): Promise<{ exitCode: number | undefined; output: string }> {
	let output = "";
	const result = await executeShell(options, (_err, chunk) => {
		if (chunk) output += chunk;
	});
	return { exitCode: result.exitCode, output };
}

describe("SLICE-6 (POST-RAWIO-5): embedded-shell redirects and builtin host-file opens run in child process", () => {
	let tempDir = "";
	const heldLockFds: number[] = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-slice6-shell-opens-"));
	});

	afterEach(async () => {
		for (const fd of heldLockFds.splice(0)) {
			try {
				fsSync.closeSync(fd);
			} catch {}
		}
		if (tempDir) {
			await removeWithRetries(tempDir);
		}
	});

	it("declares POST-RAWIO-5 in the domain contract", () => {
		expect(RAW_IO_HELPER_CONTRACT["POST-RAWIO-5"].verification).toBe("test");
		expect(RAW_IO_HELPER_CONTRACT["POST-RAWIO-5"].text).toContain("Shell::open_file");
	});

	it("POST-RAWIO-5: embedded-shell redirects (: <, wc -c <, >>) and builtin opens (head, wc) retain in-process POSIX locks", async () => {
		const dbPath = path.join(tempDir, "agent.db");
		const shmPath = path.join(tempDir, "agent.db-shm");
		const outPath = path.join(tempDir, "locked-out.txt");
		await fs.writeFile(dbPath, "SQLite format 3\0payload-bytes-for-db\n", "utf8");
		await fs.writeFile(shmPath, "shm-header-and-lock-table-bytes-32\n", "utf8");
		await fs.writeFile(outPath, "initial\n", "utf8");

		heldLockFds.push(acquireInProcessPosixWriteLock(dbPath));
		heldLockFds.push(acquireInProcessPosixWriteLock(shmPath));
		heldLockFds.push(acquireInProcessPosixWriteLock(outPath));
		expect(peerPosixWriteLockBlocked(dbPath).blocked).toBe(true);
		expect(peerPosixWriteLockBlocked(shmPath).blocked).toBe(true);
		expect(peerPosixWriteLockBlocked(outPath).blocked).toBe(true);

		const urlFs = new InternalUrlFilesystem({ context: { cwd: tempDir }, tier: "exec" });
		const command = [
			`: < '${shmPath}'`,
			`head -c 15 '${dbPath}'`,
			`wc -c '${shmPath}'`,
			`/usr/bin/wc -c < '${shmPath}'`,
			`echo appended >> '${outPath}'`,
		].join(" && ");

		const result = await runShell({
			command,
			cwd: tempDir,
			timeoutMs: 15000,
			filesystem: urlFs.shellFilesystem(),
		});
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("SQLite format 3");
		const dbStillLocked = peerPosixWriteLockBlocked(dbPath);
		const shmStillLocked = peerPosixWriteLockBlocked(shmPath);
		const outStillLocked = peerPosixWriteLockBlocked(outPath);
		expect(await fs.readFile(outPath, "utf8")).toBe("initial\nappended\n");

		expect(
			{
				dbStillLocked: dbStillLocked.blocked,
				shmStillLocked: shmStillLocked.blocked,
				outStillLocked: outStillLocked.blocked,
			},
			[
				"1. WHAT: POST-RAWIO-5 embedded-shell redirect and builtin open POSIX lock retention FAILED",
				"2. WHY: In-process std::fs::File::open in pi-vfs Route::Native opens and closes a descriptor in omp, releasing POSIX advisory locks",
				"3. EXPECTED: dbStillLocked=true, shmStillLocked=true, outStillLocked=true",
				`4. ACTUAL: db=${String(dbStillLocked.blocked)} shm=${String(shmStillLocked.blocked)} out=${String(outStillLocked.blocked)}`,
				"5. GUIDANCE: Route pi-vfs Route::Native file opens/reads/writes through the Raw-I/O Helper child process",
			].join("\n"),
		).toEqual({
			dbStillLocked: true,
			shmStillLocked: true,
			outStillLocked: true,
		});
	});

	it("POST-RAWIO-5: external-command input and output redirects larger than the OS pipe buffer (512 KiB) stream without deadlock and retain locks", async () => {
		const bigInPath = path.join(tempDir, "big-in.bin");
		const bigOutPath = path.join(tempDir, "big-out.bin");
		const payload = "A".repeat(512 * 1024);
		await fs.writeFile(bigInPath, payload, "utf8");
		await fs.writeFile(bigOutPath, "", "utf8");

		heldLockFds.push(acquireInProcessPosixWriteLock(bigInPath));
		heldLockFds.push(acquireInProcessPosixWriteLock(bigOutPath));

		const urlFs = new InternalUrlFilesystem({ context: { cwd: tempDir }, tier: "exec" });
		const result = await runShell({
			command: `/usr/bin/wc -c < '${bigInPath}' && /bin/cat < '${bigInPath}' > '${bigOutPath}' && /bin/cat < '${bigInPath}' >> '${bigOutPath}'`,
			cwd: tempDir,
			timeoutMs: 20000,
			filesystem: urlFs.shellFilesystem(),
		});
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain(String(512 * 1024));
		const stat = await fs.stat(bigOutPath);
		expect(stat.size).toBe(1024 * 1024);
		expect(peerPosixWriteLockBlocked(bigInPath).blocked).toBe(true);
		expect(peerPosixWriteLockBlocked(bigOutPath).blocked).toBe(true);
	});

	it("POST-RAWIO-5 / ERRORS-RAWIO-1b / FORBIDDEN-RAWIO-1b: fault-injection seam (OMP_RAW_IO_VFS_HELPER_FAULT) fails without binary override, surfaces mid-redirect helper death, joins exec pumps, and does not hang on redirect cancellation", async () => {
		const targetPath = path.join(tempDir, "no-fallback.db");
		const bigPath = path.join(tempDir, "mid-redirect.bin");
		const execOutPath = path.join(tempDir, "exec-out.txt");
		const cancelOutPath = path.join(tempDir, "cancel-out.txt");
		await fs.writeFile(targetPath, "SQLite format 3\0must-not-open-in-process\n", "utf8");
		await fs.writeFile(bigPath, "B".repeat(256 * 1024), "utf8");
		await fs.writeFile(execOutPath, "", "utf8");
		await fs.writeFile(cancelOutPath, "", "utf8");

		heldLockFds.push(acquireInProcessPosixWriteLock(targetPath));
		heldLockFds.push(acquireInProcessPosixWriteLock(bigPath));
		heldLockFds.push(acquireInProcessPosixWriteLock(execOutPath));
		heldLockFds.push(acquireInProcessPosixWriteLock(cancelOutPath));

		const inlineScript = [
			'import { executeShell } from "@oh-my-pi/pi-natives";',
			"const target = process.env.OMP_SLICE6_TARGET ?? '';",
			"const cmd = process.env.OMP_SLICE6_CMD ?? `: < '${target}'`;",
			"let output = '';",
			"const res = await executeShell({ command: cmd, cwd: process.cwd(), timeoutMs: 5000 }, (_e, chunk) => { if (chunk) output += chunk; });",
			"console.log(JSON.stringify({ exitCode: res.exitCode, output }));",
		].join("\n");

		// (1a) OMP_RAW_IO_VFS_HELPER_CMD cannot hijack the helper binary: setting it to a
		// nonexistent binary is ignored because the helper always launches from current_exe().
		const ignoredCmdProc = Bun.spawnSync({
			cmd: [process.execPath, "-e", inlineScript],
			cwd: path.resolve(import.meta.dir, "../.."),
			env: {
				...process.env,
				OMP_RAW_IO_VFS_HELPER_CMD: "/nonexistent/omp-raw-io-vfs-helper-binary",
				OMP_SLICE6_TARGET: targetPath,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const ignoredCmdOut = JSON.parse(new TextDecoder().decode(ignoredCmdProc.stdout).trim()) as {
			exitCode: number;
			output: string;
		};
		expect(ignoredCmdOut.exitCode).toBe(0);
		expect(peerPosixWriteLockBlocked(targetPath).blocked).toBe(true);

		// (1b) Fault-injection seam OMP_RAW_IO_VFS_HELPER_FAULT=spawn_fail fails open naming op+path.
		const spawnFailProc = Bun.spawnSync({
			cmd: [process.execPath, "-e", inlineScript],
			cwd: path.resolve(import.meta.dir, "../.."),
			env: {
				...process.env,
				OMP_RAW_IO_VFS_HELPER_FAULT: "spawn_fail",
				OMP_SLICE6_TARGET: targetPath,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const spawnFailOut = JSON.parse(new TextDecoder().decode(spawnFailProc.stdout).trim()) as {
			exitCode: number;
			output: string;
		};
		expect(spawnFailOut.exitCode).not.toBe(0);
		expect(spawnFailOut.output).toContain("open");
		expect(spawnFailOut.output).toContain(targetPath);
		expect(peerPosixWriteLockBlocked(targetPath).blocked).toBe(true);

		// (2) Helper dies mid-redirect (OMP_RAW_IO_VFS_HELPER_FAULT=fail_after_ops:2): pump surfaces
		// the error on stderr with op+path and fails the command with non-zero exitCode.
		const midStreamProc = Bun.spawnSync({
			cmd: [process.execPath, "-e", inlineScript],
			cwd: path.resolve(import.meta.dir, "../.."),
			env: {
				...process.env,
				OMP_RAW_IO_VFS_HELPER_FAULT: "fail_after_ops:2",
				OMP_SLICE6_TARGET: bigPath,
				OMP_SLICE6_CMD: `/usr/bin/wc -c < '${bigPath}'`,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const midStreamOut = JSON.parse(new TextDecoder().decode(midStreamProc.stdout).trim()) as {
			exitCode: number;
			output: string;
		};
		expect(midStreamOut.exitCode).not.toBe(0);
		expect(midStreamOut.output).toContain("read");
		expect(midStreamOut.output).toContain(bigPath);
		expect(peerPosixWriteLockBlocked(bigPath).blocked).toBe(true);

		// (3) Subshell `exec -a` with VFS redirects joins its pumps and retains locks.
		const urlFs = new InternalUrlFilesystem({ context: { cwd: tempDir }, tier: "exec" });
		const execRes = await runShell({
			command: `(exec -a custom_cat /bin/cat < '${targetPath}' > '${execOutPath}')`,
			cwd: tempDir,
			timeoutMs: 10000,
			filesystem: urlFs.shellFilesystem(),
		});
		expect(execRes.exitCode).toBe(0);
		expect(peerPosixWriteLockBlocked(targetPath).blocked).toBe(true);
		expect(peerPosixWriteLockBlocked(execOutPath).blocked).toBe(true);
		expect(await fs.readFile(execOutPath, "utf8")).toBe("SQLite format 3\0must-not-open-in-process\n");

		// (4) Cancelling/timing out a command with a stdout redirect does not hang join_io_pumps.
		const startMs = Date.now();
		const cancelRes = await executeShell({
			command: `/bin/sh -c 'echo before-timeout; sleep 10' > '${cancelOutPath}'`,
			cwd: tempDir,
			timeoutMs: 150,
			filesystem: urlFs.shellFilesystem(),
		});
		const elapsedMs = Date.now() - startMs;
		expect(cancelRes.timedOut).toBe(true);
		expect(elapsedMs).toBeLessThan(3500);
		expect(peerPosixWriteLockBlocked(cancelOutPath).blocked).toBe(true);
	});
});
