import { afterEach, describe, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SpeculativeOperationContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CodingAgentSpeculativeExecutionHost } from "@oh-my-pi/pi-coding-agent/speculation/host";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { stopRawIoHelper } from "@oh-my-pi/pi-coding-agent/tools/raw-io-client";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { acquireInProcessPosixWriteLock, peerPosixWriteLockBlocked } from "./utils/posix-lock-probe";

function evidence(what: string, expected: string, actual: unknown): string {
	return [
		`1. WHAT: ${what} FAILED`,
		"2. WHY: POST-RAWIO-3 violation (speculative reads)",
		`3. EXPECTED: ${expected}`,
		`4. ACTUAL: ${JSON.stringify(actual)}`,
		"5. GUIDANCE: Speculation must resolve without opening and refuse SQLite-Family targets so the ordinary helper-backed read runs",
	].join("\n");
}

const directories: string[] = [];
const heldFds: number[] = [];

afterEach(async () => {
	for (const fd of heldFds.splice(0)) fsSync.closeSync(fd);
	await stopRawIoHelper();
	await Promise.all(directories.splice(0).map(directory => removeWithRetries(directory)));
});

function session(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"images.autoResize": false,
			"tools.approvalMode": "yolo",
			"tools.speculativeExecution.enabled": true,
		}),
	};
}

async function speculate(directory: string, relativePath: string) {
	const toolSession = session(directory);
	const tool = new ReadTool(toolSession);
	const assessment = await tool.speculation.finalized?.assess({ args: { path: relativePath } });
	if (!assessment?.eligible || assessment.effect.kind !== "local_read")
		throw new Error("expected an eligible local read");
	const context: SpeculativeOperationContext = {
		candidateId: `read-${relativePath}`,
		source: "direct",
		dependencies: [],
		tool,
		toolCall: { type: "toolCall", id: "read-1", name: "read", arguments: { path: relativePath } },
		args: { path: relativePath },
		effect: assessment.effect,
	};
	const host = new CodingAgentSpeculativeExecutionHost(toolSession.settings, toolSession, {
		hasHandlers: () => false,
	});
	const authorization = await host.authorize(context);
	const captured = authorization.allowed ? await host.captureEvidence(context) : false;
	return { allowed: authorization.allowed, captured };
}

describe("speculative reads of SQLite-Family targets (Copilot F3)", () => {
	it("control: an ordinary file is authorized and its evidence captured", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-sqlite-"));
		directories.push(directory);
		await fs.writeFile(path.join(directory, "notes.txt"), "plain text\n");
		const result = await speculate(directory, "notes.txt");
		expect(result, evidence("ordinary speculative read control", "allowed and captured", result)).toEqual({
			allowed: true,
			captured: true,
		});
	});

	it("refuses a locked -shm sidecar without releasing the lock omp holds on it", async () => {
		/* CAR: contracts/raw_io_helper.contract.ts POST-RAWIO-3 (speculative reads resolve without opening and
		 * refuse SQLite-Family targets), verification=test. HIGH-risk lock-loss boundary, same class as the 2026-10
		 * database corruption: digestTargetEvidence did fs.readFile on any regular file up to 4 MiB, and closing any
		 * descriptor for an inode drops the process's POSIX locks. C1: clause names speculation; C2: speculation is
		 * opt-in (default off) but this test enables it; C3: differs from the ReadTool routing tests, which never
		 * enable speculation; C4: real host, real tool assessment, a real in-process lockf lock, and an independent
		 * OS process probing it after the speculative read. No doubles.
		 */
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-sqlite-"));
		directories.push(directory);
		const sidecar = path.join(directory, "live.db-shm");
		await fs.writeFile(sidecar, Buffer.alloc(32768, 1));
		expect(
			peerPosixWriteLockBlocked(sidecar).blocked,
			evidence("lock probe control", "an unlocked sidecar is not blocked", null),
		).toBe(false);
		heldFds.push(acquireInProcessPosixWriteLock(sidecar));
		expect(
			peerPosixWriteLockBlocked(sidecar).blocked,
			evidence("held lock control", "the held lock blocks the independent probe", null),
		).toBe(true);
		const result = await speculate(directory, "live.db-shm");
		const stillLocked = peerPosixWriteLockBlocked(sidecar);
		expect(
			{ captured: result.captured, stillLocked: stillLocked.blocked },
			evidence("speculative read of a locked sidecar", "no evidence captured and the lock survives", {
				result,
				probe: stillLocked.detail,
			}),
		).toEqual({ captured: false, stillLocked: true });
	});
});
