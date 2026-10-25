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

interface SentMessage {
	readonly customType?: string;
	readonly content?: string;
}

interface Registry {
	readonly handlers: Map<string, Handler[]>;
	readonly tools: ToolRecord[];
	readonly messages: SentMessage[];
}

function makeRegistry(flags: Record<string, string | boolean> = {}) {
	const registry: Registry = { handlers: new Map(), tools: [], messages: [] };
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
			const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
			registry.messages.push({
				customType: typeof record.customType === "string" ? record.customType : undefined,
				content: typeof record.content === "string" ? record.content : undefined,
			});
		},
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
	/** Park inside dispose until opened (a slow snapshot flush). */
	readonly disposeGate?: Gate;
}

interface PortRecord {
	readonly label: string;
	readonly executes: string[];
	attempts: number;
	disposed: boolean;
	readonly ensureStartedEntered: Gate;
	readonly executeEntered: Gate;
	readonly disposeEntered: Gate;
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
		disposeEntered: gate(),
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
			record.disposeEntered.open();
			await script.disposeGate?.opened;
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

	test("O2: a cell resuming while the outgoing kernel is still DISPOSING aborts visibly without calling the disposing kernel", async () => {
		const hold = gate();
		const disposing = gate();
		const h = await startSessionA(
			[{ ensureStartedGate: hold, disposeGate: disposing }, {}],
			caseDir("o2-slow-dispose"),
		);
		const cell = tool(h).execute("c-slow", { code: "SLOW_CELL = 1" }, undefined, undefined, toolCtx());
		await within(2000, "cell entering ensureStarted", h.records[0].ensureStartedEntered.opened);

		// The switch parks INSIDE S1.dispose (a slow snapshot flush); the lifecycle has not completed yet.
		const switching = emit(h.registry, "session_switch", { reason: "new" }, h.sessionB);
		await within(2000, "S1.dispose starting", h.records[0].disposeEntered.opened);

		hold.open();
		// The cell must settle WHILE dispose is still parked: ownership was relinquished before the awaited dispose.
		const res = await within(2000, "aborted cell result during dispose", cell);
		expect(res.isError).toBe(true);
		expect(res.details?.status).toBe("aborted");
		expect(
			h.records[0].attempts,
			"POST-TOOL-SESSION-BINDING-1 violation: the cell called a kernel that is mid-dispose",
		).toBe(0);

		disposing.open();
		await within(2000, "session_switch completing", switching);
		expect(ranOn(h, "SLOW_CELL = 1")).toEqual([]);
	});

	test("O2: a cell resuming while the kernel is still being disposed by SHUTDOWN aborts visibly without calling the disposing kernel", async () => {
		const hold = gate();
		const disposing = gate();
		const h = await startSessionA(
			[{ ensureStartedGate: hold, disposeGate: disposing }, {}],
			caseDir("o2-shutdown-slow-dispose"),
		);
		const cell = tool(h).execute("c-shut-slow", { code: "SHUT_SLOW_CELL = 1" }, undefined, undefined, toolCtx());
		await within(2000, "cell entering ensureStarted", h.records[0].ensureStartedEntered.opened);

		const shuttingDown = emit(h.registry, "session_shutdown", {}, h.sessionA);
		await within(2000, "S1.dispose starting", h.records[0].disposeEntered.opened);

		hold.open();
		const res = await within(2000, "aborted cell result during shutdown dispose", cell);
		expect(res.isError).toBe(true);
		expect(res.details?.status).toBe("aborted");
		expect(
			h.records[0].attempts,
			"POST-TOOL-SESSION-BINDING-1 violation: the cell called a kernel that shutdown is disposing",
		).toBe(0);

		disposing.open();
		await within(2000, "session_shutdown completing", shuttingDown);
		expect(ranOn(h, "SHUT_SLOW_CELL = 1")).toEqual([]);
		expect(h.records.length).toBe(1);
	});

