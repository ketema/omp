/**
 * RLM session-transition tests (SLICE-2) — real host-session lifecycle.
 *
 * CONTRACT AUTHORITY RECORD:
 * - Contract: contracts/rlm-session-isolation.contract.ts
 * - Clauses covered:
 *     POST-SESSION-PREFLUSH-1               typed flush boundary before the host copies artifacts; veto-safe; failure observable
 *     POST-SESSION-OWNED-DIR-1              kernel-state dir is exactly sessionManager.resolveOwnArtifactsDir()
 *     POST-SESSION-READINESS-1              the session's OWN background artifact copy settles before restore
 *     POST-SESSION-NO-OWNED-DIR-ISOLATION-1 no owned dir -> fresh isolated state, never an adopted/shared root
 *
 * Every session is a REAL coding-agent SessionManager; forks/branches go through the real
 * SessionManager.createBranchedSession + copySessionArtifacts provider, in the host's order
 * (before-hook awaited -> branch/copy -> after-event). Kernel ports are injected doubles in the
 * fixture tests; the real KernelManager / Python runner path is exercised where marked "real".
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

import { createRlmExtension, type RlmExtensionKernelPort } from "../src/extension.ts";
import {
	adoptedInMemorySession,
	adoptedPersistedSession,
	type HostContext,
	hostContext,
	isolateAgentDir,
	persistedSession,
	writeSnapshot,
} from "./host_session.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;

interface ToolRecord {
	readonly execute: (
		toolCallId: string,
		params: { code: string },
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

interface MessagePayload {
	readonly customType?: string;
	readonly content?: string;
}

interface Registry {
	readonly handlers: Map<string, Handler[]>;
	readonly messages: MessagePayload[];
	readonly tools: ToolRecord[];
}

function asMessagePayload(value: unknown): MessagePayload {
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		return {
			customType: typeof record.customType === "string" ? record.customType : undefined,
			content: typeof record.content === "string" ? record.content : undefined,
		};
	}
	return {};
}

function makeRegistry(flags: Record<string, string | boolean> = {}) {
	const registry: Registry = { handlers: new Map(), messages: [], tools: [] };
	const api = {
		registerTool(tool: ToolRecord) {
			registry.tools.push(tool);
		},
		registerFlag() {},
		registerCommand() {},
		on(event: string, handler: Handler) {
			const list = registry.handlers.get(event) ?? [];
			list.push(handler);
			registry.handlers.set(event, list);
		},
		getFlag(name: string) {
			return flags[name];
		},
		sendMessage(payload: unknown) {
			registry.messages.push(asMessagePayload(payload));
		},
	};
	return { api, registry };
}

async function emit(registry: Registry, type: string, event: object, ctx: unknown): Promise<unknown[]> {
	const results: unknown[] = [];
	for (const handler of registry.handlers.get(type) ?? []) {
		results.push(await handler({ type, ...event }, ctx));
	}
	return results;
}

function messagesOf(registry: Registry, customType: string): MessagePayload[] {
	return registry.messages.filter(m => m.customType === customType);
}

/** The directory a fallback warning announces (`... assigned: <dir>`), or undefined. */
function assignedDir(message: MessagePayload): string | undefined {
	return /assigned: (.+)$/.exec(message.content ?? "")?.[1]?.trim();
}

type FlushablePort = RlmExtensionKernelPort & { flushSnapshot(): Promise<void> };

interface PortState {
	disposed: boolean;
	flushCalls: number;
	executes: string[];
}

