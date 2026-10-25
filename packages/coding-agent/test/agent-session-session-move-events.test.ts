/**
 * POST-SESSION-MOVE-1 (contracts/rlm-session-isolation.contract.ts): when the host relocates the active session -
 * the explicit /move, or a persistence move-off that re-keys the session to a sibling file - it emits the existing
 * lifecycle events with reason "move", so an extension (the RLM kernel) can rebind to the session's new directory.
 *
 * Every test drives the REAL AgentSession, SessionManager and ExtensionRunner; only the extension handlers are
 * test code. Covers Copilot comments 4370059196 (persistence move-off) and 4369909544 (/move).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
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

interface Observed {
	readonly type: string;
	readonly reason: string | undefined;
	readonly previousSessionFile: string | undefined;
	/** The session file the manager reported at the instant the hook ran. */
	readonly fileAtEvent: string | undefined;
}

const cleanup: Array<() => Promise<void>> = [];
let sharedDir: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

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

beforeAll(async () => {
	sharedDir = TempDir.createSync("@pi-session-move-events-shared-");
	authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
	modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir.path(), "models.yml"));
});

afterAll(() => {
	authStorage.close();
	sharedDir.removeSync();
});

afterEach(async () => {
	while (cleanup.length > 0) {
		const run = cleanup.pop();
		if (run) await run();
	}
});

async function harness(options: {
	sessionManager: SessionManager;
	cwd: string;
	cancelMoveBefore?: boolean;
	onObserved?: (observed: Observed) => void;
}): Promise<{ session: AgentSession; observed: Observed[] }> {
	const observed: Observed[] = [];
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		(pi: ExtensionAPI) => {
			const record = (event: { type: string; reason?: string; previousSessionFile?: string }) => {
				const entry: Observed = {
					type: event.type,
					reason: event.reason,
					previousSessionFile: event.previousSessionFile,
					fileAtEvent: options.sessionManager.getSessionFile(),
				};
				observed.push(entry);
				options.onObserved?.(entry);
			};
			pi.on("session_before_switch", event => {
				record(event as { type: string; reason?: string });
				if (options.cancelMoveBefore && (event as { reason?: string }).reason === "move") return { cancel: true };
				return undefined;
			});
			pi.on("session_switch", event => {
				record(event as { type: string; reason?: string; previousSessionFile?: string });
			});
		},
		options.cwd,
		new EventBus(),
		runtime,
		"observe-session-move",
	);
	const extensionRunner = new ExtensionRunner(
		[extension],
		runtime,
		options.cwd,
		options.sessionManager,
		modelRegistry,
	);
	const agent = new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [] } });
	const session = new AgentSession({
		agent,
		sessionManager: options.sessionManager,
		settings: Settings.isolated(),
		modelRegistry,
		extensionRunner,
	});
	cleanup.push(async () => {
		await session.dispose();
	});
	return { session, observed };
}

const userTurn = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });

