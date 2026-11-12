import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { sessionResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls/context";
import { InternalUrlFilesystem, UrlFsError } from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { readText } from "@oh-my-pi/pi-coding-agent/tools/jfind/text";
import {
	type RawIoClassifyOptions,
	type RawIoHelperRequestEntry,
	stopRawIoHelper,
} from "@oh-my-pi/pi-coding-agent/tools/raw-io-client";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { RAW_IO_HELPER_CONTRACT } from "../../../../contracts/raw_io_helper.contract";
import { acquireInProcessPosixWriteLock, peerPosixWriteLockBlocked } from "../utils/posix-lock-probe";

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

describe("SLICE-5 (POST-RAWIO-4): InternalUrlFilesystem.readPrefix routes host files through Raw-I/O Helper", () => {
	let tempDir = "";
	const heldLockFds: number[] = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-slice5-read-prefix-"));
	});

	afterEach(async () => {
		for (const fd of heldLockFds.splice(0)) {
			try {
				fsSync.closeSync(fd);
			} catch {}
		}
		await stopRawIoHelper();
		if (tempDir) {
			await removeWithRetries(tempDir);
		}
	});

	it("declares POST-RAWIO-4 in the domain contract", () => {
		expect(RAW_IO_HELPER_CONTRACT["POST-RAWIO-4"].verification).toBe("test");
		expect(RAW_IO_HELPER_CONTRACT["POST-RAWIO-4"].text).toContain("InternalUrlFilesystem.readPrefix");
	});

	it("POST-RAWIO-4: readPrefix and jfind readText read host files through the Raw-I/O Helper and retain in-process POSIX locks", async () => {
		const targetPath = path.join(tempDir, "locked-target.txt");
		const shmSidecarPath = path.join(tempDir, "agent.db-shm");
		await fs.writeFile(targetPath, "first line of locked target\nsecond line\n", "utf8");
		await fs.writeFile(shmSidecarPath, "shm-header-text\nsecond line\n", "utf8");

		heldLockFds.push(acquireInProcessPosixWriteLock(targetPath));
		heldLockFds.push(acquireInProcessPosixWriteLock(shmSidecarPath));
		expect(peerPosixWriteLockBlocked(targetPath).blocked).toBe(true);
		expect(peerPosixWriteLockBlocked(shmSidecarPath).blocked).toBe(true);

		const requests: RawIoHelperRequestEntry[] = [];
		const session = createTestToolSession(tempDir, {
			onRequest: req => {
				requests.push(req);
			},
		});
		const filesystem = new InternalUrlFilesystem({
			context: sessionResolveContext(session),
			tier: "read",
		});

		const prefixBytes = await filesystem.readPrefix(targetPath, 10);
		expect(new TextDecoder().decode(prefixBytes)).toBe("first line");

		const scanned = await readText(filesystem, shmSidecarPath, 64);
		expect(scanned.text).toBe("shm-header-text\nsecond line\n");

		const targetLockedAfter = peerPosixWriteLockBlocked(targetPath);
		const shmLockedAfter = peerPosixWriteLockBlocked(shmSidecarPath);
		const readRequests = requests.filter(r => r.operation === "read");

		expect(
			{
				readRequestPaths: readRequests.map(r => r.targetPath),
				targetStillLocked: targetLockedAfter.blocked,
				shmStillLocked: shmLockedAfter.blocked,
			},
			[
				"1. WHAT: POST-RAWIO-4 InternalUrlFilesystem.readPrefix lock retention and helper routing FAILED",
				"2. WHY: In-process Bun.file(node.path).slice(0, maxBytes).bytes() opens and closes a descriptor in omp, releasing POSIX locks",
				`3. EXPECTED: readRequests for [${targetPath}, ${shmSidecarPath}] and both POSIX locks retained (true, true)`,
				`4. ACTUAL: readRequests=${JSON.stringify(readRequests)} targetLocked=${String(targetLockedAfter.blocked)} shmLocked=${String(shmLockedAfter.blocked)}`,
				"5. GUIDANCE: Route non-virtual readPrefix reads through readRawIoBytes with context.session?.rawIoHelperOptions",
			].join("\n"),
		).toEqual({
			readRequestPaths: [targetPath, shmSidecarPath],
			targetStillLocked: true,
			shmStillLocked: true,
		});
	});

	it("POST-RAWIO-4 / ERRORS-RAWIO-1 / FORBIDDEN-RAWIO-1b: helper failure rejects with UrlFsError naming operation 'read' and target path without in-process fallback", async () => {
		const targetPath = path.join(tempDir, "fallback-canary.txt");
		await fs.writeFile(targetPath, "canary bytes that must never be read in-process\n", "utf8");
		heldLockFds.push(acquireInProcessPosixWriteLock(targetPath));

		const failingWorkerScript = path.join(tempDir, "failing-worker.ts");
		await fs.writeFile(
			failingWorkerScript,
			[
				'process.on("message", (msg: unknown) => {',
				'  if (msg && typeof msg === "object" && "id" in msg && typeof msg.id === "string") {',
				'    process.send?.({ type: "started", id: msg.id });',
				'    process.send?.({ type: "error", id: msg.id, operation: (msg as any).operation || "read", targetPath: (msg as any).targetPath || "", error: "EIO: simulated helper disk error" });',
				"  }",
				"});",
			].join("\n"),
			"utf8",
		);

		const session = createTestToolSession(tempDir, {
			helperSpawnCommand: { cmd: [process.execPath, failingWorkerScript] },
		});
		const filesystem = new InternalUrlFilesystem({
			context: sessionResolveContext(session),
			tier: "read",
		});

		let caught: unknown;
		try {
			await filesystem.readPrefix(targetPath, 16);
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(UrlFsError);
		const urlErr = caught as UrlFsError;
		expect(urlErr.message).toContain("read");
		expect(urlErr.message).toContain(targetPath);
		expect(urlErr.message).toContain("simulated helper disk error");
		expect(peerPosixWriteLockBlocked(targetPath).blocked).toBe(true);
	});
});