function makePort(options: { names?: string[]; flush?: () => Promise<void> } = {}) {
	const state: PortState = { disposed: false, flushCalls: 0, executes: [] };
	const port: FlushablePort = {
		async ensureStarted() {},
		async execute(code: string) {
			state.executes.push(code);
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
		async dispose() {
			state.disposed = true;
		},
		restoredNames() {
			return options.names ?? [];
		},
		restoredSkipped() {
			return [];
		},
		async flushSnapshot() {
			state.flushCalls++;
			await options.flush?.();
		},
		async onCompactionComplete() {},
		compactionNotice() {
			return null;
		},
	};
	return { port, state };
}

function realKernelFlags(root: string): Record<string, string> {
	const existingPython = join(process.env.HOME ?? "/Users/ketema", ".omp/agent/kernel-venv/bin/python");
	const flags: Record<string, string> = { OMP_RLM_AGENT_DIR: join(root, "agent") };
	if (fs.existsSync(existingPython)) flags.RLM_KERNEL_PYTHON = existingPython;
	return flags;
}

let root = "";
let restoreAgentDir: () => void = () => {};
let caseCounter = 0;

beforeAll(() => {
	root = fs.mkdtempSync(join("/tmp", "rlm-session-transition-"));
	restoreAgentDir = isolateAgentDir(root);
});

afterAll(() => {
	restoreAgentDir();
	fs.rmSync(root, { recursive: true, force: true });
});

/** A fresh per-test root inside the suite root (agent dir stays isolated for the whole suite). */
function caseRoot(label: string): string {
	caseCounter++;
	const dir = join(root, `${caseCounter}-${label}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

describe("POST-SESSION-PREFLUSH-1: typed pre-transition flush boundary", () => {
	test("flush runs through the typed port BEFORE the real host copies artifacts, and the kernel is not disposed on the cancellable hook", async () => {
		const dir = caseRoot("preflush-order");
		const a = await persistedSession(dir, "A");
		writeSnapshot(a.ownDir, "SEED");

		const kernelA = makePort({
			names: ["a_var"],
			flush: async () => {
				fs.writeFileSync(join(a.ownDir, "kernel-state.dill"), "FLUSHED");
			},
		});
		const kernelB = makePort({ names: ["a_var"] });
		let created = 0;
		const { api, registry } = makeRegistry();
		await createRlmExtension({
			createKernel() {
				created++;
				return created === 1 ? kernelA.port : kernelB.port;
			},
		})(api as never);

		const ctx = hostContext(dir, a.sm);
		await emit(registry, "session_start", {}, ctx);

		// Host order (agent-session.ts #branchIntoNewSession): before hook awaited -> branch/copy -> after event.
		await emit(registry, "session_before_branch", { reason: "fork", entryId: a.leafId }, ctx);
		const disposedAtCopy = kernelA.state.disposed;
		a.sm.createBranchedSession(a.leafId, { copyArtifacts: true });
		await emit(registry, "session_branch", { reason: "fork", previousSessionFile: `${a.ownDir}.jsonl` }, ctx);

		const branchedDir = await a.sm.resolveOwnArtifactsDir();
		expect(kernelA.state.flushCalls).toBe(1);
		expect(disposedAtCopy).toBe(false);
		expect(branchedDir).not.toBe(a.ownDir);
		expect(fs.readFileSync(join(branchedDir ?? "", "kernel-state.dill"), "utf8")).toBe("FLUSHED");
		await a.sm.close();
	});

	test("a failed flush is observable, never cancels the transition, and leaves the vetoed outgoing kernel usable", async () => {
		const dir = caseRoot("preflush-fail");
		const a = await persistedSession(dir, "A");
		writeSnapshot(a.ownDir, "SEED");

		const kernelA = makePort({
			flush: async () => {
				throw new Error("disk full during pre-transition flush");
			},
		});
		const { api, registry } = makeRegistry();
		await createRlmExtension({ createKernel: () => kernelA.port })(api as never);
		const ctx = hostContext(dir, a.sm);
		await emit(registry, "session_start", {}, ctx);

		// The host vetoes (or the transition otherwise never completes): no after-event follows.
		const results = await emit(registry, "session_before_switch", { reason: "new" }, ctx);

		const cancelled = results.some(r => typeof r === "object" && r !== null && "cancel" in r);
		expect(cancelled).toBe(false);
		expect(kernelA.state.disposed).toBe(false);
		const warnings = messagesOf(registry, "rlm-warning");
		expect(warnings.some(w => (w.content ?? "").includes("disk full during pre-transition flush"))).toBe(true);

		const res = await registry.tools[0].execute("c1", { code: "1+1" }, undefined, undefined, ctx);
		expect(res.isError ?? false).toBe(false);
		expect(kernelA.state.executes).toEqual(["1+1"]);
		await a.sm.close();
	});
});

describe("POST-SESSION-PREFLUSH-1: real KernelManager / runner flush ordering and veto safety", () => {
	test("real KernelManager.flushSnapshot commits live execution state before the real host copies artifacts on fork", async () => {
		const dir = caseRoot("real-flush-order");
		let shutdown: (() => Promise<unknown>) | null = null;
		const a = await persistedSession(dir, "A");
		try {
			const { api, registry } = makeRegistry(realKernelFlags(dir));
			await createRlmExtension()(api as never);
			const ctx = hostContext(dir, a.sm);
			shutdown = () => emit(registry, "session_shutdown", {}, ctx);

			await emit(registry, "session_start", {}, ctx);
			const tool = registry.tools[0];
			// Execute cell; within SNAPSHOT_DEBOUNCE_MS no snapshot has been written yet.
			const runRes = await tool.execute("c1", { code: "pre_fork_answer = 6 * 7" }, undefined, undefined, ctx);
			expect(runRes.isError ?? false).toBe(false);

			// Before-branch flushes immediately via KernelManager.flushSnapshot() before the copy.
			await emit(registry, "session_before_branch", { reason: "fork", entryId: a.leafId }, ctx);
			expect(fs.existsSync(join(a.ownDir, "kernel-state.dill"))).toBe(true);

			// Real host fork: background copy of A's artifacts into the branched session.
			a.sm.createBranchedSession(a.leafId, { copyArtifacts: true });
			await emit(registry, "session_branch", { reason: "fork", previousSessionFile: `${a.ownDir}.jsonl` }, ctx);

			// The branched session restored from the copy: variable must be live.
			const probe = await tool.execute("c2", { code: "print(pre_fork_answer)" }, undefined, undefined, ctx);
			expect(probe.isError ?? false).toBe(false);
			expect(probe.content[0].text).toContain("42");
		} finally {
			if (shutdown) await shutdown();
			await a.sm.close();
		}
	}, 180_000);

	test("vetoed transition leaves real outgoing kernel usable with preserved state", async () => {
		const dir = caseRoot("real-veto");
		let shutdown: (() => Promise<unknown>) | null = null;
		const a = await persistedSession(dir, "A");
		try {
			const { api, registry } = makeRegistry(realKernelFlags(dir));
			await createRlmExtension()(api as never);
			const ctx = hostContext(dir, a.sm);
			shutdown = () => emit(registry, "session_shutdown", {}, ctx);

			await emit(registry, "session_start", {}, ctx);
			const tool = registry.tools[0];
			await tool.execute("c1", { code: "state_token = 'veto_survivor'" }, undefined, undefined, ctx);

			// A before-hook fires, transition is vetoed (e.g. user aborts or another hook cancels): no after-event.
			await emit(registry, "session_before_switch", { reason: "fork" }, ctx);

			// The outgoing session remains in turn: subsequent execution still has state_token.
			const probe = await tool.execute("c2", { code: "print(state_token)" }, undefined, undefined, ctx);
			expect(probe.isError ?? false).toBe(false);
			expect(probe.content[0].text).toContain("veto_survivor");
		} finally {
			if (shutdown) await shutdown();
			await a.sm.close();
		}
	}, 180_000);
});

describe("POST-SESSION-OWNED-DIR-1 / POST-SESSION-READINESS-1: real session-owned directory and own-copy readiness", () => {
	test("an adopted child with its own session file uses its OWN directory: the adopted parent's snapshot is never loaded", async () => {
		const dir = caseRoot("owned-adopted");
		const parent = await persistedSession(dir, "parent");
		writeSnapshot(parent.ownDir, "PARENT_SNAPSHOT");
		const child = await adoptedPersistedSession(dir, "child", parent.sm);
		expect(child.sm.getArtifactsDir()).toBe(parent.ownDir);

		const kernel = makePort({ names: ["parent_var"] });
		const { api, registry } = makeRegistry();
		await createRlmExtension({ createKernel: () => kernel.port })(api as never);
		await emit(registry, "session_start", {}, hostContext(dir, child.sm));

		expect(
			messagesOf(registry, "rlm-revival").length,
			"POST-SESSION-OWNED-DIR-1 violation: the child restored from the adopted parent's directory",
		).toBe(0);
		expect(fs.readFileSync(join(parent.ownDir, "kernel-state.dill"), "utf8")).toBe("PARENT_SNAPSHOT");
		await child.sm.close();
		await parent.sm.close();
	});

	test("an adopted child's OWN background fork copy is awaited before its copied snapshot is probed and restored", async () => {
		const dir = caseRoot("readiness-adopted-fork");
		const parent = await persistedSession(dir, "parent");
		const child = await adoptedPersistedSession(dir, "child", parent.sm);
		writeSnapshot(child.ownDir, "CHILD_SNAPSHOT");

		const kernel = makePort({ names: ["child_var"] });
		const { api, registry } = makeRegistry();
		await createRlmExtension({ createKernel: () => kernel.port })(api as never);
		const ctx = hostContext(dir, child.sm);

		// Real host branch: the copy into the branched child's own directory runs in the background,
		// and the adopted manager's readiness (parent's) says nothing about it.
		child.sm.createBranchedSession(child.leafId, { copyArtifacts: true });
		await emit(registry, "session_branch", { reason: "branch", previousSessionFile: `${child.ownDir}.jsonl` }, ctx);

		const revivals = messagesOf(registry, "rlm-revival");
		expect(
			revivals.length,
			"POST-SESSION-READINESS-1 violation: probed the branched child's directory before its own background copy settled",
		).toBe(1);
		expect(revivals[0].content ?? "").toContain("child_var");
		expect(fs.existsSync(join(parent.ownDir, "kernel-state.dill"))).toBe(false);
		await child.sm.close();
		await parent.sm.close();
	});
});

describe("POST-SESSION-NO-OWNED-DIR-ISOLATION-1: no session-owned directory -> fresh isolated state", () => {
	test("adopted in-memory sessions A and B sharing a parent root never restore the parent's state and get distinct isolated dirs", async () => {
		const dir = caseRoot("no-file-adopted");
		const parent = await persistedSession(dir, "parent");
		writeSnapshot(parent.ownDir, "PARENT_SNAPSHOT");
		const a = adoptedInMemorySession(dir, parent.sm);
		const b = adoptedInMemorySession(dir, parent.sm);
		expect(a.getArtifactsDir()).toBe(parent.ownDir);
		expect(b.getArtifactsDir()).toBe(parent.ownDir);
		expect(a.getSessionId()).not.toBe(b.getSessionId());

		const kernel = makePort({ names: ["parent_var"] });
		const { api, registry } = makeRegistry();
		await createRlmExtension({ createKernel: () => kernel.port })(api as never);

		const ctxA = hostContext(dir, a);
		const ctxB = hostContext(dir, b);
		await emit(registry, "session_start", {}, ctxA);
		expect(
			messagesOf(registry, "rlm-warning"),
			"POST-SESSION-NO-SIDE-EFFECT-1 violation: a lifecycle event announced a fallback before any kernel existed",
		).toEqual([]);
		// The isolated directory is allocated and announced when each session's kernel is first constructed.
		await registry.tools[0].execute("a1", { code: "a = 1" }, undefined, undefined, ctxA);
		await emit(registry, "session_switch", { reason: "new", previousSessionFile: undefined }, ctxB);
		await registry.tools[0].execute("b1", { code: "b = 1" }, undefined, undefined, ctxB);

		expect(
			messagesOf(registry, "rlm-revival").length,
			"POST-SESSION-NO-OWNED-DIR-ISOLATION-1 violation: a session without a session file restored the adopted parent root's snapshot",
		).toBe(0);
		const isolated = messagesOf(registry, "rlm-warning").map(assignedDir);
		expect(isolated.length).toBe(2);
		const [dirA, dirB] = isolated;
		expect(dirA).toBeDefined();
		expect(dirB).toBeDefined();
		expect(dirA).not.toBe(dirB);
		expect(dirA).not.toBe(parent.ownDir);
		expect(dirB).not.toBe(parent.ownDir);
		expect(dirA?.startsWith(join(dir, "project", ".omp", "artifacts", "isolated-"))).toBe(true);
		expect(dirB?.startsWith(join(dir, "project", ".omp", "artifacts", "isolated-"))).toBe(true);
		await a.close();
		await b.close();
		await parent.sm.close();
	});

	test("real: adopted in-memory session B never sees adopted in-memory session A's variable, and the parent root is never written", async () => {
		const dir = caseRoot("no-file-adopted-real");
		let shutdown: (() => Promise<unknown>) | null = null;
		const parent = await persistedSession(dir, "parent");
		const a = adoptedInMemorySession(dir, parent.sm);
		const b = adoptedInMemorySession(dir, parent.sm);
		try {
			const { api, registry } = makeRegistry(realKernelFlags(dir));
			await createRlmExtension()(api as never);
			const ctxA: HostContext = hostContext(dir, a);
			const ctxB: HostContext = hostContext(dir, b);
			shutdown = () => emit(registry, "session_shutdown", {}, ctxB);
			const tool = registry.tools[0];

			await emit(registry, "session_start", {}, ctxA);
			const setA = await tool.execute("a1", { code: "bleed_marker = 41" }, undefined, undefined, ctxA);
			expect(setA.isError ?? false).toBe(false);

			await emit(registry, "session_before_switch", { reason: "new" }, ctxA);
			await emit(registry, "session_switch", { reason: "new", previousSessionFile: undefined }, ctxB);

			const probeB = await tool.execute(
				"b1",
				{ code: "print('bleed_marker' in globals())" },
				undefined,
				undefined,
				ctxB,
			);
			expect(probeB.isError ?? false).toBe(false);
			expect(
				probeB.content[0].text,
				"POST-SESSION-NO-OWNED-DIR-ISOLATION-1 violation: session B restored session A's variable",
			).toContain("False");
			expect(
				fs.existsSync(join(parent.ownDir, "kernel-state.dill")),
				"POST-SESSION-NO-OWNED-DIR-ISOLATION-1 violation: kernel state was written into the adopted parent's directory",
			).toBe(false);
		} finally {
			if (shutdown) await shutdown();
			await a.close();
			await b.close();
			await parent.sm.close();
		}
	}, 180_000);

	test("a host sessionManager without resolveOwnArtifactsDir gets fresh isolated state; getArtifactsDir()/getSessionFile() are never trusted", async () => {
		const dir = caseRoot("no-accessor");
		const sessionFile = join(dir, "sessions", "legacy.jsonl");
		const fileDerivedDir = join(dir, "sessions", "legacy");
		writeSnapshot(fileDerivedDir, "LEGACY_HOST_SNAPSHOT");
		// A host surface that predates the ownership/readiness accessor.
		const legacySessionManager = {
			getSessionFile: () => sessionFile,
			getArtifactsDir: () => fileDerivedDir,
			getSessionId: () => "legacy",
		};

		const kernel = makePort({ names: ["legacy_var"] });
		const { api, registry } = makeRegistry();
		await createRlmExtension({ createKernel: () => kernel.port })(api as never);
		const legacyCtx = { cwd: join(dir, "project"), sessionManager: legacySessionManager };
		await emit(registry, "session_start", {}, legacyCtx);
		expect(messagesOf(registry, "rlm-warning"), "no announcement before a kernel exists").toEqual([]);
		await registry.tools[0].execute("l1", { code: "l = 1" }, undefined, undefined, legacyCtx);

		expect(
			messagesOf(registry, "rlm-revival").length,
			"POST-SESSION-NO-OWNED-DIR-ISOLATION-1 violation: restored without an established owned directory and copy readiness",
		).toBe(0);
		const warnings = messagesOf(registry, "rlm-warning");
		expect(warnings.length).toBe(1);
		expect(warnings[0].content ?? "").toContain("resolveOwnArtifactsDir");
		expect(assignedDir(warnings[0])?.startsWith(join(dir, "project", ".omp", "artifacts", "isolated-"))).toBe(true);
	});
});

describe("POST-SESSION-RESOLUTION-GATE-1: no kernel is constructed against an unresolved or stale directory", () => {
	function recordingKernels() {
		const created: Array<{ dir: string; state: PortState }> = [];
		const createKernel = (_config: unknown, artifactsDir: string) => {
			const { port, state } = makePort({ names: ["restored_var"] });
			created.push({ dir: artifactsDir, state });
			return port;
		};
		return { created, createKernel };
	}

	test("a kernel first used before any lifecycle event is built in an isolated fallback dir, never a cwd-relative shared path", async () => {
		const dir = caseRoot("gate-no-lifecycle");
		const cwd = join(dir, "process-cwd");
		fs.mkdirSync(cwd, { recursive: true });
		const previousCwd = process.cwd();
		process.chdir(cwd);
		try {
			const { created, createKernel } = recordingKernels();
			const { api, registry } = makeRegistry();
			await createRlmExtension({ createKernel })(api as never);

			const res = await registry.tools[0].execute("c1", { code: "1+1" }, undefined, undefined, undefined);
			expect(res.isError ?? false).toBe(false);

			expect(created.length).toBe(1);
			const kernelDir = created[0].dir;
			expect(
				typeof kernelDir === "string" &&
					kernelDir.startsWith(join(fs.realpathSync(cwd), ".omp", "artifacts", "isolated-")),
				`POST-SESSION-RESOLUTION-GATE-1 violation: kernel built against an unresolved directory (${String(kernelDir)})`,
			).toBe(true);
			const warnings = messagesOf(registry, "rlm-warning");
			expect(warnings.length).toBe(1);
			expect(assignedDir(warnings[0])).toBe(kernelDir);
		} finally {
			process.chdir(previousCwd);
		}
	});

	test("kernel use during an in-flight branch waits for the incoming session's resolution and builds exactly one kernel there", async () => {
		const dir = caseRoot("gate-in-flight-branch");
		const a = await persistedSession(dir, "A");
		// A has a snapshot on disk but no live kernel, so the branch has nothing to dispose.
		writeSnapshot(a.ownDir, "A_SNAPSHOT");
		const { created, createKernel } = recordingKernels();
		const { api, registry } = makeRegistry();
		await createRlmExtension({ createKernel })(api as never);
		const ctx = hostContext(dir, a.sm);

		a.sm.createBranchedSession(a.leafId, { copyArtifacts: true });
		// The host fires the after-event; a tool call lands while the handler is still resolving.
		const branching = emit(
			registry,
			"session_branch",
			{ reason: "fork", previousSessionFile: `${a.ownDir}.jsonl` },
			ctx,
		);
		const executing = registry.tools[0].execute("c1", { code: "x = 1" }, undefined, undefined, ctx);
		await Promise.all([branching, executing]);

		const branchedDir = await a.sm.resolveOwnArtifactsDir();
		expect(
			created.map(c => c.dir),
			"POST-SESSION-RESOLUTION-GATE-1 violation: a kernel was built against the previous session's directory, or more than once",
		).toEqual([branchedDir ?? "missing"]);
		expect(created[0].state.executes).toEqual(["x = 1"]);
		await a.sm.close();
	});

	test("a transition awaits an in-flight kernel construction and disposes it before resolving the next session", async () => {
		const dir = caseRoot("gate-back-to-back");
		const a = await persistedSession(dir, "A");
		const b = await persistedSession(dir, "B");
		const c = await persistedSession(dir, "C");
		const { created, createKernel } = recordingKernels();
		const { api, registry } = makeRegistry();
		await createRlmExtension({ createKernel })(api as never);
		await emit(registry, "session_start", {}, hostContext(dir, a.sm));

		const toB = emit(
			registry,
			"session_switch",
			{ reason: "new", previousSessionFile: undefined },
			hostContext(dir, b.sm),
		);
		const execB = registry.tools[0].execute("b1", { code: "in_b = 1" }, undefined, undefined, hostContext(dir, b.sm));
		const toC = emit(
			registry,
			"session_switch",
			{ reason: "new", previousSessionFile: undefined },
			hostContext(dir, c.sm),
		);
		await Promise.all([toB, execB, toC]);
		const execC = await registry.tools[0].execute(
			"c1",
			{ code: "in_c = 1" },
			undefined,
			undefined,
			hostContext(dir, c.sm),
		);
		expect(execC.isError ?? false).toBe(false);

		expect(
			created.map(k => k.dir),
			"POST-SESSION-RESOLUTION-GATE-1 violation: kernels must be built for B then C, each against its own directory",
		).toEqual([b.ownDir, c.ownDir]);
		expect(created[0].state.disposed, "the in-flight B kernel must be disposed by the switch to C").toBe(true);
		expect(created[1].state.disposed, "C's kernel must survive into session C").toBe(false);
		// POST-TOOL-SESSION-BINDING-1: B's cell raced the switch to C. Permitted outcomes are exhaustive and
		// correlated with its tool result: it ran on B's own kernel (O1), or it aborted and reached NO kernel (O2).
		// It is never both, and never on C's kernel.
		const resB = await execB;
		const executedOnB = created[0].state.executes.includes("in_b = 1");
		expect(resB.isError ?? false, "B's result must match where (and whether) its cell ran").toBe(!executedOnB);
		expect(created[0].state.executes).toEqual(executedOnB ? ["in_b = 1"] : []);
		// C's kernel sees exactly the cell issued in C: no old cell code ever executes in the incoming namespace.
		expect(created[1].state.executes).toEqual(["in_c = 1"]);
		await a.sm.close();
		await b.sm.close();
		await c.sm.close();
	});
});
