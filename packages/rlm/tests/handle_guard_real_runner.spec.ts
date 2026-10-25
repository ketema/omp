/**
 * POST-NOOPEN-1 / FORBIDDEN-HANDLEOPEN-1 (contracts/rlm_dill_resilient_restore.contract.py) through the REAL bundled
 * runner: createRlmExtension()'s default factory (real RlmTransport, KernelManager, adapter, tool) extracts the embedded
 * runner and starts it, so this proves the guard ships in the default path with no extra asset.
 *
 * The fixture is generated here from synthetic data. A first real kernel writes a legacy-shaped snapshot (a per-variable
 * container holding a closed write-mode file-handle blob for the test's OWN sentinel file, plus a healthy variable) into a
 * fresh directory; a second session then restores from that directory. dill reopens a handle's path (truncating a write-mode
 * file) before applying the closed flag, so an unguarded restore turns the 48-byte sentinel into 0 bytes. Nothing outside
 * the test's temp directory is read or written.
 *
 * Interpreter: `RLM_TEST_PYTHON` when set; otherwise the managed kernel venv via uv, as the other real-kernel specs do.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { createRlmExtension } from "../src/extension.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;
type Message = { customType?: string; content?: string };

let suiteRoot = "";
beforeAll(() => {
	suiteRoot = fs.mkdtempSync(join(os.tmpdir(), "rlm-handle-guard-"));
});
afterAll(() => {
	fs.rmSync(suiteRoot, { recursive: true, force: true });
});

async function openSession(root: string, artifactsDir: string) {
	const flags: Record<string, string> = { OMP_RLM_AGENT_DIR: join(root, "agent") };
	if (process.env.RLM_TEST_PYTHON) flags.RLM_KERNEL_PYTHON = process.env.RLM_TEST_PYTHON;
	const handlers = new Map<string, Handler[]>();
	const tools: Array<{
		execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
	}> = [];
	const messages: Message[] = [];
	const api = {
		registerTool(tool: (typeof tools)[number]) {
			tools.push(tool);
		},
		registerFlag() {},
		registerCommand() {},
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		getFlag(name: string) {
			return flags[name];
		},
		sendMessage(payload: Message) {
			messages.push(payload);
		},
	};
	const ctx = { cwd: root, sessionManager: { resolveOwnArtifactsDir: async () => artifactsDir } };
	const toolCtx = { hasUI: false, setWorkingMessage() {}, ui: { select: async () => undefined } };
	await createRlmExtension()(api as never);
	const emit = async (type: string) => {
		for (const handler of handlers.get(type) ?? []) await handler({ type }, ctx);
	};
	return {
		messages,
		start: () => emit("session_start"),
		shutdown: () => emit("session_shutdown"),
		run: async (code: string) =>
			(await tools[0].execute(`c-${crypto.randomUUID()}`, { code }, undefined, undefined, toolCtx)).content
				.map(part => part.text)
				.join("\n"),
	};
}

describe("file-handle guard through the real bundled runner", () => {
	test("a legacy snapshot holding a closed write-mode handle restores its healthy variables, reports the skip, and leaves the handle's file untouched", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [x] C1 VALID: cites POST-NOOPEN-1 and FORBIDDEN-HANDLEOPEN-1 end to end
		 *   [x] C2 VALUABLE: an unguarded restore (or a guard missing from the bundled runner) truncates the sentinel 48 -> 0
		 *   [x] C3 NON-DUPLICATIVE: the Python unit tests do not exercise the bundled runner, the transport result frame
		 *       or the host's skipped-variable notice
		 *   [x] C4 NOT FUTURE-EDIT: bounds the default restore path today
		 * Risk tier: High - this is the destructive recipe seen in incidents.
		 */
		const root = join(suiteRoot, "case");
		const writerDir = join(root, "writer-artifacts");
		const restoreDir = join(root, "restore-artifacts");
		const sentinel = join(root, "sentinel.txt");
		fs.mkdirSync(writerDir, { recursive: true });
		fs.mkdirSync(restoreDir, { recursive: true });

		// First real kernel: write the legacy-shaped snapshot (a producer that guards would never write this) and the sentinel.
		const writer = await openSession(root, writerDir);
		await writer.start();
		try {
			const crafted = await writer.run(
				[
					"import dill, lzma",
					`fh = open(${JSON.stringify(sentinel)}, "w")`,
					"fh.close()",
					"handle_blob = dill.dumps(fh)",
					'assert b"_create_filehandle" in handle_blob',
					`open(${JSON.stringify(sentinel)}, "wb").write(b"S" * 48)`,
					`with lzma.open(${JSON.stringify(join(restoreDir, "kernel-state.dill"))}, "wb") as out:`,
					'    dill.dump({"healthy": dill.dumps(41), "fh": handle_blob}, out)',
					'print("crafted")',
				].join("\n"),
			);
			expect(crafted, "precondition: the fixture snapshot was written").toContain("crafted");
		} finally {
			await writer.shutdown();
		}
		const before = fs.readFileSync(sentinel);
		expect(before.length, "precondition: the sentinel holds 48 bytes").toBe(48);

		// Second real kernel: restore from that directory.
		const reader = await openSession(root, restoreDir);
		await reader.start();
		try {
			expect(
				fs.readFileSync(sentinel).equals(before),
				"FORBIDDEN-HANDLEOPEN-1 violation: restoring through the bundled runner changed the file a handle named\nEXPECTED: 48 unchanged bytes\nGUIDANCE: a file-handle reconstruction is refused before any path is opened",
			).toBe(true);
			const revival = reader.messages.find(message => message.customType === "rlm-revival");
			expect(
				revival?.content ?? "",
				"POST-NOOPEN-1 violation: the restore did not announce the healthy variable",
			).toContain("healthy");
			expect(
				revival?.content ?? "",
				"POST-NOOPEN-1 violation: the refused handle is not reported as skipped\nEXPECTED: a notice naming 'fh'",
			).toContain("fh");
			const state = await reader.run("print('healthy=' + str(healthy) + ' fh_bound=' + str('fh' in globals()))");
			expect(state, "POST-NOOPEN-1 violation: healthy variable not recovered, or the handle was bound").toContain(
				"healthy=41 fh_bound=False",
			);
		} finally {
			await reader.shutdown();
		}
		expect(
			fs.readFileSync(sentinel).equals(before),
			"FORBIDDEN-HANDLEOPEN-1 violation: the sentinel changed by teardown",
		).toBe(true);
	}, 180_000);
});
