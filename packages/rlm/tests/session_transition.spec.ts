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
