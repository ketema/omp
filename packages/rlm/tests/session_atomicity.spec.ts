/**
 * RLM tool-invocation / session-transition atomicity (SLICE-2).
 *
 * CONTRACT AUTHORITY RECORD:
 * - Contract: contracts/rlm-session-isolation.contract.ts
 * - Clauses covered:
 *     POST-TOOL-SESSION-BINDING-1    a cell invocation stays bound to the kernel current at its entry
 *     ERRORS-TOOL-SESSION-CHANGED-1  a replaced bound kernel aborts the call visibly; no deadlock
 *
 * Every test drives the REAL registered ipython tool (`registry.tools[0].execute`) and the REAL
 * lifecycle handlers (`session_start` / `session_switch` / `session_shutdown`) of createRlmExtension.
 * Race points are pinned with explicit promise barriers, never sleeps: a kernel double parks inside
 * ensureStarted / execute / the busy-choice dialog until the test has run the lifecycle transition.
 *
 * COVERAGE LIMITS (stated, not hidden):
 * - Kernels are injected doubles (createKernel seam); the host session only supplies the directory via
 *   the typed resolveOwnArtifactsDir surface. Real SessionManager ownership/readiness is covered in
 *   session_transition.spec.ts / session_isolation.spec.ts, which need the host's native addon.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

import { createRlmExtension, type RlmExtensionKernelPort } from "../src/extension.ts";
import { TOOL_BUSY_CHOICES } from "../src/tool.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;

interface ToolResult {
	readonly content: Array<{ text: string }>;
	readonly details?: { readonly status?: string };
	readonly isError?: boolean;
}

interface ToolContext {
	readonly hasUI: boolean;
	setWorkingMessage(): void;
	readonly ui: { select(): Promise<string | undefined> };
}

interface ToolRecord {
	readonly execute: (
		toolCallId: string,
		params: { code: string },
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: ToolContext,
	) => Promise<ToolResult>;
}

interface Registry {
	readonly handlers: Map<string, Handler[]>;
	readonly tools: ToolRecord[];
}

function makeRegistry() {
	const registry: Registry = { handlers: new Map(), tools: [] };
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
		getFlag() {
			return undefined;
		},
		sendMessage() {},
	};
	return { api, registry };
}

async function emit(registry: Registry, type: string, event: object, ctx: unknown): Promise<void> {
	for (const handler of registry.handlers.get(type) ?? []) await handler({ type, ...event }, ctx);
}

interface Gate {
	readonly opened: Promise<void>;
	open(): void;
}

function gate(): Gate {
	let open: () => void = () => {};
	const opened = new Promise<void>(resolve => {
		open = resolve;
	});
	return { opened, open };
}

/** Settles with `work`, or fails the test with a clear message instead of hanging. */
async function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
	let rejectTimeout: (error: Error) => void = () => {};
	const timeout = new Promise<never>((_, reject) => {
		rejectTimeout = reject;
	});
	const timer = setTimeout(() => rejectTimeout(new Error(`${what}: did not settle within ${ms}ms (deadlock?)`)), ms);
	try {
		return await Promise.race([work, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

interface PortScript {
	/** Park inside ensureStarted until opened. */
	readonly ensureStartedGate?: Gate;
	/** Park inside execute until opened (the cell is "running"). */
	readonly executeGate?: Gate;
	/** First execute attempt throws the kernel's busy-after-interrupt error (the cell never ran). */
	readonly busyOnFirstExecute?: boolean;
}

interface PortRecord {
	readonly label: string;
	readonly executes: string[];
	attempts: number;
	disposed: boolean;
	readonly ensureStartedEntered: Gate;
	readonly executeEntered: Gate;
}

interface ScriptedPort {
	readonly port: RlmExtensionKernelPort;
	readonly record: PortRecord;
}

function makePort(label: string, script: PortScript): ScriptedPort {
	const record: PortRecord = {
		label,
		executes: [],
		attempts: 0,
		disposed: false,
		ensureStartedEntered: gate(),
		executeEntered: gate(),
	};
	const port: RlmExtensionKernelPort = {
		async ensureStarted() {
			record.ensureStartedEntered.open();
			await script.ensureStartedGate?.opened;
		},
		async execute(code: string) {
			record.attempts++;
			record.executeEntered.open();
			if (script.busyOnFirstExecute === true && record.attempts === 1) {
				throw Object.assign(new Error("kernel busy after interrupt"), { name: "KernelBusyAfterInterruptError" });
			}
			record.executes.push(code);
			await script.executeGate?.opened;
			return {
				status: "ok" as const,
				stdout: `ran-on-${label}`,
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
			record.disposed = true;
		},
		restoredNames() {
			return [];
		},
		restoredSkipped() {
			return [];
		},
		async flushSnapshot() {},
		async onCompactionComplete() {},
		compactionNotice() {
			return null;
		},
	};
	return { port, record };
}

interface HostCtx {
	readonly cwd: string;
	readonly sessionManager: { resolveOwnArtifactsDir(): Promise<string | null> };
}

function hostCtx(cwd: string, ownDir: string): HostCtx {
	return { cwd, sessionManager: { resolveOwnArtifactsDir: async () => ownDir } };
}

function toolCtx(select?: () => Promise<string | undefined>): ToolContext {
	return {
		hasUI: select !== undefined,
		setWorkingMessage() {},
		ui: { select: select ?? (async () => undefined) },
	};
}

interface Harness {
	readonly registry: Registry;
	readonly records: PortRecord[];
	readonly sessionA: HostCtx;
	readonly sessionB: HostCtx;
}

/** Wires the extension to scripted kernels, handed out in creation order, and starts session A. */
async function startSessionA(scripts: PortScript[], dir: string): Promise<Harness> {
	const records: PortRecord[] = [];
	const { api, registry } = makeRegistry();
	await createRlmExtension({
		createKernel() {
			const { port, record } = makePort(`S${records.length + 1}`, scripts[records.length] ?? {});
			records.push(record);
			return port;
		},
	})(api as never);
	const sessionA = hostCtx(dir, join(dir, "sessions", "A"));
	const sessionB = hostCtx(dir, join(dir, "sessions", "B"));
	await emit(registry, "session_start", {}, sessionA);
	return { registry, records, sessionA, sessionB };
}

function tool(h: Harness): ToolRecord {
	return h.registry.tools[0];
}

/** Labels of every kernel that was handed `code`. */
function ranOn(h: Harness, code: string): string[] {
	return h.records.filter(r => r.executes.includes(code)).map(r => r.label);
}

let root = "";
let counter = 0;

beforeAll(() => {
	root = fs.mkdtempSync("/tmp/rlm-session-atomicity-");
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function caseDir(label: string): string {
	counter++;
	const dir = join(root, `${counter}-${label}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

describe("POST-TOOL-SESSION-BINDING-1 / ERRORS-TOOL-SESSION-CHANGED-1: a cell stays bound to its entry kernel", () => {
	test("O2: a switch between ensureStarted and execute aborts the cell visibly; old code never reaches the incoming session's kernel", async () => {
		const hold = gate();
		const h = await startSessionA([{ ensureStartedGate: hold }, {}], caseDir("o2-switch"));

		const cell = tool(h).execute("c-old", { code: "OLD_CELL = 1" }, undefined, undefined, toolCtx());
		await within(2000, "cell entering ensureStarted", h.records[0].ensureStartedEntered.opened);

		// REAL lifecycle: the switch lands while the old cell is parked between ensureStarted and execute.
		await within(2000, "session_switch", emit(h.registry, "session_switch", { reason: "new" }, h.sessionB));
		expect(h.records[0].disposed).toBe(true);

		hold.open();
		const res = await within(2000, "aborted cell result", cell);

		expect(res.isError, "ERRORS-TOOL-SESSION-CHANGED-1 violation: the cell must be aborted visibly").toBe(true);
		expect(res.details?.status).toBe("aborted");
		expect(res.content[0].text.toLowerCase()).toContain("session changed");
		expect(
			ranOn(h, "OLD_CELL = 1"),
			"POST-TOOL-SESSION-BINDING-1 violation: old cell code executed on a kernel other than the one bound at entry",
		).toEqual([]);

		// A later invocation binds to the current (incoming) session's kernel and runs normally.
		const next = await tool(h).execute("c-new", { code: "NEW_CELL = 2" }, undefined, undefined, toolCtx());
		expect(next.isError ?? false).toBe(false);
		expect(next.content[0].text).toContain("ran-on-S2");
		expect(ranOn(h, "NEW_CELL = 2")).toEqual(["S2"]);
		expect(ranOn(h, "OLD_CELL = 1")).toEqual([]);
	});

	test("O2: a busy-kernel retry after a switch aborts instead of re-dispatching the old cell into the incoming session", async () => {
		const choice = gate();
		const h = await startSessionA([{ busyOnFirstExecute: true }, {}], caseDir("o2-busy-retry"));
		const cell = tool(h).execute(
			"c-busy",
			{ code: "BUSY_CELL = 1" },
			undefined,
			undefined,
			toolCtx(async () => {
				await choice.opened;
				return TOOL_BUSY_CHOICES[0];
			}),
		);
		await within(2000, "first (busy) execute attempt", h.records[0].executeEntered.opened);

		await within(2000, "session_switch", emit(h.registry, "session_switch", { reason: "new" }, h.sessionB));
		expect(h.records[0].disposed).toBe(true);

		choice.open(); // user picks "wait and preserve state" -> the tool retries the same cell
		const res = await within(2000, "aborted retry result", cell);

		expect(res.isError).toBe(true);
		expect(res.details?.status).toBe("aborted");
		expect(res.content[0].text.toLowerCase()).toContain("session changed");
		expect(
			ranOn(h, "BUSY_CELL = 1"),
			"POST-TOOL-SESSION-BINDING-1 violation: the busy retry re-dispatched old cell code to another kernel",
		).toEqual([]);
		expect(h.records[0].attempts, "the abort must not make a second kernel call").toBe(1);
		expect(h.records.length, "the abort must not construct a kernel for the incoming session").toBe(1);
	});

	test("O2: a shutdown between ensureStarted and execute aborts the cell; no replacement kernel is built to run it", async () => {
		const hold = gate();
		const h = await startSessionA([{ ensureStartedGate: hold }, {}], caseDir("o2-shutdown"));
		const cell = tool(h).execute("c-shutdown", { code: "SHUT_CELL = 1" }, undefined, undefined, toolCtx());
		await within(2000, "cell entering ensureStarted", h.records[0].ensureStartedEntered.opened);

		await within(2000, "session_shutdown", emit(h.registry, "session_shutdown", {}, h.sessionA));
		hold.open();
		const res = await within(2000, "aborted cell result", cell);

		expect(res.isError).toBe(true);
		expect(res.details?.status).toBe("aborted");
		expect(ranOn(h, "SHUT_CELL = 1")).toEqual([]);
		expect(
			h.records.length,
			"POST-TOOL-SESSION-BINDING-1 violation: a replacement kernel was constructed to run a cell bound to a shut-down session",
		).toBe(1);
	});

	test("O3: a switch while the cell is RUNNING neither waits for it (no deadlock) nor re-dispatches it; it finishes on its own kernel", async () => {
		const running = gate();
		const h = await startSessionA([{ executeGate: running }, {}], caseDir("o3-running"));
		const cell = tool(h).execute("c-run", { code: "RUNNING_CELL = 1" }, undefined, undefined, toolCtx());
		await within(2000, "cell entering execute", h.records[0].executeEntered.opened);

		// The cell is parked INSIDE S1.execute. The switch must complete without waiting for it.
		await within(
			2000,
			"session_switch behind a running cell",
			emit(h.registry, "session_switch", { reason: "new" }, h.sessionB),
		);
		expect(h.records[0].disposed).toBe(true);

		running.open();
		const res = await within(2000, "running cell result", cell);

		expect(res.isError ?? false).toBe(false);
		expect(res.content[0].text).toContain("ran-on-S1");
		expect(ranOn(h, "RUNNING_CELL = 1")).toEqual(["S1"]);
		expect(h.records.length, "a running cell must not cause the incoming session's kernel to be built").toBe(1);
	});
});
