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
 *     POST-SESSION-ISOLATION-1: Resolves artifactsDir from the real session's own directory
 *     POST-SESSION-FALLBACK-ISOLATION-1: Missing session context falls back to isolated atomic dir
 *     ERRORS-SESSION-SWITCH-DISPOSE-1: Emits observable warning on outgoing kernel teardownNotice/disposal failure
 *     POST-TRANS-SKIPPED-WIRE-PROPAGATION-1: Authentic KernelTransport stdio wire frames propagate skipped unpicklables
 *     FORBIDDEN-CROSS-SESSION-BLEED-1: Prohibits loading snapshots from shared root
 *     IP-5: Delivers partitioned artifactsDir to kernel initialization
 *
 * Session identity comes from REAL coding-agent SessionManager instances (./host_session.ts);
 * no test hand-writes getArtifactsDir()/getSessionFile() getters.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

import { createRlmExtension, type RlmExtensionKernelPort } from "../src/extension.ts";
import { KernelManager } from "../src/kernel.ts";
import { createTransport, type RlmTransportProcess } from "../src/transport.ts";
import {
	adoptedPersistedSession,
	hostContext,
	isolateAgentDir,
	persistedSession,
	writeSnapshot,
} from "./host_session.ts";

let suiteRoot = "";
let restoreAgentDir: () => void = () => {};

beforeAll(() => {
	suiteRoot = fs.mkdtempSync("/tmp/rlm-session-iso-suite-");
	restoreAgentDir = isolateAgentDir(suiteRoot);
});

