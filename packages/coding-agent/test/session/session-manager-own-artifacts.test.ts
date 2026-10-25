/**
 * SessionManager.resolveOwnArtifactsDir — the typed, SessionManager-owned
 * ownership + readiness accessor the RLM extension uses to locate a session's
 * kernel-state (SessionManager -> RLM integration actor).
 *
 * CONTRACT AUTHORITY RECORD:
 * - Contract: contracts/rlm-session-isolation.contract.ts
 * - Clause: POST-SM-OWN-ARTIFACTS-READY-1 (REQ-RLM-REHYDRATE-003)
 *
 * Every test drives the REAL SessionManager / ArtifactManager /
 * copySessionArtifacts provider; there is no hand-written readiness fake.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type ReadonlySessionManager, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const SNAPSHOT = "kernel-state.dill";
const SNAPSHOT_BYTES = "PARENT_KERNEL_STATE";

function ownDirOf(sessionFile: string | undefined): string {
	if (sessionFile === undefined || !sessionFile.endsWith(".jsonl")) {
		throw new Error(
			`POST-SM-OWN-ARTIFACTS-READY-1 fixture: expected a .jsonl session file, got ${String(sessionFile)}`,
		);
	}
	return sessionFile.slice(0, -".jsonl".length);
}

/** Run a body with the agent dir redirected so breadcrumbs never touch the real home. */
async function withIsolatedAgentDir(prefix: string, body: (root: string) => Promise<void>): Promise<void> {
	using tempDir = TempDir.createSync(prefix);
	const previousAgentDir = getAgentDir();
	setAgentDir(path.join(tempDir.path(), "agent"));
	try {
		await body(tempDir.path());
	} finally {
		setAgentDir(previousAgentDir);
	}
}

/** A persisted parent session whose own artifacts directory already holds a kernel snapshot. */
function parentWithSnapshot(root: string): { parent: SessionManager; leafId: string; parentOwnDir: string } {
	const cwd = path.join(root, "project");
	const sessionDir = path.join(root, "sessions");
	fs.mkdirSync(cwd, { recursive: true });
	const parent = SessionManager.create(cwd, sessionDir);
	const leafId = parent.appendMessage({ role: "user", content: "seed", timestamp: 1 });
	const parentOwnDir = ownDirOf(parent.getSessionFile());
	fs.mkdirSync(parentOwnDir, { recursive: true });
	fs.writeFileSync(path.join(parentOwnDir, SNAPSHOT), SNAPSHOT_BYTES);
	return { parent, leafId, parentOwnDir };
}

describe("POST-SM-OWN-ARTIFACTS-READY-1: SessionManager.resolveOwnArtifactsDir", () => {
	it("resolves the branched session's own directory only after the real background artifact copy settles", async () => {
		await withIsolatedAgentDir("@omp-own-artifacts-ready-", async root => {
			const { parent, leafId, parentOwnDir } = parentWithSnapshot(root);
			try {
				const branchedFile = parent.createBranchedSession(leafId, { copyArtifacts: true });
				const branchedOwnDir = ownDirOf(branchedFile);
				expect(branchedOwnDir).not.toBe(parentOwnDir);

				// The host's copy runs in the background: probing right now races it.
				const racedProbe = fs.existsSync(path.join(branchedOwnDir, SNAPSHOT));
				expect(
					racedProbe,
					"POST-SM-OWN-ARTIFACTS-READY-1 fixture: the real copy must still be pending when createBranchedSession returns, otherwise this test cannot prove readiness",
				).toBe(false);

				const readOnly: ReadonlySessionManager = parent;
				const resolved = await readOnly.resolveOwnArtifactsDir();
				expect(
					resolved,
					"POST-SM-OWN-ARTIFACTS-READY-1 violation: must resolve the CURRENT session file's own directory",
				).toBe(branchedOwnDir);
				const copied = path.join(branchedOwnDir, SNAPSHOT);
				expect(
					fs.existsSync(copied),
					"POST-SM-OWN-ARTIFACTS-READY-1 violation: resolved before the background copy into the own session file settled",
				).toBe(true);
				expect(fs.readFileSync(copied, "utf8")).toBe(SNAPSHOT_BYTES);
				// Copy layout and source are unchanged.
				expect(fs.readFileSync(path.join(parentOwnDir, SNAPSHOT), "utf8")).toBe(SNAPSHOT_BYTES);
			} finally {
				await parent.close();
			}
		});
	});

	it("never returns an adopted parent's directory, and leaves getArtifactsDir()/getArtifactManager() semantics unchanged", async () => {
		await withIsolatedAgentDir("@omp-own-artifacts-adopted-", async root => {
			const { parent, parentOwnDir } = parentWithSnapshot(root);
			const parentManager = parent.getArtifactManager();
			if (parentManager === null) throw new Error("fixture: persisted parent must expose an artifact manager");

			const persistedChild = SessionManager.create(path.join(root, "project"), path.join(root, "child-sessions"));
			persistedChild.appendMessage({ role: "user", content: "child", timestamp: 2 });
			const inMemoryChild = SessionManager.inMemory(path.join(root, "project"));
			try {
				persistedChild.adoptArtifactManager(parentManager);
				inMemoryChild.adoptArtifactManager(parentManager);

				// Unchanged general semantics: adoption still shares the parent's artifact manager.
				expect(persistedChild.getArtifactsDir()).toBe(parentOwnDir);
				expect(persistedChild.getArtifactManager()).toBe(parentManager);
				expect(inMemoryChild.getArtifactsDir()).toBe(parentOwnDir);

				expect(
					await persistedChild.resolveOwnArtifactsDir(),
					"POST-SM-OWN-ARTIFACTS-READY-1 violation: a child with its own session file must resolve its OWN directory, not the adopted parent's",
				).toBe(ownDirOf(persistedChild.getSessionFile()));
				expect(
					await inMemoryChild.resolveOwnArtifactsDir(),
					"POST-SM-OWN-ARTIFACTS-READY-1 violation: a session with no session file owns no directory and must resolve null, never the adopted parent's",
				).toBeNull();
			} finally {
				await persistedChild.close();
				await inMemoryChild.close();
				await parent.close();
			}
		});
	});
});
