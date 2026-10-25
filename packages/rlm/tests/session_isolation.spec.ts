/**
 * RLM Session State Isolation Tests (SLICE-2).
 *
 * Verifies session directory partitioning, lifecycle context resolution,
 * atomic fallback directory isolation, teardown error reporting, and true full-path
 * default construction recovery without test theater under CCABDD.
 *
 * CONTRACT AUTHORITY RECORD:
 * - Contract: contracts/rlm-session-isolation.contract.ts
 * - Clauses covered:
 *     POST-SESSION-ISOLATION-1: Resolves artifactsDir partitioned by session context
 *     POST-SESSION-FALLBACK-ISOLATION-1: Missing session identifier falls back to isolated atomic dir
 *     ERRORS-SESSION-SWITCH-DISPOSE-1: Emits observable warning on outgoing kernel teardownNotice/disposal failure
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
		teardownNotice?: string | null;
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
		async execute(code: string) {
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
		takeTeardownNotice() {
			return overrides.teardownNotice ?? null;
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

interface MessagePayload {
	readonly role?: string;
	readonly customType?: string;
	readonly content?: string;
	readonly display?: boolean;
	readonly attribution?: string;
	readonly timestamp?: number;
}

interface MessageReceipt {
	readonly payload: unknown;
	readonly options: unknown;
}

function isMessagePayload(value: unknown): value is MessagePayload {
	return typeof value === "object" && value !== null;
}

interface ToolDefinitionRecord {
	readonly name: string;
	readonly execute: (
		toolCallId: string,
		params: { code: string },
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

function makeApi(options: { flags?: Record<string, string | boolean> } = {}) {
	const registered: {
		tools: ToolDefinitionRecord[];
		flags: Array<{ name: string; type: string; default?: string | boolean }>;
		handlers: Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>;
		sentMessages: MessageReceipt[];
	} = { tools: [], flags: [], handlers: new Map(), sentMessages: [] };
	const flagValues: Record<string, string | boolean> = { ...options.flags };

	const api = {
		registerTool(tool: ToolDefinitionRecord) {
			registered.tools.push(tool);
		},
		registerFlag(name: string, opts: { type: string; default?: string | boolean }) {
			registered.flags.push({ name, type: opts.type, default: opts.default });
			if (opts.default !== undefined && flagValues[name] === undefined) {
				flagValues[name] = opts.default;
			}
		},
		registerCommand() {},
		on(event: string, handler: (event: unknown, ctx?: unknown) => unknown) {
			const list = registered.handlers.get(event) ?? [];
			list.push(handler);
			registered.handlers.set(event, list);
		},
		getFlag(name: string) {
			return flagValues[name];
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
				return isMessagePayload(m.payload) && m.payload.customType === "rlm-revival";
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
				return isMessagePayload(m.payload) && m.payload.customType === "rlm-revival";
			});

			expect(revivalMessages.length).toBe(1);
			const firstPayload = revivalMessages[0].payload;
			const content = isMessagePayload(firstPayload) ? (firstPayload.content ?? "") : "";
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
				return isMessagePayload(m.payload) && m.payload.customType === "rlm-revival";
			});

			expect(revivalMessages.length).toBe(2);
			const secondPayload = revivalMessages[1].payload;
			const content = isMessagePayload(secondPayload) ? (secondPayload.content ?? "") : "";
			expect(content).toContain("var_from_session_B");
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test("POST-SESSION-ISOLATION-1: adopted parent artifact manager partitions child session under child sessionId (Comment 4369713118)", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-SESSION-ISOLATION-1
		 *   [✓] C2 VALUABLE: passes 'can impl be wrong and test pass?' = NO (Comment 4369713118)
		 *   [✓] C3 NON-DUPLICATIVE: asserts adopted parent manager root is partitioned by child sessionId
		 *   [✓] C4 NOT FUTURE-EDIT: exercises adopted manager resolution path
		 */
		const tempRoot = fs.mkdtempSync("/tmp/rlm-session-adopted-");
		try {
			const parentArtifactsDir = join(tempRoot, "parent-session-artifacts");
			fs.mkdirSync(parentArtifactsDir, { recursive: true });

			const kernel = makeKernelPort();
			const { api, registered } = makeApi();
			const factory = createRlmExtension({ createKernel: () => kernel.port });
			await factory(api as never);

			const startHandler = registered.handlers.get("session_start")?.[0];
			expect(startHandler).toBeDefined();

			// Subagent scenario: sessionManager.getArtifactsDir() returns parentArtifactsDir (adopted),
			// but sessionManager.getSessionId() returns distinct child-subagent id
			const childSessionId = "child-subagent-42";
			const childCtx = {
				cwd: tempRoot,
				sessionManager: {
					getArtifactsDir: () => parentArtifactsDir,
					getSessionId: () => childSessionId,
				},
			};

			await startHandler!({ type: "session_start" }, childCtx);

			const tool = registered.tools[0];
			expect(tool).toBeDefined();

			// Pre-populate a fake kernel-state.dill in parent root
			fs.writeFileSync(join(parentArtifactsDir, "kernel-state.dill"), "PARENT_STATE");

			// Trigger execution
			await tool.execute("call-child", { code: "1+1" }, undefined, undefined, childCtx);

			// Child session MUST partition into childSessionId subdirectory, NEVER share parent root directly
			const childExpectedDir = join(parentArtifactsDir, childSessionId);
			expect(fs.existsSync(childExpectedDir)).toBe(true);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test("POST-SESSION-ISOLATION-1: session_branch and session_before_branch lifecycle binds fork/branch transitions (Comment 4369713122 / 4369713144)", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-SESSION-ISOLATION-1
		 *   [✓] C2 VALUABLE: passes 'can impl be wrong and test pass?' = NO (Comments 4369713122, 4369713144)
		 *   [✓] C3 NON-DUPLICATIVE: asserts session_branch and session_before_branch event binding and disposal
		 *   [✓] C4 NOT FUTURE-EDIT: exercises branch lifecycle event family
		 */
		const tempRoot = fs.mkdtempSync("/tmp/rlm-session-branch-");
		try {
			const branchDirA = join(tempRoot, "branch-A");
			const branchDirB = join(tempRoot, "branch-B");
			fs.mkdirSync(branchDirA, { recursive: true });
			fs.mkdirSync(branchDirB, { recursive: true });

			const kernelA = makeKernelPort({ restoredNames: ["branch_a_var"] });
			const kernelB = makeKernelPort({ restoredNames: ["branch_b_var"] });
			let createCallCount = 0;

			const { api, registered } = makeApi();
			const factory = createRlmExtension({
				createKernel() {
					createCallCount++;
					return createCallCount === 1 ? kernelA.port : kernelB.port;
				},
			});
			await factory(api as never);

			// Verify session_branch and session_before_branch handlers are registered
			expect(registered.handlers.get("session_branch")?.length).toBeGreaterThan(0);
			expect(registered.handlers.get("session_before_branch")?.length).toBeGreaterThan(0);

			const startHandler = registered.handlers.get("session_start")?.[0];
			await startHandler!(
				{ type: "session_start" },
				{ cwd: tempRoot, sessionManager: { getArtifactsDir: () => branchDirA, getSessionId: () => "branch-A" } },
			);

			// Trigger session_branch
			const branchHandler = registered.handlers.get("session_branch")?.[0];
			await branchHandler!(
				{ type: "session_branch", reason: "fork", previousSessionFile: "/path/to/A" },
				{ cwd: tempRoot, sessionManager: { getArtifactsDir: () => branchDirB, getSessionId: () => "branch-B" } },
			);

			// Kernel A must be disposed on branch transition
			expect(kernelA.wasDisposed()).toBe(true);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test("POST-SESSION-FALLBACK-ISOLATION-1: distinct sessions under frozen clock allocate unique isolated directories without collision", async () => {
		const tempRoot = fs.mkdtempSync("/tmp/rlm-session-frozen-clock-");
		const originalNow = Date.now;
		try {
			Date.now = () => 123456789;

			const kernel1 = makeKernelPort();
			const kernel2 = makeKernelPort();

			const { api: api1, registered: reg1 } = makeApi();
			const { api: api2, registered: reg2 } = makeApi();

			const factory1 = createRlmExtension({ createKernel: () => kernel1.port });
			const factory2 = createRlmExtension({ createKernel: () => kernel2.port });

			await factory1(api1 as never);
			await factory2(api2 as never);

			const mockCtx = { cwd: tempRoot, sessionManager: undefined };

			const h1 = reg1.handlers.get("session_start")?.[0];
			const h2 = reg2.handlers.get("session_start")?.[0];
			expect(h1).toBeDefined();
			expect(h2).toBeDefined();

			await h1!({ type: "session_start" }, mockCtx);
			await h2!({ type: "session_start" }, mockCtx);

			const warnings1 = reg1.sentMessages.filter(
				m => isMessagePayload(m.payload) && m.payload.customType === "rlm-warning",
			);
			const warnings2 = reg2.sentMessages.filter(
				m => isMessagePayload(m.payload) && m.payload.customType === "rlm-warning",
			);
			expect(warnings1.length).toBe(1);
			expect(warnings2.length).toBe(1);

			const payload1 = warnings1[0].payload;
			const payload2 = warnings2[0].payload;
			const content1 = isMessagePayload(payload1) ? (payload1.content ?? "") : "";
			const content2 = isMessagePayload(payload2) ? (payload2.content ?? "") : "";

			const path1 = content1.split("assigned: ")[1]?.trim();
			const path2 = content2.split("assigned: ")[1]?.trim();

			expect(path1).toBeDefined();
			expect(path2).toBeDefined();
			expect(path1).not.toBe(path2);
			expect(fs.existsSync(path1)).toBe(true);
			expect(fs.existsSync(path2)).toBe(true);
		} finally {
			Date.now = originalNow;
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test("ERRORS-SESSION-SWITCH-DISPOSE-1: snapshot flush failure in kernel port surfaces via teardownNotice in session_switch", async () => {
		const tempRoot = fs.mkdtempSync("/tmp/rlm-session-teardown-");
		try {
			const sessionADir = join(tempRoot, "sessions", "session-A", "artifacts");
			const sessionBDir = join(tempRoot, "sessions", "session-B", "artifacts");
			fs.mkdirSync(sessionADir, { recursive: true });
			fs.mkdirSync(sessionBDir, { recursive: true });
			fs.writeFileSync(join(sessionADir, "kernel-state.dill"), "SNAPSHOT_A");

			const kernelA = makeKernelPort({
				teardownNotice: "snapshot flush failed during dispose: disk full on snapshot save",
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

			const warnings = registered.sentMessages.filter(m => {
				return isMessagePayload(m.payload) && m.payload.customType === "rlm-warning";
			});
			expect(warnings.length).toBeGreaterThan(0);
			expect(
				warnings.some(
					w =>
						isMessagePayload(w.payload) && (w.payload.content ?? "").includes("disk full on snapshot save"),
				),
			).toBe(true);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test("POST-TRANS-SKIPPED-WIRE-PROPAGATION-1: authentic KernelTransport wire result frame propagates skipped unpicklables into KernelManager without test theater", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-TRANS-SKIPPED-WIRE-PROPAGATION-1
		 *   [✓] C2 VALUABLE: passes 'can impl be wrong and test pass?' = NO
		 *       (FALSIFIABILITY PROOF: mutating transport.ts line 862 from `skipped: frame.skipped ?? []`
		 *        to `skipped: []` causes this test to FAIL: expected 1 skipped record, received 0)
		 *   [✓] C3 NON-DUPLICATIVE: uses REAL RlmTransport class, real frame parser, real KernelManager
		 *   [✓] C4 NOT FUTURE-EDIT: exercises authentic transport line-buffer and result dispatching
		 */
		const tempRoot = fs.mkdtempSync("/tmp/rlm-real-transport-");
		try {
			const sessionDir = join(tempRoot, "sessions", "sess-real-wire", "artifacts");
			fs.mkdirSync(sessionDir, { recursive: true });
			fs.writeFileSync(join(sessionDir, "kernel-state.dill"), "SNAPSHOT_ON_DISK");

			let emitStdout: (chunk: string) => void = () => {};
			const stdinWrittenLines: string[] = [];

			const proc: RlmTransportProcess = {
				stdin: {
					write(line: string) {
						stdinWrittenLines.push(line);
					},
					end() {},
				},
				onStdout(cb: (chunk: string) => void) {
					emitStdout = cb;
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
			await new Promise(r => setTimeout(r, 0));
			emitStdout('{"type": "ready", "protocol": 1}\n');
			await startPromise;

			const manager = new KernelManager(transport, {
				clock,
				artifactsDir: sessionDir,
			});

			const ensureStartedPromise = manager.ensureStarted();
			await new Promise(r => setTimeout(r, 0));

			const restoreOpLine = stdinWrittenLines.find(l => l.includes('"snapshot_restore"'));
			expect(restoreOpLine).toBeDefined();
			const restoreOp = JSON.parse(restoreOpLine!) as { id: string };

			const wireFrame = {
				type: "result",
				id: restoreOp.id,
				restoredNames: ["good_df", "valid_var"],
				skipped: [{ name: "corrupted_fn", reason: "UnpicklingError: invalid opcode", type: "UnpicklingError" }],
			};
			emitStdout(`${JSON.stringify(wireFrame)}\n`);

			await new Promise(r => setTimeout(r, 5));
			const bootOpLine = stdinWrittenLines.find(l => l.includes('"bootstrap"'));
			expect(bootOpLine).toBeDefined();
			const bootOp = JSON.parse(bootOpLine!) as { id: string };
			emitStdout(`${JSON.stringify({ type: "result", id: bootOp.id, stdout: "", stderr: "" })}\n`);

			await ensureStartedPromise;

			expect(manager.restoredNames()).toEqual(["good_df", "valid_var"]);
			expect(manager.restoredSkipped().length).toBe(1);
			expect(manager.restoredSkipped()[0].name).toBe("corrupted_fn");

			await transport.dispose();
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test("POST-TRANS-SKIPPED-WIRE-PROPAGATION-1: true full-path default construction recovery and session switch without createKernel hook", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites clause POST-TRANS-SKIPPED-WIRE-PROPAGATION-1 and POST-SESSION-ISOLATION-1
		 *   [✓] C2 VALUABLE: passes 'can impl be wrong and test pass?' = NO
		 *       (FALSIFIABILITY PROOF: mutating KernelManagerAdapter.restoredSkipped() to return [] causes
		 *        this test to FAIL: revival notice does not contain skipped variable names)
		 *   [✓] C3 NON-DUPLICATIVE: exercises true createRlmExtension() with real Python runner, real transport,
		 *       real KernelManager, real KernelManagerAdapter, real tool execution, and real session_switch
		 *   [✓] C4 NOT FUTURE-EDIT: portable to CI via existing managed venv or isolated bootstrap
		 */
		const tempRoot = fs.mkdtempSync("/tmp/rlm-true-default-path-");
		let shutdownFn: (() => Promise<unknown>) | null = null;
		try {
			const seedDir = join(tempRoot, "session-seed");
			const sessionADir = join(tempRoot, "session-A");
			const sessionBDir = join(tempRoot, "session-B");
			fs.mkdirSync(seedDir, { recursive: true });
			fs.mkdirSync(sessionADir, { recursive: true });
			fs.mkdirSync(sessionBDir, { recursive: true });

			const existingPython = join(
				process.env.HOME ?? "/Users/ketema",
				".omp/agent/kernel-venv/bin/python",
			);
			const configuredPython = fs.existsSync(existingPython) ? existingPython : undefined;

			const flags: Record<string, string> = {
				OMP_RLM_AGENT_DIR: join(tempRoot, "agent"),
			};
			if (configuredPython) {
				flags.RLM_KERNEL_PYTHON = configuredPython;
			}

			const { api, registered } = makeApi({ flags });
			const factory = createRlmExtension();
			await factory(api as never);

			shutdownFn = async () => {
				const handler = registered.handlers.get("session_shutdown")?.[0];
				if (handler) {
					await handler({});
				}
			};

			const ctx = (id: string, dir: string) => ({
				hasUI: false,
				setWorkingMessage() {},
				cwd: tempRoot,
				sessionDir: dir,
				sessionManager: {
					getArtifactsDir: () => dir,
					getSessionId: () => id,
				},
				ui: {
					async select() {
						return undefined;
					},
				},
			});

			const startHandler = registered.handlers.get("session_start")?.[0];
			expect(startHandler).toBeDefined();

			await startHandler!({ type: "session_start" }, ctx("seed", seedDir));
			const tool = registered.tools[0];
			expect(tool).toBeDefined();

			const seedResult = await tool.execute(
				"seed-1",
				{ code: "import sys; print('RLM_TEST_PYTHON=' + sys.executable)" },
				undefined,
				undefined,
				ctx("seed", seedDir),
			);
			expect(seedResult.isError ?? false).toBe(false);

			const match = /RLM_TEST_PYTHON=(.+)/.exec(seedResult.content[0]?.text ?? "");
			expect(match).toBeDefined();
			const resolvedPython = match![1].trim();
			expect(fs.existsSync(resolvedPython)).toBe(true);

			const fixtureScript = `
import dill, lzma, sys
class Broken:
    def __reduce__(self):
        return (compile, ('def broken(:', 'synthetic_fixture', 'exec'))
with lzma.open(sys.argv[1], 'wb') as f:
    dill.dump({'bad_fixture': dill.dumps(Broken()), 'healthy_fixture': dill.dumps(42)}, f)
`;
			const dillPath = join(sessionADir, "kernel-state.dill");
			const pyProc = Bun.spawnSync([resolvedPython, "-c", fixtureScript, dillPath]);
			expect(pyProc.exitCode).toBe(0);

			const switchHandler = registered.handlers.get("session_switch")?.[0];
			expect(switchHandler).toBeDefined();
			await switchHandler!({ type: "session_switch", reason: "resume" }, ctx("A", sessionADir));

			const revivalMessages = registered.sentMessages.filter(
				m => isMessagePayload(m.payload) && m.payload.customType === "rlm-revival",
			);
			expect(revivalMessages.length).toBe(1);
			const revivalContent = isMessagePayload(revivalMessages[0].payload)
				? (revivalMessages[0].payload.content ?? "")
				: "";
			expect(revivalContent).toContain("healthy_fixture");
			expect(revivalContent).toContain("bad_fixture");

			const resA = await tool.execute(
				"call-a",
				{ code: "print(healthy_fixture)" },
				undefined,
				undefined,
				ctx("A", sessionADir),
			);
			expect(resA.isError ?? false).toBe(false);
			expect(resA.content[0].text).toContain("42");

			await switchHandler!({ type: "session_switch", reason: "new" }, ctx("B", sessionBDir));

			const resB = await tool.execute(
				"call-b",
				{ code: "print('healthy_fixture' in globals())" },
				undefined,
				undefined,
				ctx("B", sessionBDir),
			);
			expect(resB.isError ?? false).toBe(false);
			expect(resB.content[0].text).toContain("False");
		} finally {
			if (shutdownFn) {
				await shutdownFn();
			}
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	}, 180_000);
});
