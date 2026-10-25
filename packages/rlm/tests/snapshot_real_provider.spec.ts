/**
 * POST-STAGE-1 (contracts/rlm-session-isolation.contract.ts), refining POST-KM-NO-RESURRECT-1 and
 * POST-KM-SNAPSHOT-PAIR-1 against the REAL provider.
 *
 * Every test drives createRlmExtension()'s DEFAULT factory: the real RlmTransport, KernelManager, adapter and tool,
 * and the unmodified Python runner. There is no fake transport. A synthetic object whose __reduce__ sleeps keeps the
 * real runner inside serialization (its first step writes a flag file, the observable barrier), while the "host"
 * removes the live directory or the flush times out.
 *
 * Interpreter: `RLM_TEST_PYTHON` (an existing interpreter with `dill` and `rlm`) when set; otherwise the managed
 * kernel venv is bootstrapped with uv, exactly as the other real-kernel specs do on CI.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { createRlmExtension } from "../src/extension.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;

const STAGE_PREFIX = ".rlm-snapshot-stage-";
const SLOW_CLASS = (flag: string, seconds: number) =>
	`import time\nclass Slow:\n    def __reduce__(self):\n        open(${JSON.stringify(flag)}, "w").write("1")\n        time.sleep(${seconds})\n        return (int, (1,))\nslow = Slow()\nprint("armed")`;

let suiteRoot = "";
let caseCounter = 0;

beforeAll(() => {
	suiteRoot = fs.mkdtempSync(join(os.tmpdir(), "rlm-snapshot-real-"));
});
afterAll(() => {
	fs.rmSync(suiteRoot, { recursive: true, force: true });
});

interface Session {
	readonly liveDir: string;
	readonly parentDir: string;
	readonly root: string;
	readonly flag: string;
	run(code: string): Promise<string>;
	emit(type: string, event: object): Promise<void>;
	readonly warnings: string[];
}

async function openSession(label: string): Promise<Session> {
	caseCounter++;
	const root = join(suiteRoot, `${caseCounter}-${label}`);
	const parentDir = join(root, "sessions");
	const liveDir = join(parentDir, "own-artifacts");
	fs.mkdirSync(liveDir, { recursive: true });
	const flags: Record<string, string> = { OMP_RLM_AGENT_DIR: join(root, "agent") };
	if (process.env.RLM_TEST_PYTHON !== undefined && process.env.RLM_TEST_PYTHON !== "") {
		flags.RLM_KERNEL_PYTHON = process.env.RLM_TEST_PYTHON;
	}
	const handlers = new Map<string, Handler[]>();
	const tools: Array<{ execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
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
	const ctx = { cwd: root, sessionManager: { resolveOwnArtifactsDir: async () => liveDir } };
	const toolCtx = { hasUI: false, setWorkingMessage() {}, ui: { select: async () => undefined } };
	await createRlmExtension()(api as never);
	const emit = async (type: string, event: object): Promise<void> => {
		for (const handler of handlers.get(type) ?? []) await handler({ type, ...event }, ctx);
	};
	await emit("session_start", {});
	return {
		liveDir,
		parentDir,
		root,
		flag: join(root, "serializing.flag"),
		warnings,
		emit,
		async run(code: string) {
			const result = await tools[0].execute(`c-${crypto.randomUUID()}`, { code }, undefined, undefined, toolCtx);
			return result.content.map(part => part.text).join("\n");
		},
	};
}

async function untilExists(path: string, what: string): Promise<void> {
	for (let attempt = 0; attempt < 6000; attempt++) {
		if (fs.existsSync(path)) return;
		await Bun.sleep(10);
	}
	throw new Error(`${what}: did not appear within the bound`);
}

function stagesIn(parentDir: string): string[] {
	return fs.existsSync(parentDir) ? fs.readdirSync(parentDir).filter(name => name.startsWith(STAGE_PREFIX)) : [];
}

function pairHashes(dir: string): Record<string, string> {
	const hashes: Record<string, string> = {};
	if (!fs.existsSync(dir)) return hashes;
	for (const name of fs.readdirSync(dir).sort()) {
		hashes[name] = crypto
			.createHash("sha256")
			.update(fs.readFileSync(join(dir, name)))
			.digest("hex")
			.slice(0, 16);
	}
	return hashes;
}

describe("POST-STAGE-1: the real runner stages outside the live directory; KernelManager alone commits", () => {
	test("a live directory removed while the REAL runner serializes stays absent, and no stage is left behind", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [x] C1 VALID: cites POST-STAGE-1 / POST-KM-NO-RESURRECT-1 (present in contracts/rlm-session-isolation.contract.ts)
		 *   [x] C2 VALUABLE: a runner that creates the live directory fails this test (it did at f5611865)
		 *   [x] C3 NON-DUPLICATIVE: the kernel.spec.ts tests use a fake transport whose writeSnapshot writes nothing
		 *   [x] C4 NOT FUTURE-EDIT: bounds a path the real provider performs today (the snapshot write)
		 * Risk tier: High - /delete during a snapshot resurrects a deleted session's artifacts.
		 */
		const s = await openSession("delete");
		try {
			await s.run(SLOW_CLASS(s.flag, 2));
			const flushing = s.emit("session_before_switch", { targetSessionFile: "synthetic" });
			await untilExists(s.flag, "the real runner entering serialization");
			fs.rmSync(s.liveDir, { recursive: true, force: true }); // the host's /delete lands mid-serialization
			await flushing;

			expect(
				fs.existsSync(s.liveDir),
				"POST-STAGE-1 violation: the real runner re-created the live artifacts directory the host removed\n" +
					"EXPECTED: the removed live directory stays absent\n" +
					`ACTUAL: present with ${JSON.stringify(fs.existsSync(s.liveDir) ? fs.readdirSync(s.liveDir) : [])}\n` +
					"GUIDANCE: a snapshot of a removed directory is skipped; nothing the provider writes may reach it",
			).toBe(false);
			expect(stagesIn(s.parentDir), "POST-STAGE-1 violation: an owned stage outlived its snapshot").toEqual([]);
		} finally {
			await s.emit("session_shutdown", {});
		}
	}, 120_000);

	test("a snapshot abandoned by the flush timeout leaves the committed payload and manifest byte-identical when the REAL runner finally finishes", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [x] C1 VALID: cites POST-STAGE-1 / POST-KM-SNAPSHOT-PAIR-1
		 *   [x] C2 VALUABLE: a runner that replaces the live pair after the timeout fails this test
		 *   [x] C3 NON-DUPLICATIVE: kernel.spec.ts proves abandonment only against a fake transport
		 *   [x] C4 NOT FUTURE-EDIT: bounds the abandoned-write path the real provider performs today
		 * Risk tier: High - a late runner write races the host's copy of the same directory.
		 */
		const s = await openSession("timeout");
		try {
			await s.run("seed = 1\nprint('seeded')");
			await s.emit("session_before_switch", { targetSessionFile: "synthetic" }); // commits generation 1
			const committed = pairHashes(s.liveDir);
			expect(Object.keys(committed), "precondition: a real pair was committed").toEqual([
				"kernel-state.dill",
				"kernel-state.json",
			]);

			await s.run(SLOW_CLASS(s.flag, 7)); // serialization now outlasts SNAPSHOT_DISPOSE_TIMEOUT_MS (5 s)
			await s.emit("session_before_switch", { targetSessionFile: "synthetic" }); // returns when the bound expires
			expect(
				s.warnings.some(w => w.includes("did not settle")),
				"precondition: the flush was abandoned by its bound and surfaced",
			).toBe(true);
			// The runner is single-threaded: this cell queues behind the abandoned snapshot, so it returns only after
			// the runner has finished that work. That is the observable barrier, not a sleep.
			await s.run("print('after-abandoned-snapshot')");

			expect(
				pairHashes(s.liveDir),
				"POST-STAGE-1 violation: an abandoned snapshot changed the committed pair when the real runner finished\n" +
					"EXPECTED: payload and manifest byte-identical to the last committed generation, no other file\n" +
					"GUIDANCE: work abandoned by the bound never reaches the live directory",
			).toEqual(committed);
			expect(
				stagesIn(s.parentDir),
				"POST-STAGE-1 violation: an owned stage outlived its abandoned snapshot",
			).toEqual([]);
		} finally {
			await s.emit("session_shutdown", {});
		}
	}, 120_000);

	test("the runner writes into a 0700 stage beside the live directory, never into it, and a committed payload is 0600", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [x] C1 VALID: cites POST-STAGE-1
		 *   [x] C2 VALUABLE: a provider that writes the live pair directly (no stage) fails this test
		 *   [x] C3 NON-DUPLICATIVE: observes the stage and live directory DURING serialization; the two tests above observe the end state
		 *   [x] C4 NOT FUTURE-EDIT: bounds the staging path the contract now requires
		 * Risk tier: Medium.
		 */
		const s = await openSession("stage");
		try {
			await s.run(SLOW_CLASS(s.flag, 2));
			const flushing = s.emit("session_before_switch", { targetSessionFile: "synthetic" });
			await untilExists(s.flag, "the real runner entering serialization");
			const stages = stagesIn(s.parentDir);
			expect(
				stages.length,
				"POST-STAGE-1 violation: no owned stage beside the live directory while the runner serializes\n" +
					"EXPECTED: exactly one stage named .rlm-snapshot-stage-*\n" +
					`ACTUAL: ${JSON.stringify(stages)}`,
			).toBe(1);
			expect(
				fs.statSync(join(s.parentDir, stages[0])).mode & 0o777,
				"POST-STAGE-1 violation: stage root is not 0700",
			).toBe(0o700);
			expect(
				fs.readdirSync(s.liveDir),
				"POST-STAGE-1 violation: the live directory was written while the runner serialized",
			).toEqual([]);
			await flushing;

			expect(fs.readdirSync(s.liveDir).sort()).toEqual(["kernel-state.dill", "kernel-state.json"]);
			expect(
				fs.statSync(join(s.liveDir, "kernel-state.dill")).mode & 0o777,
				"POST-STAGE-1 violation: the committed payload is not 0600",
			).toBe(0o600);
			expect(stagesIn(s.parentDir), "POST-STAGE-1 violation: the stage was not removed after the commit").toEqual(
				[],
			);
		} finally {
			await s.emit("session_shutdown", {});
		}
	}, 120_000);
});
