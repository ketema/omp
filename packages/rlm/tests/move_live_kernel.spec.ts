/**
 * POST-SESSION-MOVE-3 (contracts/rlm-session-isolation.contract.ts): a 'move' relocates the SAME logical session, so its
 * live kernel is retargeted, not replaced. Real everything except the host: createRlmExtension()'s default factory (real
 * RlmTransport, KernelManager, adapter, tool) and the unmodified Python runner; the host is the two things the
 * extension consumes from it (resolveOwnArtifactsDir resolving after the copy, and the copy itself).
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

let suiteRoot = "";
let caseCounter = 0;
beforeAll(() => {
	suiteRoot = fs.mkdtempSync(join(os.tmpdir(), "rlm-move-live-"));
});
afterAll(() => {
	fs.rmSync(suiteRoot, { recursive: true, force: true });
});

async function openSession(label: string) {
	caseCounter++;
	const root = join(suiteRoot, `${caseCounter}-${label}`);
	const oldDir = join(root, "sessions", "original-artifacts");
	const newDir = join(root, "sessions", "sibling-artifacts");
	fs.mkdirSync(oldDir, { recursive: true });
	const flags: Record<string, string> = { OMP_RLM_AGENT_DIR: join(root, "agent") };
	if (process.env.RLM_TEST_PYTHON) flags.RLM_KERNEL_PYTHON = process.env.RLM_TEST_PYTHON;
	const handlers = new Map<string, Handler[]>();
	const tools: Array<{
		execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
	}> = [];
	const warnings: string[] = [];
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
		sendMessage(payload: { customType?: string; content?: string }) {
			if (payload.customType === "rlm-warning") warnings.push(String(payload.content));
		},
	};
	const ctxFor = (dir: string) => ({ cwd: root, sessionManager: { resolveOwnArtifactsDir: async () => dir } });
	const toolCtx = { hasUI: false, setWorkingMessage() {}, ui: { select: async () => undefined } };
	await createRlmExtension()(api as never);
	const emit = async (type: string, event: object, dir: string) => {
		for (const handler of handlers.get(type) ?? []) await handler({ type, ...event }, ctxFor(dir));
	};
	await emit("session_start", {}, oldDir);
	const call = (code: string) => tools[0].execute(`c-${crypto.randomUUID()}`, { code }, undefined, undefined, toolCtx);
	return {
		root,
		oldDir,
		newDir,
		warnings,
		emit,
		call,
		run: async (code: string) => (await call(code)).content.map(part => part.text).join("\n"),
	};
}

function pairHashes(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!fs.existsSync(dir)) return out;
	for (const name of fs.readdirSync(dir).sort()) {
		out[name] = crypto
			.createHash("sha256")
			.update(fs.readFileSync(join(dir, name)))
			.digest("hex")
			.slice(0, 16);
	}
	return out;
}

async function untilExists(path: string): Promise<void> {
	for (let attempt = 0; attempt < 6000; attempt++) {
		if (fs.existsSync(path)) return;
		await Bun.sleep(10);
	}
	throw new Error(`did not appear within the bound: ${path}`);
}

describe("POST-SESSION-MOVE-3: a move retargets the live kernel of the same logical session", () => {
	test("an idle move keeps the SAME kernel process and its live state, snapshots into the new directory, and leaves the old one untouched", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [x] C1 VALID: cites POST-SESSION-MOVE-3 (and MOVE-2's observable guarantees)
		 *   [x] C2 VALUABLE: a move that disposes and restores starts a new process (different pid) and fails the identity check
		 *   [x] C3 NON-DUPLICATIVE: session_move_snapshot.spec.ts scripts the process; only a real process can show identity
		 *   [x] C4 NOT FUTURE-EDIT: bounds the relocation path the extension performs today
		 * Risk tier: High - replacing the kernel on a relocation discards in-process state that is not picklable.
		 */
		const s = await openSession("idle");
		try {
			const pidBefore = (await s.run("import os\nmarker = 1\nprint('pid=' + str(os.getpid()))")).match(
				/pid=(\d+)/,
			)?.[1];
			expect(pidBefore, "precondition: the real kernel reported its pid").toBeDefined();
			await s.emit("session_before_switch", { targetSessionFile: "synthetic" }, s.oldDir); // marker1 committed
			await s.run("marker = 2\nunpicklable = (lambda: 7)\nprint('ok')"); // live state; a lambda survives only in this process
			const oldBefore = pairHashes(s.oldDir);
			fs.cpSync(s.oldDir, s.newDir, { recursive: true }); // the host copy finished first
			const copied = pairHashes(s.newDir);

			await s.emit("session_switch", { reason: "move", previousSessionFile: "synthetic.jsonl" }, s.newDir);

			const after = await s.run(
				"import os\nprint('pid=' + str(os.getpid()) + ' marker=' + str(marker) + ' lam=' + str(unpicklable()))",
			);
			expect(
				after.match(/pid=(\d+)/)?.[1],
				"POST-SESSION-MOVE-3 violation: the kernel was replaced on a same-session relocation\nEXPECTED: the same process before and after the move\nGUIDANCE: a move retargets the live kernel; it does not start another one",
			).toBe(pidBefore);
			expect(after, "POST-SESSION-MOVE-3 violation: live in-process state did not survive the move").toContain(
				"marker=2 lam=7",
			);
			expect(
				pairHashes(s.newDir),
				"POST-SESSION-MOVE-3 violation: nothing was snapshotted into the new directory",
			).not.toEqual(copied);
			expect(pairHashes(s.oldDir), "POST-SESSION-MOVE-3 violation: the superseded directory was written").toEqual(
				oldBefore,
			);
		} finally {
			await s.emit("session_shutdown", {}, s.newDir);
		}
	}, 120_000);

	test("a cell running when the move lands finishes on the same kernel with its own result, and the move does not wait for it", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [x] C1 VALID: cites POST-SESSION-MOVE-3 (b) and (c)
		 *   [x] C2 VALUABLE: a move that disposes aborts the cell or blocks the transition on it; both fail this test
		 *   [x] C3 NON-DUPLICATIVE: the idle test cannot observe a running cell
		 *   [x] C4 NOT FUTURE-EDIT: bounds the relocation path the extension performs today
		 * Risk tier: High - a /move during a long cell currently kills it.
		 */
		const s = await openSession("long-cell");
		try {
			await s.run("marker = 1\nprint('ok')");
			await s.emit("session_before_switch", { targetSessionFile: "synthetic" }, s.oldDir);
			await s.run("marker = 2\nprint('ok')");
			const oldBefore = pairHashes(s.oldDir);

			const started = join(s.root, "long-cell-started.flag");
			let longSettled = false;
			const longCell = s
				.call(
					`import os, time\nopen(${JSON.stringify(started)}, "w").write("1")\ntime.sleep(7)\nlong_done = 1\nprint("long-finished pid=" + str(os.getpid()))`,
				)
				.finally(() => {
					longSettled = true;
				});
			await untilExists(started);
			fs.cpSync(s.oldDir, s.newDir, { recursive: true });

			await s.emit("session_switch", { reason: "move", previousSessionFile: "synthetic.jsonl" }, s.newDir);
			expect(
				longSettled,
				"POST-SESSION-MOVE-3 violation: the move transition waited for the running cell (or aborted it)\nEXPECTED: the move completes while the cell is still running",
			).toBe(false);

			const result = await longCell;
			expect(
				result.isError ?? false,
				"POST-SESSION-MOVE-3 violation: the running cell was aborted by the move",
			).toBe(false);
			expect(result.content[0].text).toContain("long-finished");
			const state = await s.run("print('marker=' + str(marker) + ' long=' + str(long_done))");
			expect(state, "POST-SESSION-MOVE-3 violation: the namespace did not survive the move").toContain(
				"marker=2 long=1",
			);

			// A bounded flush that could not run behind the cell is surfaced, and later snapshots still land in the new directory.
			expect(
				s.warnings.some(w => w.includes("did not settle")),
				"POST-SESSION-MOVE-3 violation: the abandoned flush was not surfaced",
			).toBe(true);
			await s.emit("session_before_switch", { targetSessionFile: "synthetic" }, s.newDir);
			expect(pairHashes(s.oldDir), "POST-SESSION-MOVE-3 violation: the superseded directory was written").toEqual(
				oldBefore,
			);
			expect(Object.keys(pairHashes(s.newDir))).toContain("kernel-state.dill");
		} finally {
			await s.emit("session_shutdown", {}, s.newDir);
		}
	}, 180_000);
});