describe("POST-SESSION-MOVE-1: the host announces a session relocation with reason 'move'", () => {
	it("/move emits session_before_switch(move) before relocating and session_switch(move) after, naming the old file", async () => {
		using tempDir = TempDir.createSync("@pi-session-move-explicit-");
		using target = TempDir.createSync("@pi-session-move-target-");
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		sessionManager.appendMessage(userTurn("hello"));
		await sessionManager.flush();
		const oldFile = sessionManager.getSessionFile();
		expect(oldFile).toBeDefined();
		const { session, observed } = await harness({ sessionManager, cwd: tempDir.path() });

		await session.moveSession(target.path());

		const newFile = sessionManager.getSessionFile();
		expect(newFile).toBeDefined();
		expect(newFile).not.toBe(oldFile);
		expect(
			observed.map(o => `${o.type}:${o.reason}`),
			"POST-SESSION-MOVE-1 violation: /move did not announce itself with the existing lifecycle events",
		).toEqual(["session_before_switch:move", "session_switch:move"]);
		expect(observed[0].fileAtEvent, "the before hook must run while the session is still at its old file").toBe(
			oldFile,
		);
		expect(observed[1].previousSessionFile).toBe(oldFile);
		expect(observed[1].fileAtEvent).toBe(newFile);
	});

	it("an extension that cancels session_before_switch(move) leaves the session unmoved and the move refused", async () => {
		using tempDir = TempDir.createSync("@pi-session-move-cancel-");
		using target = TempDir.createSync("@pi-session-move-cancel-target-");
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		sessionManager.appendMessage(userTurn("hello"));
		await sessionManager.flush();
		const oldFile = sessionManager.getSessionFile();
		const { session, observed } = await harness({ sessionManager, cwd: tempDir.path(), cancelMoveBefore: true });

		let failure: unknown;
		try {
			await session.moveSession(target.path());
		} catch (error) {
			failure = error;
		}

		expect(failure, "POST-SESSION-MOVE-1 violation: a cancelled move was carried out or not reported").toBeInstanceOf(
			Error,
		);
		expect((failure as Error).name).toBe("SessionMoveRefusedError");
		expect(sessionManager.getSessionFile()).toBe(oldFile);
		expect(observed.map(o => `${o.type}:${o.reason}`)).toEqual(["session_before_switch:move"]);
	});

	it("moving to the directory the session already lives in announces nothing", async () => {
		using tempDir = TempDir.createSync("@pi-session-move-noop-");
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		sessionManager.appendMessage(userTurn("hello"));
		await sessionManager.flush();
		const { session, observed } = await harness({ sessionManager, cwd: tempDir.path() });

		await session.moveSession(tempDir.path());

		expect(observed, "POST-SESSION-MOVE-1 violation: a no-op move was announced").toEqual([]);
	});

	it("a persistence move-off to a sibling file emits session_switch(move) naming the file it left", async () => {
		using tempDir = TempDir.createSync("@pi-session-move-off-");
		const creator = SessionManager.create(tempDir.path(), tempDir.path(), new FileSessionStorage());
		await creator.ensureOnDisk();
		creator.appendMessage(userTurn("first"));
		const owned = creator.getSessionFile();
		const ownedId = creator.getSessionId();
		if (!owned) throw new Error("Expected a session file");
		await creator.close();

		const storage = new OwnedElsewhereStorage(ownedId);
		const ours = await SessionManager.open(owned, tempDir.path(), storage, { suppressBreadcrumb: true });
		const moved = Promise.withResolvers<Observed>();
		const { observed } = await harness({
			sessionManager: ours,
			cwd: tempDir.path(),
			onObserved: entry => {
				if (entry.type === "session_switch") moved.resolve(entry);
			},
		});

		ours.appendMessage(userTurn("after the conflict"));
		await ours.flush();
		const sibling = ours.getSessionFile();
		expect(sibling).not.toBe(owned);

		// Await the lifecycle event itself; a missing event fails this test by its own timeout, naming no guessed delay.
		const entry = await moved.promise;
		expect(
			entry,
			"POST-SESSION-MOVE-1 violation: a persistence move-off re-keyed the session without any lifecycle event",
		).toBeDefined();
		expect(entry?.reason).toBe("move");
		expect(entry?.previousSessionFile).toBe(owned);
		expect(observed.filter(o => o.type === "session_switch").length).toBe(1);
	});

	it("a move-off that happened before the AgentSession existed is not replayed as a lifecycle event", async () => {
		using tempDir = TempDir.createSync("@pi-session-move-replay-");
		const creator = SessionManager.create(tempDir.path(), tempDir.path(), new FileSessionStorage());
		await creator.ensureOnDisk();
		creator.appendMessage(userTurn("first"));
		const owned = creator.getSessionFile();
		const ownedId = creator.getSessionId();
		if (!owned) throw new Error("Expected a session file");
		await creator.close();

		const storage = new OwnedElsewhereStorage(ownedId);
		const ours = await SessionManager.open(owned, tempDir.path(), storage, { suppressBreadcrumb: true });
		ours.appendMessage(userTurn("conflict happens before any AgentSession"));
		await ours.flush();
		expect(ours.getSessionFile()).not.toBe(owned);

		const { observed } = await harness({ sessionManager: ours, cwd: tempDir.path() });
		// Yield one event-loop turn so any (wrongly) dispatched lifecycle event would have reached the handlers.
		await new Promise<void>(resolve => setImmediate(resolve));

		expect(
			observed,
			"POST-SESSION-MOVE-1 violation: an old persistence notice was replayed as a lifecycle event",
		).toEqual([]);
	});
});
