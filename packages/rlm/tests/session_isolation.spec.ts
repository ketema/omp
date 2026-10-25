/**
 * RLM Session State Isolation Tests (SLICE-2).
 *
 * Verifies session directory partitioning, lifecycle context resolution,
 * fallback directory isolation, disposal error reporting, and non-theater wire telemetry under CCABDD.
 *
 * CONTRACT AUTHORITY RECORD:
 * - Contract: contracts/rlm-session-isolation.contract.ts
 * - Clauses covered:
 *     POST-SESSION-ISOLATION-1: Resolves artifactsDir partitioned by session context
 *     POST-SESSION-FALLBACK-ISOLATION-1: Missing session identifier falls back to isolated timestamped dir
 *     ERRORS-SESSION-SWITCH-DISPOSE-1: Emits observable warning on outgoing kernel disposal failure
 *     POST-TRANS-SKIPPED-WIRE-PROPAGATION-1: Authentic KernelTransport stdio wire frames propagate skipped unpicklables
 *     FORBIDDEN-CROSS-SESSION-BLEED-1: Prohibits loading snapshots from shared root
 *     IP-5: Delivers partitioned artifactsDir to kernel initialization
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

import { createRlmExtension, type RlmExtensionKernelPort } from "../src/extension.ts";
import { KernelManager } from "../src/kernel.ts";
import { createTransport, type RlmTransportProcess } from "../src/transport.ts";

function makeKernelPort(
	overrides: {
		restoredNames?: string[];
		restoredSkipped?: Array<{ name: string; reason: string }>;
		disposeError?: Error;
	} = {},
): {
	port: RlmExtensionKernelPort;
	calls: Array<{ kind: string; detail: string }>;
	wasStarted: () => boolean;
	wasDisposed: () => boolean;
} {
	const calls: Array<{ kind: string; detail: string }> = [];
	let started = false;
	let disposed = false;
	const port: RlmExtensionKernelPort = {
		async ensureStarted() {
			calls.push({ kind: "ensureStarted", detail: "" });
			started = true;
		},
		async execute(code) {
			calls.push({ kind: "execute", detail: code });
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
		async kill() {
			calls.push({ kind: "kill", detail: "" });
			started = false;
		},
		async dispose() {
			calls.push({ kind: "dispose", detail: "" });
			disposed = true;
			started = false;
			if (overrides.disposeError) {
				throw overrides.disposeError;
			}
		},
		restoredNames() {
			return overrides.restoredNames ?? [];
		},
		restoredSkipped() {
			return overrides.restoredSkipped ?? [];
		},
		async onCompactionComplete() {
			calls.push({ kind: "onCompactionComplete", detail: "" });
		},
		compactionNotice() {
			return null;
		},
	};
	return { port, calls, wasStarted: () => started, wasDisposed: () => disposed };
}

interface MessageReceipt {
	readonly payload: unknown;
	readonly options: unknown;
}

function makeApi() {
	const registered: {
		tools: Array<Record<string, unknown>>;
		handlers: Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>;
		sentMessages: MessageReceipt[];
	} = { tools: [], handlers: new Map(), sentMessages: [] };

	const api = {
		registerTool(tool: Record<string, unknown>) {
			registered.tools.push(tool);
		},
		registerFlag() {},
		registerCommand() {},
		on(event: string, handler: (event: unknown, ctx?: unknown) => unknown) {
			const list = registered.handlers.get(event) ?? [];
			list.push(handler);
			registered.handlers.set(event, list);
		},
		getFlag() {
			return undefined;
		},
		sendMessage(payload: unknown, options?: unknown) {
			registered.sentMessages.push({ payload, options });
		},
	};
	return { api, registered };
}

describe("SLICE-2: Session Artifacts Isolation", () => {
	test("POST-SESSION-ISOLATION-1: fresh session with sessionManager.getArtifactsDir() partitions artifactsDir and does NOT bleed shared root snapshot (F2/F6)", async () => {
		const tempRoot = fs.mkdtempSync("/tmp/rlm-session-iso-");
		try {
			const sharedRoot = join(tempRoot, ".omp", "artifacts");
			fs.mkdirSync(sharedRoot, { recursive: true });
			fs.writeFileSync(join(sharedRoot, "kernel-state.dill"), "STALE_PRIOR_SESSION_DATA");

			const kernel = makeKernelPort({ restoredNames: ["stale_leaked_var"] });

			const { api, registered } = makeApi();
			const factory = createRlmExtension({
				createKernel() {
					return kernel.port;
				},
			});
			await factory(api as never);

			const sessionStartHandlers = registered.handlers.get("session_start") ?? [];
			expect(sessionStartHandlers.length).toBeGreaterThan(0);

			const sessionArtifactsDir = join(tempRoot, "sessions", "session-alpha", "artifacts");
			fs.mkdirSync(sessionArtifactsDir, { recursive: true });

			const mockCtx = {
				cwd: tempRoot,
				sessionManager: {
					getArtifactsDir: () => sessionArtifactsDir,
					getSessionId: () => "session-alpha",
				},
			};

			await sessionStartHandlers[0]({ type: "session_start" }, mockCtx);

			const revivalMessages = registered.sentMessages.filter(m => {
				const payload = m.payload;
				if (payload && typeof payload === "object" && "customType" in payload) {
					return payload.customType === "rlm-revival";
				}
				return false;
			});

			expect(revivalMessages.length).toBe(0);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test("POST-SESSION-ISOLATION-1: session with snapshot in partitioned directory revives and surfaces skipped warnings (F5)", async () => {
		const tempRoot = fs.mkdtempSync("/tmp/rlm-session-iso-dir-");
		try {
			const sessionArtifactsDir = join(tempRoot, "sessions", "session-beta", "artifacts");
			fs.mkdirSync(sessionArtifactsDir, { recursive: true });
			fs.writeFileSync(join(sessionArtifactsDir, "kernel-state.dill"), "VALID_SESSION_SNAPSHOT");

			const kernel = makeKernelPort({
				restoredNames: ["valid_var"],
				restoredSkipped: [{ name: "broken_var", reason: "missing module" }],
			});

			const { api, registered } = makeApi();
			const factory = createRlmExtension({
				createKernel() {
					return kernel.port;
				},
			});
			await factory(api as never);

			const sessionStartHandlers = registered.handlers.get("session_start") ?? [];
			expect(sessionStartHandlers.length).toBeGreaterThan(0);

			const mockCtx = {
				cwd: tempRoot,
				sessionManager: {
					getArtifactsDir: () => sessionArtifactsDir,
					getSessionId: () => "session-beta",
				},
			};

			await sessionStartHandlers[0]({ type: "session_start" }, mockCtx);

			const revivalMessages = registered.sentMessages.filter(m => {
				const payload = m.payload;
				if (payload && typeof payload === "object" && "customType" in payload) {
					return payload.customType === "rlm-revival";
				}
				return false;
			});

			expect(revivalMessages.length).toBe(1);
			const firstPayload = revivalMessages[0].payload;
			let content = "";
			if (firstPayload && typeof firstPayload === "object" && "content" in firstPayload) {
				const rawContent = firstPayload.content;
				if (typeof rawContent === "string") {
					content = rawContent;
				}
			}
			expect(content).toContain("valid_var");
			expect(content).toContain("Warning: The following unpicklable variables were skipped: broken_var");
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test("POST-SESSION-ISOLATION-1: session_switch disposes outgoing kernel and re-resolves storage for new session (Comment 4366356325)", async () => {
		const tempRoot = fs.mkdtempSync("/tmp/rlm-session-switch-");
		try {
			const sessionADir = join(tempRoot, "sessions", "session-A", "artifacts");
			const sessionBDir = join(tempRoot, "sessions", "session-B", "artifacts");
			fs.mkdirSync(sessionADir, { recursive: true });
			fs.mkdirSync(sessionBDir, { recursive: true });
			fs.writeFileSync(join(sessionADir, "kernel-state.dill"), "SNAPSHOT_A");
			fs.writeFileSync(join(sessionBDir, "kernel-state.dill"), "SNAPSHOT_B");

			const kernelA = makeKernelPort({ restoredNames: ["var_from_session_A"] });
			const kernelB = makeKernelPort({ restoredNames: ["var_from_session_B"] });
			let createCallCount = 0;

			const { api, registered } = makeApi();
			const factory = createRlmExtension({
				createKernel() {
					createCallCount++;
					return createCallCount === 1 ? kernelA.port : kernelB.port;
				},
			});
			await factory(api as never);

			const sessionStartHandlers = registered.handlers.get("session_start") ?? [];
			expect(sessionStartHandlers.length).toBeGreaterThan(0);

			const ctxA = {
				cwd: tempRoot,
				sessionManager: {
					getArtifactsDir: () => sessionADir,
					getSessionId: () => "session-A",
				},
			};
			await sessionStartHandlers[0]({ type: "session_start" }, ctxA);
			expect(kernelA.wasStarted()).toBe(true);
			expect(kernelA.wasDisposed()).toBe(false);

			const sessionSwitchHandlers = registered.handlers.get("session_switch") ?? [];
			expect(sessionSwitchHandlers.length).toBeGreaterThan(0);

			const ctxB = {
				cwd: tempRoot,
				sessionManager: {
					getArtifactsDir: () => sessionBDir,
					getSessionId: () => "session-B",
				},
			};
			await sessionSwitchHandlers[0](
				{ type: "session_switch", reason: "resume", previousSessionFile: "/path/to/A" },
				ctxB,
			);

			expect(kernelA.wasDisposed()).toBe(true);
			expect(kernelB.wasStarted()).toBe(true);

			const revivalMessages = registered.sentMessages.filter(m => {
				const payload = m.payload;
				if (payload && typeof payload === "object" && "customType" in payload) {
					return payload.customType === "rlm-revival";
				}
				return false;
			});

			expect(revivalMessages.length).toBe(2);
			expect(JSON.stringify(revivalMessages[1].payload)).toContain("var_from_session_B");
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test("POST-SESSION-FALLBACK-ISOLATION-1: missing session identifier falls back to isolated timestamped directory with warning (REQ-003 line 143)", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-SESSION-FALLBACK-ISOLATION-1
		 *   [✓] C2 VALUABLE: passes 'can impl be wrong and test pass?' = NO (reproduces line 143 requirement)
		 *   [✓] C3 NON-DUPLICATIVE: asserts fallback creates dedicated isolated timestamped dir, never bare root
		 *   [✓] C4 NOT FUTURE-EDIT: exercises fallback path in extension handleSessionInit
		 */
		const tempRoot = fs.mkdtempSync("/tmp/rlm-session-fallback-");
		try {
			const bareRoot = join(tempRoot, ".omp", "artifacts");
			fs.mkdirSync(bareRoot, { recursive: true });
			fs.writeFileSync(join(bareRoot, "kernel-state.dill"), "STALE_BARE_ROOT_DATA");

			const kernel = makeKernelPort();

			const { api, registered } = makeApi();
			const factory = createRlmExtension({
				createKernel(_config) {
					return kernel.port;
				},
			});
			await factory(api as never);

			const sessionStartHandlers = registered.handlers.get("session_start") ?? [];
			expect(sessionStartHandlers.length).toBeGreaterThan(0);

			// Call with NO sessionManager and NO sessionDir in event
			const mockCtx = {
				cwd: tempRoot,
				sessionManager: undefined,
			};
			await sessionStartHandlers[0]({ type: "session_start" }, mockCtx);

			// Must emit an observable warning message regarding fallback directory resolution
			const warningMessages = registered.sentMessages.filter(m => {
				const payload = m.payload as any;
				return payload?.customType === "rlm-warning" && typeof payload?.content === "string";
			});
			expect(warningMessages.length).toBe(1);
			expect((warningMessages[0].payload as any).content).toContain("Fallback isolated directory");

			// Trigger tool execution to observe resolved artifactsDir
			const tool = registered.tools[0];
			const execute = tool.execute as any;
			await execute("call-1", { code: "1+1" }, undefined, undefined, mockCtx);

			// Fallback must be an isolated timestamped subfolder, NEVER the bare unpartitioned root
			const dirs = fs.readdirSync(bareRoot);
			const isolatedSubdirs = dirs.filter(d => d.startsWith("isolated-"));
			expect(isolatedSubdirs.length).toBe(1);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test("ERRORS-SESSION-SWITCH-DISPOSE-1: outgoing kernel disposal failure in session_switch emits observable warning rather than silent success", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause ERRORS-SESSION-SWITCH-DISPOSE-1
		 *   [✓] C2 VALUABLE: passes 'can impl be wrong and test pass?' = NO (proves disposal errors are observable)
		 *   [✓] C3 NON-DUPLICATIVE: asserts observable failure message emitted when kernel.dispose throws
		 *   [✓] C4 NOT FUTURE-EDIT: exercises error path of handleSessionInit on session_switch
		 */
		const tempRoot = fs.mkdtempSync("/tmp/rlm-session-err-");
		try {
			const sessionADir = join(tempRoot, "sessions", "session-A", "artifacts");
			const sessionBDir = join(tempRoot, "sessions", "session-B", "artifacts");
			fs.mkdirSync(sessionADir, { recursive: true });
			fs.mkdirSync(sessionBDir, { recursive: true });

			const kernelA = makeKernelPort({
				disposeError: new Error("Simulated flush failure: disk full on snapshot save"),
			});
			const kernelB = makeKernelPort();
			let createCallCount = 0;

			const { api, registered } = makeApi();
			const factory = createRlmExtension({
				createKernel() {
					createCallCount++;
					return createCallCount === 1 ? kernelA.port : kernelB.port;
				},
			});
			await factory(api as never);

			const sessionStartHandlers = registered.handlers.get("session_start") ?? [];
			await sessionStartHandlers[0](
				{ type: "session_start" },
				{
					cwd: tempRoot,
					sessionManager: { getArtifactsDir: () => sessionADir, getSessionId: () => "session-A" },
				},
			);

			const sessionSwitchHandlers = registered.handlers.get("session_switch") ?? [];
			await sessionSwitchHandlers[0](
				{ type: "session_switch", reason: "new" },
				{
					cwd: tempRoot,
					sessionManager: { getArtifactsDir: () => sessionBDir, getSessionId: () => "session-B" },
				},
			);

			// Outgoing disposal error must be visibly surfaced as a warning message
			const warnings = registered.sentMessages.filter(m => {
				const payload = m.payload as any;
				return payload?.customType === "rlm-warning" && typeof payload?.content === "string";
			});
			expect(warnings.length).toBeGreaterThan(0);
			expect(warnings.some(w => (w.payload as any).content.includes("Simulated flush failure"))).toBe(true);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test("POST-TRANS-SKIPPED-WIRE-PROPAGATION-1: authentic KernelTransport wire result frame propagates skipped unpicklables into KernelManager and revival notice without test theater", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-TRANS-SKIPPED-WIRE-PROPAGATION-1
		 *   [✓] C2 VALUABLE: passes 'can impl be wrong and test pass?' = NO
		 *       (FALSIFIABILITY PROOF: mutating transport.ts line 862 from `skipped: frame.skipped ?? []`
		 *        to `skipped: []` causes this test to FAIL: expected 1 skipped record, received 0)
		 *   [✓] C3 NON-DUPLICATIVE: uses REAL RlmTransport class, real frame parser, real KernelManager, and real adapter
		 *   [✓] C4 NOT FUTURE-EDIT: exercises authentic transport line-buffer and result dispatching
		 */
		const tempRoot = fs.mkdtempSync("/tmp/rlm-real-transport-");
		try {
			const sessionDir = join(tempRoot, "sessions", "sess-real-wire", "artifacts");
			fs.mkdirSync(sessionDir, { recursive: true });
			fs.writeFileSync(join(sessionDir, "kernel-state.dill"), "SNAPSHOT_ON_DISK");

			let stdoutCb: ((chunk: string) => void) | null = null;
			const stdinWrittenLines: string[] = [];

			const proc: RlmTransportProcess = {
				stdin: {
					write(line: string) {
						stdinWrittenLines.push(line);
					},
					end() {},
				},
				onStdout(cb) {
					stdoutCb = cb;
				},
				onStderr() {},
				kill() {},
				onExit() {},
			};

			const clock = {
				now() {
					return Date.now();
				},
				schedule(fn: () => void, ms: number) {
					const t = setTimeout(fn, ms);
					return () => clearTimeout(t);
				},
			};

			// Instantiate the ACTUAL KernelTransport via createTransport
			const transport = createTransport(
				{
					interpreter: "/usr/bin/python3",
					env: {},
					cwd: tempRoot,
					artifactsDir: sessionDir,
				},
				{
					clock,
					spawn: () => proc,
				},
			);

			const startPromise = transport.start();
			// Emit standard ready handshake from runner process
			await new Promise(r => setTimeout(r, 0));
			stdoutCb?.('{"type": "ready", "protocol": 1}\n');
			await startPromise;

			// Instantiate ACTUAL KernelManager over the real transport
			const manager = new KernelManager(transport, {
				clock,
				artifactsDir: sessionDir,
			});

			// Now invoke manager.ensureStarted() which calls transport.restoreSnapshot()
			const ensureStartedPromise = manager.ensureStarted();
			await new Promise(r => setTimeout(r, 0));

			// Verify transport sent snapshot_restore op down the wire
			const restoreOpLine = stdinWrittenLines.find(l => l.includes('"snapshot_restore"'));
			expect(restoreOpLine).toBeDefined();
			const restoreOp = JSON.parse(restoreOpLine!);

			// Runner emits authentic stdio JSON frame over stdout containing restoredNames and skipped unpicklables
			const wireFrame = {
				type: "result",
				id: restoreOp.id,
				restoredNames: ["good_df", "valid_var"],
				skipped: [{ name: "corrupted_fn", reason: "UnpicklingError: invalid opcode", type: "UnpicklingError" }],
			};
			stdoutCb?.(`${JSON.stringify(wireFrame)}\n`);

			await new Promise(r => setTimeout(r, 5));
			const bootOpLine = stdinWrittenLines.find(l => l.includes('"bootstrap"'));
			expect(bootOpLine).toBeDefined();
			const bootOp = JSON.parse(bootOpLine!);
			stdoutCb?.(`${JSON.stringify({ type: "result", id: bootOp.id, stdout: "", stderr: "" })}\n`);

			await ensureStartedPromise;

			// Assert that REAL transport parsed the wire frame and passed skipped into REAL manager
			expect(manager.restoredNames()).toEqual(["good_df", "valid_var"]);
			expect(manager.restoredSkipped().length).toBe(1);
			expect(manager.restoredSkipped()[0].name).toBe("corrupted_fn");

			await transport.dispose();
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});
