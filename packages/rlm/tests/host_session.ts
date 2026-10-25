/**
 * Real host-session fixtures for RLM lifecycle tests.
 *
 * Every session here is a REAL coding-agent SessionManager (and, through it, the
 * real ArtifactManager / copySessionArtifacts provider). Nothing in this module
 * imitates session ownership or copy readiness.
 */
import * as fs from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";

export interface HostContext {
	readonly cwd: string;
	readonly sessionManager: SessionManager;
	readonly hasUI: boolean;
	setWorkingMessage(): void;
	readonly ui: { select(): Promise<undefined> };
}

export interface PersistedSession {
	readonly sm: SessionManager;
	/** The session-owned artifacts directory (session file without `.jsonl`). */
	readonly ownDir: string;
	/** An entry id usable as a branch point. */
	readonly leafId: string;
}

/** Redirect the agent dir (terminal breadcrumbs) into `root`; returns the restore function. */
export function isolateAgentDir(root: string): () => void {
	const previous = getAgentDir();
	setAgentDir(join(root, "agent-home"));
	return () => setAgentDir(previous);
}

export function projectDir(root: string): string {
	const cwd = join(root, "project");
	fs.mkdirSync(cwd, { recursive: true });
	return cwd;
}

/** A persisted session with its own session file, under `<root>/sessions/<label>`. */
export async function persistedSession(root: string, label: string): Promise<PersistedSession> {
	const sm = SessionManager.create(projectDir(root), join(root, "sessions", label));
	const leafId = sm.appendMessage({ role: "user", content: `seed ${label}`, timestamp: 1 });
	const ownDir = await sm.resolveOwnArtifactsDir();
	if (ownDir === null) throw new Error(`fixture: persisted session ${label} must own an artifacts directory`);
	return { sm, ownDir, leafId };
}

/** A session with no session file that adopted `parent`'s artifact manager (subagent shape). */
export function adoptedInMemorySession(root: string, parent: SessionManager): SessionManager {
	const parentManager = parent.getArtifactManager();
	if (parentManager === null) throw new Error("fixture: parent must expose an artifact manager");
	const sm = SessionManager.inMemory(projectDir(root));
	sm.adoptArtifactManager(parentManager);
	return sm;
}

/** A persisted session that adopted `parent`'s artifact manager but owns its own session file. */
export async function adoptedPersistedSession(
	root: string,
	label: string,
	parent: SessionManager,
): Promise<PersistedSession> {
	const child = await persistedSession(root, label);
	const parentManager = parent.getArtifactManager();
	if (parentManager === null) throw new Error("fixture: parent must expose an artifact manager");
	child.sm.adoptArtifactManager(parentManager);
	return child;
}

export function hostContext(root: string, sessionManager: SessionManager): HostContext {
	return {
		cwd: projectDir(root),
		sessionManager,
		hasUI: false,
		setWorkingMessage() {},
		ui: {
			async select() {
				return undefined;
			},
		},
	};
}

export function writeSnapshot(dir: string, contents: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(join(dir, "kernel-state.dill"), contents);
}
