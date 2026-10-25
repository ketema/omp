/**
 * POST-SESSION-MOVE-1 / POST-SESSION-MOVE-2 (contracts/rlm-session-isolation.contract.ts) through the REAL host.
 *
 * The producer is the real SessionManager: a second process owns the session file, so the next append re-keys the
 * session to a sibling file and starts the background artifact copy (SessionManager.#moveOffSessionFile). The real
 * AgentSession turns that persistence notice into session_switch(reason "move"); the real ExtensionRunner delivers it
 * to the REAL RLM extension (default kernel factory: real RlmTransport, KernelManager and the Python runner).
 * Nothing between the producer and Python is replaced.
 *
 * Needs the host native addon and a Python runtime, so it runs where the rest of the real-host specs run (the
 * dedicated RLM CI job). Interpreter: `RLM_TEST_PYTHON` when set, otherwise the managed venv via uv.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

import { createRlmExtension } from "../src/extension.ts";

/** A storage on which another live process owns `ownedElsewhere`, which forces the persistence move-off. */
class OwnedElsewhereStorage extends FileSessionStorage {
	readonly #ownedElsewhere: string;
	constructor(ownedElsewhere: string) {
		super();
		this.#ownedElsewhere = ownedElsewhere;
	}
	override claimSession(sessionId: string, sessionPath: string): (() => void) | null {
		return sessionId === this.#ownedElsewhere ? null : super.claimSession(sessionId, sessionPath);
	}
}

interface RlmTool {
	execute(
		toolCallId: string,
		params: { code: string },
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	): Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

const cleanup: Array<() => Promise<void>> = [];
let sharedDir: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(async () => {
	sharedDir = TempDir.createSync("@pi-rlm-move-off-real-host-");
	authStorage = await AuthStorage.create(join(sharedDir.path(), "auth.db"));
	modelRegistry = new ModelRegistry(authStorage, join(sharedDir.path(), "models.yml"));
});
afterAll(() => {
	authStorage.close();
	sharedDir.removeSync();
});
afterEach(async () => {
	while (cleanup.length > 0) await cleanup.pop()?.();
});

function hashes(dir: string): Record<string, string> {
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

const userTurn = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });
const toolCtx = { hasUI: false, setWorkingMessage() {}, ui: { select: async () => undefined } };