	test("a cell racing back-to-back switches runs on its own kernel or aborts, and the final session's kernel sees exactly its own cell", async () => {
		const h = await startSessionA([{}, {}], caseDir("back-to-back"));
		const sessionC = hostCtx(h.sessionA.cwd, join(h.sessionA.cwd, "sessions", "C"));

		const toB = emit(h.registry, "session_switch", { reason: "new" }, h.sessionB);
		const cellB = tool(h).execute("c-b", { code: "in_b = 1" }, undefined, undefined, toolCtx());
		const toC = emit(h.registry, "session_switch", { reason: "new" }, sessionC);
		await within(2000, "back-to-back switches and the racing cell", Promise.all([toB, cellB, toC]));
		const resB = await cellB;
		const resC = await tool(h).execute("c-c", { code: "in_c = 1" }, undefined, undefined, toolCtx());

		expect(resC.isError ?? false).toBe(false);
		const finalKernel = h.records[h.records.length - 1];
		expect(
			finalKernel.executes,
			"POST-TOOL-SESSION-BINDING-1 violation: old cell code executed in the incoming session's namespace",
		).toEqual(["in_c = 1"]);
		expect(finalKernel.disposed).toBe(false);
		expect(h.records[0].disposed, "the kernel built for the racing cell must be disposed by the next switch").toBe(
			true,
		);
		// B's cell: exactly one of O1 (ran on its own kernel) / O2 (aborted, reached no kernel), correlated with its result.
		expect(ranOn(h, "in_b = 1")).toEqual(resB.isError === true ? [] : ["S1"]);
		expect(resB.details?.status).toBe(resB.isError === true ? "aborted" : "ok");
	});

	test("REAL kernel: a genuinely running cell survives a switch on its own process; the incoming session shares neither its state nor its process", async () => {
		const dir = caseDir("real-running-cell");
		const flags: Record<string, string> = { OMP_RLM_AGENT_DIR: join(dir, "agent") };
		const existingPython = join(process.env.HOME ?? "/Users/ketema", ".omp/agent/kernel-venv/bin/python");
		if (fs.existsSync(existingPython)) flags.RLM_KERNEL_PYTHON = existingPython;
		const { api, registry } = makeRegistry(flags);
		await createRlmExtension()(api as never);
		const sessionA = hostCtx(dir, join(dir, "sessions", "A"));
		const sessionB = hostCtx(dir, join(dir, "sessions", "B"));
		const flag = join(dir, "long-cell-running.flag");
		const realTool = registry.tools[0];
		try {
			await emit(registry, "session_start", {}, sessionA);
			const first = await realTool.execute(
				"a-pid",
				{ code: "import os\nowner_pid = os.getpid()\nprint(f'PID={owner_pid}')" },
				undefined,
				undefined,
				toolCtx(),
			);
			expect(first.isError ?? false).toBe(false);
			const pidA = /PID=(\d+)/.exec(first.content[0].text)?.[1];
			expect(pidA).toBeDefined();

			// The barrier is the running cell's own signal (it writes a flag file from INSIDE the real kernel).
			const longCell = realTool.execute(
				"a-long",
				{
					code: `import time\nopen(${JSON.stringify(flag)}, "w").write("1")\ntime.sleep(2.5)\nold_cell_marker = 1\nprint("old-cell-finished")`,
				},
				undefined,
				undefined,
				toolCtx(),
			);
			const deadline = Date.now() + 60_000;
			while (!fs.existsSync(flag)) {
				if (Date.now() > deadline) throw new Error("real long cell never signalled that it was running");
				await new Promise(resolve => setTimeout(resolve, 25));
			}

			// REAL lifecycle while the cell is genuinely running inside the real kernel.
			await within(
				90_000,
				"session_switch behind a real running cell",
				emit(registry, "session_switch", { reason: "new" }, sessionB),
			);
			await within(90_000, "the real long cell settling", longCell);

			const probe = await realTool.execute(
				"b-probe",
				{
					code: "import os\nprint(f\"PID={os.getpid()} MARKER={'old_cell_marker' in globals()} OWNER={'owner_pid' in globals()}\")",
				},
				undefined,
				undefined,
				toolCtx(),
			);
			expect(probe.isError ?? false).toBe(false);
			const text = probe.content[0].text;
			expect(text, "REQ-RLM-REHYDRATE-003 violation: session A's state is visible in session B").toContain(
				"MARKER=False OWNER=False",
			);
			const pidB = /PID=(\d+)/.exec(text)?.[1];
			expect(pidB).toBeDefined();
			expect(pidB, "session B must run in a different kernel process than session A").not.toBe(pidA);
		} finally {
			await emit(registry, "session_shutdown", {}, sessionB);
		}
	}, 240_000);
});