afterAll(() => {
	restoreAgentDir();
	fs.rmSync(suiteRoot, { recursive: true, force: true });
});

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
		async flushSnapshot() {
			calls.push({ kind: "flushSnapshot", detail: "" });
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
	test("POST-SESSION-ISOLATION-1 / FORBIDDEN-CROSS-SESSION-BLEED-1: a fresh real session never restores a shared unpartitioned root snapshot (F2/F6)", async () => {
		const tempRoot = fs.mkdtempSync(join(suiteRoot, "fresh-"));
		const session = await persistedSession(tempRoot, "alpha");
		try {
			// A stale snapshot in the shared, unpartitioned <cwd>/.omp/artifacts root.
			writeSnapshot(join(tempRoot, "project", ".omp", "artifacts"), "STALE_PRIOR_SESSION_DATA");
			const kernel = makeKernelPort({ restoredNames: ["stale_leaked_var"] });
			const { api, registered } = makeApi();
			await createRlmExtension({ createKernel: () => kernel.port })(api as never);

			await registered.handlers.get("session_start")![0](
				{ type: "session_start" },
				hostContext(tempRoot, session.sm),
			);

			const revivals = registered.sentMessages.filter(
				m => isMessagePayload(m.payload) && m.payload.customType === "rlm-revival",
			);
			expect(revivals.length, "FORBIDDEN-CROSS-SESSION-BLEED-1 violation: restored the shared root snapshot").toBe(
				0,
			);
		} finally {
			await session.sm.close();
		}
	});

	test("POST-SESSION-ISOLATION-1: a real session with a snapshot in its own directory revives and surfaces skipped warnings (F5)", async () => {
		const tempRoot = fs.mkdtempSync(join(suiteRoot, "revive-"));
		const session = await persistedSession(tempRoot, "beta");
		try {
			writeSnapshot(session.ownDir, "VALID_SESSION_SNAPSHOT");
			const kernel = makeKernelPort({
				restoredNames: ["valid_var"],
				restoredSkipped: [{ name: "broken_var", reason: "missing module" }],
			});
			const { api, registered } = makeApi();
			await createRlmExtension({ createKernel: () => kernel.port })(api as never);

			await registered.handlers.get("session_start")![0](
				{ type: "session_start" },
				hostContext(tempRoot, session.sm),
			);

			const revivals = registered.sentMessages.filter(
				m => isMessagePayload(m.payload) && m.payload.customType === "rlm-revival",
			);
			expect(revivals.length).toBe(1);
			const content = isMessagePayload(revivals[0].payload) ? (revivals[0].payload.content ?? "") : "";
			expect(content).toContain("valid_var");
			expect(content).toContain("Warning: The following unpicklable variables were skipped: broken_var");
		} finally {
			await session.sm.close();
		}
	});

	test("POST-SESSION-ISOLATION-1: session_switch disposes the outgoing kernel and re-resolves storage for the new real session (Comment 4366356325)", async () => {
		const tempRoot = fs.mkdtempSync(join(suiteRoot, "switch-"));
		const a = await persistedSession(tempRoot, "A");
		const b = await persistedSession(tempRoot, "B");
		try {
			writeSnapshot(a.ownDir, "SNAPSHOT_A");
			writeSnapshot(b.ownDir, "SNAPSHOT_B");
			const kernelA = makeKernelPort({ restoredNames: ["var_from_session_A"] });
			const kernelB = makeKernelPort({ restoredNames: ["var_from_session_B"] });
			let createCallCount = 0;
			const { api, registered } = makeApi();
			await createRlmExtension({
				createKernel() {
					createCallCount++;
					return createCallCount === 1 ? kernelA.port : kernelB.port;
				},
			})(api as never);

			await registered.handlers.get("session_start")![0]({ type: "session_start" }, hostContext(tempRoot, a.sm));
			expect(kernelA.wasStarted()).toBe(true);
			expect(kernelA.wasDisposed()).toBe(false);

			await registered.handlers.get("session_switch")![0](
				{ type: "session_switch", reason: "resume", previousSessionFile: `${a.ownDir}.jsonl` },
				hostContext(tempRoot, b.sm),
			);

			expect(kernelA.wasDisposed()).toBe(true);
			expect(kernelB.wasStarted()).toBe(true);
			const revivals = registered.sentMessages.filter(
				m => isMessagePayload(m.payload) && m.payload.customType === "rlm-revival",
			);
			expect(revivals.length).toBe(2);
			const content = isMessagePayload(revivals[1].payload) ? (revivals[1].payload.content ?? "") : "";
			expect(content).toContain("var_from_session_B");
		} finally {
			await a.sm.close();
			await b.sm.close();
		}
	});

	test("POST-SESSION-ISOLATION-1: a real subagent that adopted its parent's artifact manager never restores the parent's snapshot (Comment 4369713118)", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [✓] C1 VALID: cites POST-SESSION-ISOLATION-1 / POST-SESSION-OWNED-DIR-1
		 *   [✓] C2 VALUABLE: the parent root HAS a snapshot and the child's own dir has NONE, so any
		 *       resolution through getArtifactsDir() (the adopted parent root) produces a revival and fails.
		 *   [✓] C3 NON-DUPLICATIVE: real SessionManager.adoptArtifactManager subagent shape
		 *   [✓] C4 NOT FUTURE-EDIT: exercises real adoption, not a hand-written getter
		 */
		const tempRoot = fs.mkdtempSync(join(suiteRoot, "adopted-"));
		const parent = await persistedSession(tempRoot, "parent");
		const child = await adoptedPersistedSession(tempRoot, "child", parent.sm);
		try {
			writeSnapshot(parent.ownDir, "PARENT_STATE");
			expect(child.sm.getArtifactsDir()).toBe(parent.ownDir);
			const kernel = makeKernelPort({ restoredNames: ["parent_var"] });
			const { api, registered } = makeApi();
			await createRlmExtension({ createKernel: () => kernel.port })(api as never);

			await registered.handlers.get("session_start")![0]({ type: "session_start" }, hostContext(tempRoot, child.sm));

			const revivals = registered.sentMessages.filter(
				m => isMessagePayload(m.payload) && m.payload.customType === "rlm-revival",
			);
			expect(revivals.length, "POST-SESSION-ISOLATION-1 violation: subagent restored its parent's snapshot").toBe(0);
		} finally {
			await child.sm.close();
			await parent.sm.close();
		}
	});

	test("POST-SESSION-ISOLATION-1: session_before_branch / session_branch bind real branch transitions and dispose the outgoing kernel (Comment 4369713122 / 4369713144)", async () => {
		const tempRoot = fs.mkdtempSync(join(suiteRoot, "branch-"));
		const a = await persistedSession(tempRoot, "A");
		try {
			writeSnapshot(a.ownDir, "SNAPSHOT_A");
			const kernelA = makeKernelPort({ restoredNames: ["branch_a_var"] });
			const kernelB = makeKernelPort({ restoredNames: ["branch_b_var"] });
			let createCallCount = 0;
			const { api, registered } = makeApi();
			await createRlmExtension({
				createKernel() {
					createCallCount++;
					return createCallCount === 1 ? kernelA.port : kernelB.port;
				},
			})(api as never);
			expect(registered.handlers.get("session_branch")?.length).toBeGreaterThan(0);
			expect(registered.handlers.get("session_before_branch")?.length).toBeGreaterThan(0);

			const ctx = hostContext(tempRoot, a.sm);
			await registered.handlers.get("session_start")![0]({ type: "session_start" }, ctx);
			await registered.handlers.get("session_before_branch")![0](
				{ type: "session_before_branch", reason: "branch", entryId: a.leafId },
				ctx,
			);
			a.sm.createBranchedSession(a.leafId, { copyArtifacts: true });
			await registered.handlers.get("session_branch")![0](
				{ type: "session_branch", reason: "branch", previousSessionFile: `${a.ownDir}.jsonl` },
				ctx,
			);

			expect(kernelA.wasDisposed()).toBe(true);
			expect(kernelB.wasStarted(), "the branched session must restore its copied snapshot").toBe(true);
		} finally {
			await a.sm.close();
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
			// POST-SESSION-NO-SIDE-EFFECT-1: nothing is allocated or announced by the lifecycle event itself.
			expect(reg1.sentMessages.length).toBe(0);
			expect(reg2.sentMessages.length).toBe(0);
			// The isolated directory is allocated when each session's kernel is first constructed.
			const idleCtx = { hasUI: false, setWorkingMessage() {}, ui: { select: async () => undefined } };
			await reg1.tools[0].execute("f1", { code: "a = 1" }, undefined, undefined, idleCtx);
			await reg2.tools[0].execute("f2", { code: "a = 1" }, undefined, undefined, idleCtx);

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
		const tempRoot = fs.mkdtempSync(join(suiteRoot, "teardown-"));
		const a = await persistedSession(tempRoot, "A");
		const b = await persistedSession(tempRoot, "B");
		try {
			writeSnapshot(a.ownDir, "SNAPSHOT_A");
			const kernelA = makeKernelPort({
				teardownNotice: "snapshot flush failed during dispose: disk full on snapshot save",
			});
			const kernelB = makeKernelPort();
			let createCallCount = 0;
			const { api, registered } = makeApi();
			await createRlmExtension({
				createKernel() {
					createCallCount++;
					return createCallCount === 1 ? kernelA.port : kernelB.port;
				},
			})(api as never);

			await registered.handlers.get("session_start")![0]({ type: "session_start" }, hostContext(tempRoot, a.sm));
			await registered.handlers.get("session_switch")![0](
				{ type: "session_switch", reason: "new", previousSessionFile: `${a.ownDir}.jsonl` },
				hostContext(tempRoot, b.sm),
			);

			const warnings = registered.sentMessages.filter(
				m => isMessagePayload(m.payload) && m.payload.customType === "rlm-warning",
			);
			expect(
				warnings.some(
					w => isMessagePayload(w.payload) && (w.payload.content ?? "").includes("disk full on snapshot save"),
				),
				"ERRORS-SESSION-SWITCH-DISPOSE-1 violation: the teardown notice was not surfaced",
			).toBe(true);
		} finally {
			await a.sm.close();
			await b.sm.close();
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
		const tempRoot = fs.mkdtempSync(join(suiteRoot, "true-default-path-"));
		let shutdownFn: (() => Promise<unknown>) | null = null;
		const seed = await persistedSession(tempRoot, "seed");
		const sessionA = await persistedSession(tempRoot, "A");
		const sessionB = await persistedSession(tempRoot, "B");
		try {
			const sessionADir = sessionA.ownDir;
			fs.mkdirSync(sessionADir, { recursive: true });

			const flags: Record<string, string> = {
				OMP_RLM_AGENT_DIR: join(tempRoot, "agent"),
			};
			// RLM_TEST_PYTHON: an existing interpreter with dill + rlm; unset means the managed kernel venv is bootstrapped.
			if (process.env.RLM_TEST_PYTHON) flags.RLM_KERNEL_PYTHON = process.env.RLM_TEST_PYTHON;

			const { api, registered } = makeApi({ flags });
			const factory = createRlmExtension();
			await factory(api as never);

			shutdownFn = async () => {
				const handler = registered.handlers.get("session_shutdown")?.[0];
				if (handler) {
					await handler({});
				}
			};

			const sessions = { seed: seed.sm, A: sessionA.sm, B: sessionB.sm };
			const ctx = (id: keyof typeof sessions) => hostContext(tempRoot, sessions[id]);

			const startHandler = registered.handlers.get("session_start")?.[0];
			expect(startHandler).toBeDefined();

			await startHandler!({ type: "session_start" }, ctx("seed"));
			const tool = registered.tools[0];
			expect(tool).toBeDefined();

			const seedResult = await tool.execute(
				"seed-1",
				{ code: "import sys; print('RLM_TEST_PYTHON=' + sys.executable)" },
				undefined,
				undefined,
				ctx("seed"),
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
			await switchHandler!({ type: "session_switch", reason: "resume" }, ctx("A"));

			const revivalMessages = registered.sentMessages.filter(
				m => isMessagePayload(m.payload) && m.payload.customType === "rlm-revival",
			);
			expect(revivalMessages.length).toBe(1);
			const revivalContent = isMessagePayload(revivalMessages[0].payload)
				? (revivalMessages[0].payload.content ?? "")
				: "";
			expect(revivalContent).toContain("healthy_fixture");
			expect(revivalContent).toContain("bad_fixture");

			const resA = await tool.execute("call-a", { code: "print(healthy_fixture)" }, undefined, undefined, ctx("A"));
			expect(resA.isError ?? false).toBe(false);
			expect(resA.content[0].text).toContain("42");

			await switchHandler!({ type: "session_switch", reason: "new" }, ctx("B"));

			const resB = await tool.execute(
				"call-b",
				{ code: "print('healthy_fixture' in globals())" },
				undefined,
				undefined,
				ctx("B"),
			);
			expect(resB.isError ?? false).toBe(false);
			expect(resB.content[0].text).toContain("False");
		} finally {
			if (shutdownFn) {
				await shutdownFn();
			}
			await seed.sm.close();
			await sessionA.sm.close();
			await sessionB.sm.close();
		}
	}, 180_000);
});