describe("a real persistence move-off keeps the live namespace (POST-SESSION-MOVE-1 / POST-SESSION-MOVE-2)", () => {
	test("real SessionManager producer -> real AgentSession event -> real extension and manager -> real Python restores marker2 in the new directory", async () => {
		/**
		 * FOUR-CRITERIA TEST VALIDITY GATE:
		 *   [x] C1 VALID: cites POST-SESSION-MOVE-1 and POST-SESSION-MOVE-2 (present in contracts/rlm-session-isolation.contract.ts)
		 *   [x] C2 VALUABLE: an extension that disposes into the old directory, or a host that never announces the move,
		 *       leaves marker1 in the new directory and fails this test
		 *   [x] C3 NON-DUPLICATIVE: session_move_snapshot.spec.ts scripts the host and Python; this one scripts neither
		 *   [x] C4 NOT FUTURE-EDIT: bounds the persistence move-off path the host performs today
		 * Risk tier: High - the move-off is the only moment the live state can be lost without a user action.
		 */
		using tempDir = TempDir.createSync("@pi-rlm-move-off-real-host-case-");
		const cwd = tempDir.path();

		// A second process owns the session file: this manager will be moved off it on its next append.
		const creator = SessionManager.create(cwd, cwd, new FileSessionStorage());
		await creator.ensureOnDisk();
		creator.appendMessage(userTurn("first"));
		const owned = creator.getSessionFile();
		const ownedId = creator.getSessionId();
		if (!owned) throw new Error("fixture: expected a session file");
		await creator.close();
		const ownedDir = owned.slice(0, -".jsonl".length);

		const ours = await SessionManager.open(owned, cwd, new OwnedElsewhereStorage(ownedId), {
			suppressBreadcrumb: true,
		});

		// The REAL extension on the REAL runner; only the flag lookup is wrapped so it can name the interpreter.
		let rlmTool: RlmTool | undefined;
		const flags: Record<string, string> = { OMP_RLM_AGENT_DIR: join(cwd, "rlm-agent") };
		if (process.env.RLM_TEST_PYTHON) flags.RLM_KERNEL_PYTHON = process.env.RLM_TEST_PYTHON;
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			async (pi: ExtensionAPI) => {
				const api = new Proxy(pi, {
					get(target, property, receiver) {
						if (property === "getFlag") return (name: string) => flags[name] ?? target.getFlag(name);
						if (property === "registerTool") {
							return (tool: RlmTool & Parameters<ExtensionAPI["registerTool"]>[0]) => {
								rlmTool = tool;
								return target.registerTool(tool);
							};
						}
						return Reflect.get(target, property, receiver);
					},
				});
				await createRlmExtension()(api as never);
			},
			cwd,
			new EventBus(),
			runtime,
			"rlm-move-off-real-host",
		);
		const extensionRunner = new ExtensionRunner([extension], runtime, cwd, ours, modelRegistry);
		const agent = new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [] } });
		const session = new AgentSession({
			agent,
			sessionManager: ours,
			settings: Settings.isolated(),
			modelRegistry,
			extensionRunner,
		});
		cleanup.push(async () => {
			await extensionRunner.emit({ type: "session_shutdown" });
			await session.dispose();
		});
		if (!rlmTool) throw new Error("fixture: the RLM extension did not register its tool");
		const run = async (code: string) =>
			(await rlmTool?.execute(`c-${crypto.randomUUID()}`, { code }, undefined, undefined, toolCtx))?.content[0]
				.text ?? "";

		await extensionRunner.emit({ type: "session_start" });
		expect(await run("marker = 1\nprint('marker=' + str(marker))")).toContain("marker=1");
		await extensionRunner.emit({ type: "session_before_switch", reason: "new" }); // real pre-transition flush: marker1 committed
		expect(await run("marker = 2\nprint('marker=' + str(marker))")).toContain("marker=2"); // live state, not yet snapshotted
		const oldDirBefore = hashes(ownedDir);
		expect(Object.keys(oldDirBefore), "precondition: the original directory holds the marker1 snapshot").toContain(
			"kernel-state.dill",
		);

		// The real producer: the next append re-keys the session to a sibling file and starts the background copy.
		ours.appendMessage(userTurn("after the conflict"));
		await ours.flush();
		const sibling = ours.getSessionFile();
		expect(sibling, "precondition: the host moved the session to a sibling file").not.toBe(owned);
		const newDir = await ours.resolveOwnArtifactsDir();
		expect(newDir).not.toBeNull();
		expect(newDir).not.toBe(ownedDir);

		// The move is handled asynchronously by the host; wait on the observable result, not on a delay.
		let observed = "";
		for (let attempt = 0; attempt < 240; attempt++) {
			observed = await run("print('marker=' + str(globals().get('marker')))");
			if (observed.includes("marker=2")) break;
			await Bun.sleep(250);
		}
		expect(
			observed,
			"POST-SESSION-MOVE-2 violation: the session restored after a real persistence move-off lost state executed after its last snapshot\nEXPECTED: marker=2 (live state)\nGUIDANCE: the outgoing kernel's final snapshot lands in the session's new owned directory",
		).toContain("marker=2");
		expect(hashes(ownedDir), "POST-SESSION-MOVE-2 violation: the superseded directory was written").toEqual(
			oldDirBefore,
		);
		expect(
			fs.existsSync(join(newDir ?? "", "kernel-state.dill")),
			"the new directory holds the committed snapshot",
		).toBe(true);
	}, 300_000);
});
