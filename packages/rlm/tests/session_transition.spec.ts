/**
 * RLM session-transition tests (SLICE-2) — typed host-lifecycle harness.
 *
 * CONTRACT AUTHORITY RECORD:
 * - Contract: contracts/rlm-session-isolation.contract.ts
 * - Clauses covered:
 *     POST-SESSION-PREFLUSH-1   typed flush boundary before the host copies artifacts; veto-safe; failure observable
 *     POST-SESSION-OWNED-DIR-1  session-owned directory from the session file, no substring heuristic
 *     POST-SESSION-READINESS-1  await the host's pending artifact copy before probing the incoming snapshot
 *
 * COVERAGE LIMITS (stated, not hidden):
 * - The host here is a TYPED FIXTURE reproducing the lifecycle ORDER and the session-manager shapes of
 *   packages/coding-agent (before hook awaited -> artifacts copied -> after event). The real SessionManager /
 *   ArtifactManager cannot be imported locally because @oh-my-pi/pi-natives has no darwin-arm64 addon in this
 *   worktree. Real-host integration is therefore NOT verified by these tests.
 * - The kernel is a fake port in the fixture tests; the real KernelManager/runner path is covered separately.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

import { createRlmExtension, type RlmExtensionKernelPort } from "../src/extension.ts";

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

interface ArtifactManagerShape {
	readonly dir: string;
	listFiles(): Promise<string[]>;
}

interface SessionManagerShape {
	getSessionFile?: () => string | undefined;
	getArtifactsDir?: () => string | null;
	getSessionId?: () => string;
	getArtifactManager?: () => ArtifactManagerShape | null;
}

interface HostContext {
	readonly cwd: string;
	readonly sessionManager: SessionManagerShape;
	readonly hasUI: boolean;
	setWorkingMessage(): void;
	readonly ui: { select(): Promise<undefined> };
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

async function emit(registry: Registry, type: string, event: object, ctx: HostContext): Promise<unknown[]> {
	const results: unknown[] = [];
	for (const handler of registry.handlers.get(type) ?? []) {
		results.push(await handler({ type, ...event }, ctx));
	}
	return results;
}

function hostContext(root: string, sessionManager: SessionManagerShape): HostContext {
	return {
		cwd: root,
		sessionManager,
		hasUI: false,
		setWorkingMessage() {},
		ui: { async select() {} },
	};
}

/** A non-adopted session: getArtifactsDir() IS the session-owned dir (artifactsDirectoryFor(sessionFile)). */
function ownedSession(sessionFile: string, id: string): SessionManagerShape {
	const owned = sessionFile.slice(0, -".jsonl".length);
	return { getSessionFile: () => sessionFile, getArtifactsDir: () => owned, getSessionId: () => id };
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

function scratch(prefix: string): string {
	return fs.mkdtempSync(join("/tmp", prefix));
}

describe("POST-SESSION-PREFLUSH-1: typed pre-transition flush boundary", () => {
	test("flush runs through the typed port BEFORE the host copies artifacts, and the kernel is not disposed on the cancellable hook", async () => {
		const root = scratch("rlm-preflush-order-");
		try {
			const sessionsDir = join(root, "sessions");
			const dirA = join(sessionsDir, "A");
			const dirB = join(sessionsDir, "B");
			fs.mkdirSync(dirA, { recursive: true });
			fs.writeFileSync(join(dirA, "kernel-state.dill"), "SEED");

			const kernelA = makePort({
				names: ["a_var"],
				flush: async () => {
					fs.writeFileSync(join(dirA, "kernel-state.dill"), "FLUSHED");
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

			const ctxA = hostContext(root, ownedSession(join(sessionsDir, "A.jsonl"), "A"));
			const ctxB = hostContext(root, ownedSession(join(sessionsDir, "B.jsonl"), "B"));
			await emit(registry, "session_start", {}, ctxA);

			// Host order (agent-session.ts #branchIntoNewSession): before hook awaited -> copy -> after event.
			await emit(registry, "session_before_branch", { reason: "fork", entryId: "e1" }, ctxA);
			const disposedAtCopy = kernelA.state.disposed;
			fs.cpSync(dirA, dirB, { recursive: true });
			await emit(registry, "session_branch", { reason: "fork", previousSessionFile: "A.jsonl" }, ctxB);

			expect(kernelA.state.flushCalls).toBe(1);
			expect(disposedAtCopy).toBe(false);
			expect(fs.readFileSync(join(dirB, "kernel-state.dill"), "utf8")).toBe("FLUSHED");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("a failed flush is observable, never cancels the transition, and leaves the vetoed outgoing kernel usable", async () => {
		const root = scratch("rlm-preflush-fail-");
		try {
			const sessionsDir = join(root, "sessions");
			const dirA = join(sessionsDir, "A");
			fs.mkdirSync(dirA, { recursive: true });
			fs.writeFileSync(join(dirA, "kernel-state.dill"), "SEED");

			const kernelA = makePort({
				flush: async () => {
					throw new Error("disk full during pre-transition flush");
				},
			});
			const { api, registry } = makeRegistry();
			await createRlmExtension({ createKernel: () => kernelA.port })(api as never);
			const ctxA = hostContext(root, ownedSession(join(sessionsDir, "A.jsonl"), "A"));
			await emit(registry, "session_start", {}, ctxA);

			// The host vetoes (or the transition otherwise never completes): no after-event follows.
			const results = await emit(registry, "session_before_switch", { reason: "new" }, ctxA);

			const cancelled = results.some(r => typeof r === "object" && r !== null && "cancel" in r);
			expect(cancelled).toBe(false);
			expect(kernelA.state.disposed).toBe(false);
			const warnings = registry.messages.filter(m => m.customType === "rlm-warning");
			expect(warnings.some(w => (w.content ?? "").includes("disk full during pre-transition flush"))).toBe(true);

			const res = await registry.tools[0].execute("c1", { code: "1+1" }, undefined, undefined, ctxA);
			expect(res.isError ?? false).toBe(false);
			expect(kernelA.state.executes).toEqual(["1+1"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("POST-SESSION-PREFLUSH-1: real KernelManager / runner flush ordering and veto safety", () => {
	test("real KernelManager.flushSnapshot commits live execution state before the host copies artifacts on fork", async () => {
		const root = scratch("rlm-real-flush-order-");
		let shutdown: (() => Promise<unknown>) | null = null;
		try {
			const existingPython = join(process.env.HOME ?? "/Users/ketema", ".omp/agent/kernel-venv/bin/python");
			const flags: Record<string, string> = { OMP_RLM_AGENT_DIR: join(root, "agent") };
			if (fs.existsSync(existingPython)) flags.RLM_KERNEL_PYTHON = existingPython;

			const { api, registry } = makeRegistry(flags);
			await createRlmExtension()(api as never);
			shutdown = async () => {
				await emit(
					registry,
					"session_shutdown",
					{},
					hostContext(root, ownedSession(join(root, "shutdown.jsonl"), "s")),
				);
			};

			const sessionsDir = join(root, "sessions");
			const dirA = join(sessionsDir, "A");
			const dirB = join(sessionsDir, "B");
			fs.mkdirSync(dirA, { recursive: true });
			fs.mkdirSync(dirB, { recursive: true });
			const ctxA = hostContext(root, ownedSession(join(sessionsDir, "A.jsonl"), "A"));
			const ctxB = hostContext(root, ownedSession(join(sessionsDir, "B.jsonl"), "B"));

			await emit(registry, "session_start", {}, ctxA);
			const tool = registry.tools[0];
			// Execute cell; within SNAPSHOT_DEBOUNCE_MS no snapshot has been written yet.
			const runRes = await tool.execute("c1", { code: "pre_fork_answer = 6 * 7" }, undefined, undefined, ctxA);
			expect(runRes.isError ?? false).toBe(false);

			// Before-branch flushes immediately via KernelManager.flushSnapshot() before copy.
			await emit(registry, "session_before_branch", { reason: "fork", entryId: "e1" }, ctxA);
			expect(fs.existsSync(join(dirA, "kernel-state.dill"))).toBe(true);

			// Host copies session A's directory into session B.
			fs.cpSync(dirA, dirB, { recursive: true });
			await emit(registry, "session_branch", { reason: "fork", previousSessionFile: "A.jsonl" }, ctxB);

			// Session B restored from the copy: variable must be live.
			const probe = await tool.execute("c2", { code: "print(pre_fork_answer)" }, undefined, undefined, ctxB);
			expect(probe.isError ?? false).toBe(false);
			expect(probe.content[0].text).toContain("42");
		} finally {
			if (shutdown) await shutdown();
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 180_000);

	test("vetoed transition leaves real outgoing kernel usable with preserved state", async () => {
		const root = scratch("rlm-real-veto-");
		let shutdown: (() => Promise<unknown>) | null = null;
		try {
			const existingPython = join(process.env.HOME ?? "/Users/ketema", ".omp/agent/kernel-venv/bin/python");
			const flags: Record<string, string> = { OMP_RLM_AGENT_DIR: join(root, "agent") };
			if (fs.existsSync(existingPython)) flags.RLM_KERNEL_PYTHON = existingPython;

			const { api, registry } = makeRegistry(flags);
			await createRlmExtension()(api as never);
			shutdown = async () => {
				await emit(
					registry,
					"session_shutdown",
					{},
					hostContext(root, ownedSession(join(root, "shutdown.jsonl"), "s")),
				);
			};

			const sessionsDir = join(root, "sessions");
			const dirA = join(sessionsDir, "A");
			fs.mkdirSync(dirA, { recursive: true });
			const ctxA = hostContext(root, ownedSession(join(sessionsDir, "A.jsonl"), "A"));

			await emit(registry, "session_start", {}, ctxA);
			const tool = registry.tools[0];
			await tool.execute("c1", { code: "state_token = 'veto_survivor'" }, undefined, undefined, ctxA);

			// A before-hook fires, transition is vetoed (e.g. user aborts or another hook cancels): no after-event.
			await emit(registry, "session_before_switch", { reason: "fork" }, ctxA);

			// The outgoing session remains in turn: subsequent execution still has state_token.
			const probe = await tool.execute("c2", { code: "print(state_token)" }, undefined, undefined, ctxA);
			expect(probe.isError ?? false).toBe(false);
			expect(probe.content[0].text).toContain("veto_survivor");
		} finally {
			if (shutdown) await shutdown();
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 180_000);
});

describe("POST-SESSION-OWNED-DIR-1: exact session-owned directory resolution", () => {
	test("adopted child session uses its own session-owned directory derived from getSessionFile(), not an ad-hoc subdirectory under the parent root", async () => {
		const root = scratch("rlm-owned-adopted-");
		try {
			const parentArtifactsDir = join(root, "parent-artifacts-root");
			const childOwnedDir = join(root, "sessions", "child-42");
			fs.mkdirSync(parentArtifactsDir, { recursive: true });
			fs.mkdirSync(childOwnedDir, { recursive: true });
			// Pre-populate child-owned directory with the child's own prior snapshot.
			fs.writeFileSync(join(childOwnedDir, "kernel-state.dill"), "CHILD_OWNED_SNAPSHOT");
			// Pre-populate parent root with parent state (must NOT be loaded by child).
			fs.writeFileSync(join(parentArtifactsDir, "kernel-state.dill"), "PARENT_SNAPSHOT");

			const childKernel = makePort({ names: ["child_var"] });
			const { api, registry } = makeRegistry();
			await createRlmExtension({ createKernel: () => childKernel.port })(api as never);

			// Subagent scenario: sessionManager.getArtifactsDir() returns parentArtifactsDir (adopted),
			// but sessionManager.getSessionFile() returns the child's own session file.
			const childSessionManager: SessionManagerShape = {
				getSessionFile: () => join(root, "sessions", "child-42.jsonl"),
				getArtifactsDir: () => parentArtifactsDir,
				getSessionId: () => "child-42",
			};
			const ctx = hostContext(root, childSessionManager);
			await emit(registry, "session_start", {}, ctx);

			const revivals = registry.messages.filter(m => m.customType === "rlm-revival");
			// The child's owned directory had a snapshot, so revival must fire for child_var.
			expect(revivals.length).toBe(1);
			expect(revivals[0].content ?? "").toContain("child_var");

			// Verify that an ad-hoc child subdirectory under the parent was NOT synthesized.
			expect(fs.existsSync(join(parentArtifactsDir, "child-42"))).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("no substring heuristic: a parent directory whose name contains the child sessionId is not mistreated as an owned match", async () => {
		const root = scratch("rlm-owned-substring-");
		try {
			// Parent directory path contains "child" as a SUBSTRING (e.g. /path/to/childhood-parent/artifacts)
			const parentArtifactsDir = join(root, "childhood-parent-artifacts");
			const childOwnedDir = join(root, "sessions", "child");
			fs.mkdirSync(parentArtifactsDir, { recursive: true });
			fs.mkdirSync(childOwnedDir, { recursive: true });
			fs.writeFileSync(join(childOwnedDir, "kernel-state.dill"), "CHILD_OWNED_DATA");

			const kernel = makePort({ names: ["exact_child_var"] });
			const { api, registry } = makeRegistry();
			await createRlmExtension({ createKernel: () => kernel.port })(api as never);

			const childSessionManager: SessionManagerShape = {
				getSessionFile: () => join(root, "sessions", "child.jsonl"),
				getArtifactsDir: () => parentArtifactsDir,
				getSessionId: () => "child",
			};
			const ctx = hostContext(root, childSessionManager);
			await emit(registry, "session_start", {}, ctx);

			const revivals = registry.messages.filter(m => m.customType === "rlm-revival");
			expect(revivals.length).toBe(1);
			expect(revivals[0].content ?? "").toContain("exact_child_var");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("POST-SESSION-READINESS-1: pending artifact copy readiness barrier", () => {
	test("extension awaits the incoming artifact manager's public listFiles() before probing snapshot existence", async () => {
		const root = scratch("rlm-readiness-wait-");
		try {
			const sessionsDir = join(root, "sessions");
			const dirB = join(sessionsDir, "B");
			fs.mkdirSync(sessionsDir, { recursive: true });

			// Simulate a background artifact copy: the file does NOT exist when session_start fires,
			// but lands when listFiles() resolves.
			let listFilesCalled = false;
			const fakeArtifactManager: ArtifactManagerShape = {
				dir: dirB,
				async listFiles() {
					listFilesCalled = true;
					await new Promise(r => setTimeout(r, 20));
					fs.mkdirSync(dirB, { recursive: true });
					fs.writeFileSync(join(dirB, "kernel-state.dill"), "COPIED_IN_BACKGROUND");
					return ["kernel-state.dill"];
				},
			};

			const kernel = makePort({ names: ["copied_var"] });
			const { api, registry } = makeRegistry();
			await createRlmExtension({ createKernel: () => kernel.port })(api as never);

			const sessionManager: SessionManagerShape = {
				getSessionFile: () => join(sessionsDir, "B.jsonl"),
				getArtifactsDir: () => dirB,
				getSessionId: () => "B",
				getArtifactManager: () => fakeArtifactManager,
			};
			const ctx = hostContext(root, sessionManager);
			await emit(registry, "session_start", {}, ctx);

			expect(listFilesCalled).toBe(true);
			const revivals = registry.messages.filter(m => m.customType === "rlm-revival");
			expect(revivals.length).toBe(1);
			expect(revivals[0].content ?? "").toContain("copied_var");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("negative: an adopted artifact manager whose dir is the parent's is NOT awaited for a child session (PARKED)", async () => {
		const root = scratch("rlm-readiness-adopted-");
		try {
			const parentDir = join(root, "parent-root");
			const childDir = join(root, "sessions", "child");
			fs.mkdirSync(parentDir, { recursive: true });
			fs.mkdirSync(childDir, { recursive: true });
			fs.writeFileSync(join(childDir, "kernel-state.dill"), "CHILD_STATE");

			let parentListFilesCalled = false;
			const parentArtifactManager: ArtifactManagerShape = {
				dir: parentDir, // does NOT match childDir
				async listFiles() {
					parentListFilesCalled = true;
					return [];
				},
			};

			const kernel = makePort({ names: ["child_var"] });
			const { api, registry } = makeRegistry();
			await createRlmExtension({ createKernel: () => kernel.port })(api as never);

			const childSessionManager: SessionManagerShape = {
				getSessionFile: () => join(root, "sessions", "child.jsonl"),
				getArtifactsDir: () => parentDir,
				getSessionId: () => "child",
				getArtifactManager: () => parentArtifactManager,
			};
			const ctx = hostContext(root, childSessionManager);
			await emit(registry, "session_start", {}, ctx);

			// Since parentArtifactManager.dir !== childDir, the extension must NOT wait on parent's readiness
			expect(parentListFilesCalled).toBe(false);
			const revivals = registry.messages.filter(m => m.customType === "rlm-revival");
			expect(revivals.length).toBe(1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
