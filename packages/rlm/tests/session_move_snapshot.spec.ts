/**
 * POST-SESSION-MOVE-2 (contracts/rlm-session-isolation.contract.ts): on a persistence move-off the host starts its
 * background artifact copy BEFORE it announces the move, so the copy can finish before the outgoing kernel has flushed
 * the namespace it executed since its last idle snapshot. The session restored in the new directory must still carry
 * that live state, and the superseded directory (which another process may own) must not be written.
 *
 * Real: createRlmExtension, KernelManagerAdapter, KernelManager and the registered tool. Scripted: only the Python
 * process, mirroring the real transport - its snapshot payload is written into the directory the transport was
 * constructed with, and restore reads that directory. The host copy is performed before the move event, the order
 * SessionManager.#moveOffSessionFile produces (copy at session-manager.ts:1281, notice at :1284).
 *
 * COVERAGE LIMIT: the producer is the extension-facing contract (resolveOwnArtifactsDir resolving after the copy), not
 * the real SessionManager, which needs the host native addon. The real SessionManager producer, the real AgentSession
 * event and real Python run end to end in move_off_real_host.spec.ts (CI, where the native addon loads).
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { createRlmExtension, KernelManagerAdapter } from "../src/extension.ts";
import { KernelManager, type KernelClock } from "../src/kernel.ts";
import { scriptedRunnerTransport } from "./scripted_runner_transport.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;

interface ToolResult {
	readonly content: Array<{ text: string }>;
	readonly isError?: boolean;
}

interface ToolRecord {
	readonly execute: (
		toolCallId: string,
		params: { code: string },
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: { hasUI: boolean; setWorkingMessage(): void; ui: { select(): Promise<string | undefined> } },
	) => Promise<ToolResult>;
}

function makeRegistry() {
	const handlers = new Map<string, Handler[]>();
	const tools: ToolRecord[] = [];
	const api = {
		registerTool(tool: ToolRecord) {
			tools.push(tool);
		},
		registerFlag() {},
		registerCommand() {},
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		getFlag() {
			return undefined;
		},
		sendMessage() {},
	};
	return { api, handlers, tools };
}

async function emit(handlers: Map<string, Handler[]>, type: string, event: object, ctx: unknown): Promise<void> {
	for (const handler of handlers.get(type) ?? []) await handler({ type, ...event }, ctx);
}

const toolCtx = () => ({ hasUI: false, setWorkingMessage() {}, ui: { select: async () => undefined } });

const realClock: KernelClock = {
	now: () => Date.now(),
	schedule(fn, ms) {
		const timer = setTimeout(fn, ms);
		return () => clearTimeout(timer);
	},
};

// The scripted runner is shared (scripted_runner_transport.ts); its parity with the real transport is pinned in
// transport.spec.ts ("scripted runner transport parity live").
const scriptedTransport = scriptedRunnerTransport;

const roots: string[] = [];
afterEach(() => {
	while (roots.length > 0) fs.rmSync(roots.pop() as string, { recursive: true, force: true });
});

function caseRoot(label: string): string {
	const root = fs.mkdtempSync(join(os.tmpdir(), `rlm-move-snapshot-${label}-`));
	roots.push(root);
	return root;
}

async function wire() {
	const { api, handlers, tools } = makeRegistry();
	const kernels: Array<{ dir: string; adapter: KernelManagerAdapter }> = [];
	await createRlmExtension({
		createKernel(_config, artifactsDir) {
			const transport = scriptedTransport(artifactsDir);
			const adapter = new KernelManagerAdapter(
				transport,
				new KernelManager(transport, { clock: realClock, artifactsDir }),
			);
			kernels.push({ dir: artifactsDir, adapter });
			return adapter;
		},
	})(api as never);
	const run = (code: string) => tools[0].execute(`call-${code}`, { code }, undefined, undefined, toolCtx());
	return { handlers, kernels, run };
}

/** The host's view of one session: its own artifacts directory, resolvable once the artifact copy settled. */
function sessionCtx(cwd: string, dir: string, copyDone: Promise<void> = Promise.resolve()) {
	return {
		cwd,
		sessionManager: {
			async resolveOwnArtifactsDir(): Promise<string | null> {
				await copyDone;
				return dir;
			},
		},
	};
}

const readPayload = (dir: string): Record<string, number> =>
	JSON.parse(fs.readFileSync(join(dir, "kernel-state.dill"), "utf8")) as Record<string, number>;

describe("POST-SESSION-MOVE-2: a persistence move-off keeps the live namespace", () => {
	test("state executed after the last idle snapshot survives a rekey whose host copy finished first, and the old directory is not written", async () => {
		const root = caseRoot("live");
		const oldDir = join(root, "sessions", "original");
		const newDir = join(root, "sessions", "sibling");
		const w = await wire();
		await emit(w.handlers, "session_start", {}, sessionCtx(root, oldDir));

		await w.run("marker=1");
		await w.kernels[0].adapter.flushSnapshot(); // old snapshot: marker1
		await w.run("marker=2"); // live state, idle snapshot not yet taken
		expect(readPayload(oldDir)).toEqual({ marker: 1 });

		// The host copy starts when the file is re-keyed and completes before the outgoing kernel flushes.
		fs.cpSync(oldDir, newDir, { recursive: true });
		expect(readPayload(newDir)).toEqual({ marker: 1 });

		await emit(
			w.handlers,
			"session_switch",
			{ reason: "move", previousSessionFile: "original.jsonl" },
			sessionCtx(root, newDir),
		);
		const observed = await w.run("marker");

		expect(
			observed.content[0].text,
			"POST-SESSION-MOVE-2 violation: the rekeyed session lost state executed after its last snapshot (marker2) and restored the older copied one",
		).toContain("marker=2");
		expect(
			readPayload(oldDir),
			"POST-SESSION-MOVE-2 violation: the superseded directory was written by the outgoing kernel",
		).toEqual({ marker: 1 });
		expect(readPayload(newDir)).toEqual({ marker: 2 });
		await emit(w.handlers, "session_shutdown", {}, undefined);
	});

	test("repeated moves: only the newest transition disposes and snapshots, into its own directory", async () => {
		const root = caseRoot("repeat");
		const oldDir = join(root, "sessions", "original");
		const dirB = join(root, "sessions", "second");
		const dirC = join(root, "sessions", "third");
		const w = await wire();
		await emit(w.handlers, "session_start", {}, sessionCtx(root, oldDir));
		await w.run("marker=1");
		await w.kernels[0].adapter.flushSnapshot();
		await w.run("marker=2");
		fs.cpSync(oldDir, dirB, { recursive: true });
		fs.cpSync(oldDir, dirC, { recursive: true });

		let releaseB: () => void = () => {};
		const copyB = new Promise<void>(resolve => {
			releaseB = resolve;
		});
		const first = emit(w.handlers, "session_switch", { reason: "move" }, sessionCtx(root, dirB, copyB));
		const second = emit(w.handlers, "session_switch", { reason: "move" }, sessionCtx(root, dirC));
		await second;
		releaseB();
		await first;

		const observed = await w.run("marker");
		expect(
			observed.content[0].text,
			"POST-SESSION-MOVE-2 violation: the newest transition did not carry the live namespace",
		).toContain("marker=2");
		expect(readPayload(dirC)).toEqual({ marker: 2 });
		expect(
			readPayload(dirB),
			"POST-SESSION-MOVE-2 violation: a transition superseded by a newer one wrote its snapshot",
		).toEqual({ marker: 1 });
		expect(readPayload(oldDir)).toEqual({ marker: 1 });
		await emit(w.handlers, "session_shutdown", {}, undefined);
	});
});