describe("POST-SESSION-NO-SIDE-EFFECT-1: a session without an owned directory leaves the host untouched until a kernel exists", () => {
	interface NoOwnedWiring {
		readonly registry: Registry;
		readonly records: PortRecord[];
		readonly dirs: string[];
	}

	async function wire(): Promise<NoOwnedWiring> {
		const records: PortRecord[] = [];
		const dirs: string[] = [];
		const { api, registry } = makeRegistry();
		await createRlmExtension({
			createKernel(_config, artifactsDir) {
				const { port, record } = makePort(`S${records.length + 1}`, {});
				records.push(record);
				dirs.push(artifactsDir);
				return port;
			},
		})(api as never);
		return { registry, records, dirs };
	}

	const ownsNothing = (cwd: string) => ({ cwd, sessionManager: { resolveOwnArtifactsDir: async () => null } });
	const predatesAccessor = (cwd: string) => ({ cwd, sessionManager: {} });
	const warningsOf = (w: NoOwnedWiring) => w.registry.messages.filter(m => m.customType === "rlm-warning");
	const isolatedRoot = (cwd: string) => join(cwd, ".omp", "artifacts", "isolated-");

	test("session_start / session_switch / session_branch create no directory and send no transcript message", async () => {
		const dir = caseDir("no-side-effect-lifecycle");
		const w = await wire();
		for (const type of ["session_start", "session_switch", "session_branch"]) {
			await emit(w.registry, type, { reason: "new" }, ownsNothing(dir));
		}
		expect(
			w.registry.messages,
			"POST-SESSION-NO-SIDE-EFFECT-1 violation: a lifecycle event for a session that never used ipython wrote to the host transcript",
		).toEqual([]);
		expect(
			fs.existsSync(join(dir, ".omp")),
			"POST-SESSION-NO-SIDE-EFFECT-1 violation: a lifecycle event created a directory in the user's project",
		).toBe(false);
		expect(w.records.length).toBe(0);
	});

	test("the isolated directory is allocated and announced once per session, when the kernel is first constructed", async () => {
		const dir = caseDir("no-side-effect-first-use");
		const w = await wire();
		const realTool = w.registry.tools[0];
		await emit(w.registry, "session_start", {}, ownsNothing(dir));

		expect((await realTool.execute("c1", { code: "a = 1" }, undefined, undefined, toolCtx())).isError ?? false).toBe(
			false,
		);
		expect((await realTool.execute("c2", { code: "b = 2" }, undefined, undefined, toolCtx())).isError ?? false).toBe(
			false,
		);
		expect(w.dirs.length, "one kernel per session").toBe(1);
		expect(w.dirs[0].startsWith(isolatedRoot(dir))).toBe(true);
		expect(warningsOf(w).length, "exactly one announcement for the session, not one per cell").toBe(1);
		expect(warningsOf(w)[0].content ?? "").toContain(w.dirs[0]);

		// A new no-file session gets its OWN directory and its own single announcement; nothing is shared.
		await emit(w.registry, "session_switch", { reason: "new" }, ownsNothing(dir));
		await realTool.execute("c3", { code: "c = 3" }, undefined, undefined, toolCtx());
		expect(w.dirs.length).toBe(2);
		expect(w.dirs[1]).not.toBe(w.dirs[0]);
		expect(w.dirs[1].startsWith(isolatedRoot(dir))).toBe(true);
		expect(warningsOf(w).length).toBe(2);
	});

	test("a host surface without resolveOwnArtifactsDir is silent at lifecycle and warns (naming the missing accessor) at first kernel use", async () => {
		const dir = caseDir("no-side-effect-old-host");
		const w = await wire();
		await emit(w.registry, "session_start", {}, predatesAccessor(dir));
		expect(w.registry.messages).toEqual([]);
		expect(fs.existsSync(join(dir, ".omp"))).toBe(false);

		await w.registry.tools[0].execute("c1", { code: "x = 1" }, undefined, undefined, toolCtx());
		expect(warningsOf(w).length).toBe(1);
		expect(warningsOf(w)[0].content ?? "").toContain("resolveOwnArtifactsDir");
		expect(w.dirs[0].startsWith(isolatedRoot(dir))).toBe(true);
	});
});

