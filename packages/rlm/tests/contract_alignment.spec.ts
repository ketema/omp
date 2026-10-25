/**
 * CL11-F bridge for contracts/rlm-session-isolation.contract.ts: the implementation never imports the contract, so
 * this spec is the only place the two meet. It imports BOTH, aligns the values the implementation redeclares, and
 * drives the contract's own validator against directories the real extension produces.
 *
 * CONTRACT AUTHORITY RECORD:
 * - Contract: contracts/rlm-session-isolation.contract.ts
 * - Clauses covered: POST-SESSION-FALLBACK-ISOLATION-1 (fallback directory shape), POST-SESSION-OWNED-DIR-1 (owned
 *   directory is used as resolved), POST-SESSION-ISOLATION-1 (no bare shared root)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import {
	DEFAULT_ARTIFACTS_DIRNAME,
	MANIFEST_FILENAME,
	SNAPSHOT_FILENAME,
	SharedRootBleedError,
	validateSessionArtifactsDir,
} from "../../../contracts/rlm-session-isolation.contract.ts";
import { createRlmExtension, type RlmExtensionKernelPort } from "../src/extension.ts";
import { SNAPSHOT_MANIFEST_FILE, SNAPSHOT_PAYLOAD_FILE } from "../src/kernel.ts";
import { completePortDouble } from "./kernel_port_double.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;

let root = "";
beforeAll(() => {
	root = fs.mkdtempSync(join(os.tmpdir(), "rlm-contract-alignment-"));
});
afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function inertPort(): RlmExtensionKernelPort {
	return {
		...completePortDouble(),
		async ensureStarted() {},
		async execute() {
			return {
				status: "ok" as const,
				stdout: "",
				stderr: "",
				result: "",
				traceback: undefined,
				errorEname: undefined,
				durationMs: 1,
				kernelRestarted: undefined,
			};
		},
		async kill() {},
		async dispose() {},
		async flushSnapshot() {},
		restoredNames: () => [],
		restoredSkipped: () => [],
		async onCompactionComplete() {},
		compactionNotice: () => null,
	};
}

/** Wires the real extension to an inert kernel port and returns the directories it hands to kernel construction. */
async function wire() {
	const handlers = new Map<string, Handler[]>();
	const tools: Array<{ execute: (...args: unknown[]) => Promise<unknown> }> = [];
	const dirs: string[] = [];
	const api = {
		registerTool: (tool: (typeof tools)[number]) => void tools.push(tool),
		registerFlag() {},
		registerCommand() {},
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		getFlag: () => undefined,
		sendMessage() {},
	};
	await createRlmExtension({
		createKernel(_config, artifactsDir) {
			dirs.push(artifactsDir);
			return inertPort();
		},
	})(api as never);
	const toolCtx = { hasUI: false, setWorkingMessage() {}, ui: { select: async () => undefined } };
	return {
		dirs,
		async emit(type: string, ctx: unknown) {
			for (const handler of handlers.get(type) ?? []) await handler({ type }, ctx);
		},
		async useKernel(code: string) {
			await tools[0].execute("c", { code }, undefined, undefined, toolCtx);
		},
	};
}

describe("contract/implementation alignment (CL11-F): tests are the only bridge", () => {
	test("the file names the implementation redeclares equal the contract's", () => {
		expect(
			SNAPSHOT_PAYLOAD_FILE,
			"POST-SESSION-ISOLATION-1 violation: the kernel's payload filename diverges from the contract's SNAPSHOT_FILENAME",
		).toBe(SNAPSHOT_FILENAME);
		expect(
			SNAPSHOT_MANIFEST_FILE,
			"POST-SESSION-ISOLATION-1 violation: the kernel's manifest filename diverges from the contract's MANIFEST_FILENAME",
		).toBe(MANIFEST_FILENAME);
	});

	test("directories the real extension chooses satisfy the contract's validator, and the bare shared root does not", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [x] C1 VALID: cites POST-SESSION-FALLBACK-ISOLATION-1 / POST-SESSION-OWNED-DIR-1 / POST-SESSION-ISOLATION-1
		 *   [x] C2 VALUABLE: an extension that built a kernel on the bare shared root, or somewhere other than the resolved
		 *       owned directory, fails the contract validator or the equality
		 *   [x] C3 NON-DUPLICATIVE: the isolation specs assert behavior; this one applies the CONTRACT's predicate to it
		 *   [x] C4 NOT FUTURE-EDIT: enforces clauses that exist today
		 */
		const cwd = join(root, "project");
		fs.mkdirSync(cwd, { recursive: true });

		// An owned directory is used exactly as the host resolved it.
		const owned = join(root, "sessions", "owned-artifacts");
		const ownedRun = await wire();
		await ownedRun.emit("session_start", { cwd, sessionManager: { resolveOwnArtifactsDir: async () => owned } });
		await ownedRun.useKernel("a = 1");
		expect(
			ownedRun.dirs,
			"IP-5 / POST-SESSION-OWNED-DIR-1 violation: kernel construction was not handed the resolved owned directory",
		).toEqual([owned]);
		expect(validateSessionArtifactsDir(owned, { sessionDir: owned, cwd })).toBe(true);

		// A session that owns nothing gets an isolated fallback, never the bare shared root.
		const fallbackRun = await wire();
		await fallbackRun.emit("session_start", { cwd, sessionManager: { resolveOwnArtifactsDir: async () => null } });
		await fallbackRun.useKernel("b = 1");
		expect(fallbackRun.dirs.length).toBe(1);
		const fallback = fallbackRun.dirs[0];
		expect(
			fallback.startsWith(join(cwd, DEFAULT_ARTIFACTS_DIRNAME, "isolated-")),
			`POST-SESSION-FALLBACK-ISOLATION-1 violation: fallback directory is not an isolated-* child of ${DEFAULT_ARTIFACTS_DIRNAME} (${fallback})`,
		).toBe(true);
		expect(validateSessionArtifactsDir(fallback, { cwd })).toBe(true);

		// The predicate itself is falsifiable: the bare shared root is rejected.
		expect(() => validateSessionArtifactsDir(join(cwd, DEFAULT_ARTIFACTS_DIRNAME), { cwd })).toThrow(
			SharedRootBleedError,
		);
	});
});