describe("POST-SESSION-TRANSITION-GEN-1 / POST-SESSION-SHUTDOWN-RACE-1 / ERRORS-SESSION-RESOLUTION-FAILED-1: lifecycle ordering", () => {
	interface GenWiring {
		readonly registry: Registry;
		readonly records: PortRecord[];
		readonly dirs: string[];
		readonly started: string[];
	}

	async function wire(): Promise<GenWiring> {
		const records: PortRecord[] = [];
		const dirs: string[] = [];
		const started: string[] = [];
		const { api, registry } = makeRegistry();
		await createRlmExtension({
			createKernel(_config, artifactsDir) {
				const { port, record } = makePort(`S${records.length + 1}`, {});
				const realEnsure = port.ensureStarted.bind(port);
				port.ensureStarted = async onProgress => {
					started.push(artifactsDir);
					await realEnsure(onProgress);
				};
				records.push(record);
				dirs.push(artifactsDir);
				return port;
			},
		})(api as never);
		return { registry, records, dirs, started };
	}

	/** A host context whose directory resolution parks until the returned gate opens (or rejects when told to). */
	function parkedCtx(cwd: string, ownDir: string, hold: Gate, fail = false) {
		return {
			cwd,
			sessionManager: {
				async resolveOwnArtifactsDir(): Promise<string | null> {
					await hold.opened;
					if (fail) throw new Error("resolution failed");
					return ownDir;
				},
			},
		};
	}

	function seedSnapshot(dir: string): void {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(join(dir, "kernel-state.dill"), "SNAPSHOT");
	}

	test("a kernel requested during transition B is built on B's own directory even when a newer transition C begins before B settles", async () => {
		const dir = caseDir("gen-construct-under-b");
		const w = await wire();
		const dirB = join(dir, "sessions", "B");
		const dirC = join(dir, "sessions", "C");
		const holdB = gate();
		const harness = { registry: w.registry, records: w.records } as unknown as Harness;

		const toB = emit(w.registry, "session_switch", { reason: "new" }, parkedCtx(dir, dirB, holdB));
		// The cell is issued while B is still resolving: its kernel belongs to B.
		const cellB = tool(harness).execute("c-b", { code: "in_b = 1" }, undefined, undefined, toolCtx());
		// One event-loop turn: the cell reaches ensureKernel and parks on B's still-pending resolution.
		await new Promise<void>(resolve => setImmediate(resolve));
		const toC = emit(w.registry, "session_switch", { reason: "new" }, hostCtx(dir, dirC));
		holdB.open();
		await within(2000, "B, its cell and the newer transition C", Promise.all([toB, cellB, toC]));
		await tool(harness).execute("c-c", { code: "in_c = 1" }, undefined, undefined, toolCtx());

		expect(
			w.dirs,
			"POST-SESSION-TRANSITION-GEN-1 violation: B's in-flight kernel was not built on B's directory, or C's was not built on C's",
		).toEqual([dirB, dirC]);
		expect(w.records[0].disposed, "the kernel built for B must be disposed by the switch to C").toBe(true);
		expect(w.records[1].disposed).toBe(false);
	});

	test("a slow transition B that settles after a newer transition C neither replaces C's directory nor revives into it", async () => {
		const dir = caseDir("gen-slow-b");
		const w = await wire();
		const dirB = join(dir, "sessions", "B");
		const dirC = join(dir, "sessions", "C");
		seedSnapshot(dirB);
		seedSnapshot(dirC);
		const holdB = gate();

		const slowB = emit(w.registry, "session_switch", { reason: "new" }, parkedCtx(dir, dirB, holdB));
		// C starts while B is still resolving, and completes first.
		await within(
			2000,
			"newer transition C",
			emit(w.registry, "session_switch", { reason: "new" }, hostCtx(dir, dirC)),
		);
		const startedBeforeB = w.started.length;
		holdB.open();
		await within(2000, "stale transition B settling", slowB);

		await tool({ registry: w.registry, records: w.records } as unknown as Harness).execute(
			"c-gen",
			{ code: "x = 1" },
			undefined,
			undefined,
			toolCtx(),
		);
		expect(
			w.started.includes(dirB),
			"POST-SESSION-TRANSITION-GEN-1 violation: the stale transition B restored into / started a kernel on its own directory",
		).toBe(false);
		expect(
			w.dirs[w.dirs.length - 1],
			"POST-SESSION-TRANSITION-GEN-1 violation: a kernel was built against B's directory instead of the newer session C's",
		).toBe(dirC);
		expect(w.started.length - startedBeforeB).toBeLessThanOrEqual(1);
		expect(
			w.registry.messages.filter(m => m.customType === "rlm-revival" && (m.content ?? "").includes("B")).length,
		).toBe(0);
	});

	test("a resolution still pending at shutdown never constructs or starts a kernel, and shutdown does not wait for it", async () => {
		const dir = caseDir("shutdown-race");
		const w = await wire();
		const dirB = join(dir, "sessions", "B");
		seedSnapshot(dirB);
		const holdB = gate();

		const pendingStart = emit(w.registry, "session_start", {}, parkedCtx(dir, dirB, holdB));
		await within(
			2000,
			"shutdown while a resolution is parked (no deadlock)",
			emit(w.registry, "session_shutdown", {}, undefined),
		);
		holdB.open();
		await within(2000, "late resolution settling", pendingStart);

		expect(
			w.records.length,
			"POST-SESSION-SHUTDOWN-RACE-1 violation: a kernel was constructed after session_shutdown",
		).toBe(0);
		expect(w.started).toEqual([]);
	});

	test("a rejected incoming resolution never lets the next kernel reuse the outgoing session's directory", async () => {
		const dir = caseDir("resolution-failed");
		const w = await wire();
		const dirA = join(dir, "sessions", "A");
		await emit(w.registry, "session_start", {}, hostCtx(dir, dirA));
		await tool({ registry: w.registry, records: w.records } as unknown as Harness).execute(
			"c-a",
			{ code: "a = 1" },
			undefined,
			undefined,
			toolCtx(),
		);
		expect(w.dirs[0]).toBe(dirA);

		const open = gate();
		open.open();
		let propagated = false;
		try {
			await emit(
				w.registry,
				"session_switch",
				{ reason: "new" },
				parkedCtx(dir, join(dir, "sessions", "B"), open, true),
			);
		} catch {
			propagated = true;
		}
		expect(propagated, "ERRORS-SESSION-RESOLUTION-FAILED-1 violation: the resolution error was swallowed").toBe(true);

		await tool({ registry: w.registry, records: w.records } as unknown as Harness).execute(
			"c-b",
			{ code: "b = 1" },
			undefined,
			undefined,
			toolCtx(),
		);
		const next = w.dirs[w.dirs.length - 1];
		expect(
			next,
			"ERRORS-SESSION-RESOLUTION-FAILED-1 violation: the next kernel was built on the outgoing session's directory",
		).not.toBe(dirA);
		expect(next.startsWith(join(dir, ".omp", "artifacts", "isolated-"))).toBe(true);
		expect(w.registry.messages.filter(m => m.customType === "rlm-warning").length).toBe(1);
	});
});
