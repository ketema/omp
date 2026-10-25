/**
 * RLM session lifecycle: which kernel serves the CURRENT session, and what each lifecycle event does to it.
 *
 * Extracted from createRlmExtension (a behavior-preserving move) so the extension factory only wires registrations. The
 * contract authority is contracts/rlm-session-isolation.contract.ts: POST-SESSION-OWNED-DIR-1, POST-SESSION-READINESS-1,
 * POST-SESSION-RESOLUTION-GATE-1, POST-SESSION-TRANSITION-GEN-1, POST-SESSION-SHUTDOWN-RACE-1,
 * POST-SESSION-MOVE-1/2/3, POST-SESSION-FALLBACK-ISOLATION-1, POST-SESSION-NO-OWNED-DIR-ISOLATION-1,
 * POST-SESSION-NO-SIDE-EFFECT-1, POST-SESSION-PREFLUSH-1, POST-TOOL-SESSION-BINDING-1, ERRORS-TOOL-SESSION-CHANGED-1,
 * ERRORS-SESSION-SWITCH-DISPOSE-1 and ERRORS-SESSION-RESOLUTION-FAILED-1.
 */

import * as fs from "node:fs";
import { join } from "node:path";
import type { RlmExtensionKernelPort } from "./extension";
import { RlmSessionChangedError, type RlmToolKernelPort } from "./tool";

/**
 * Where the CURRENT session's kernel state lives (POST-SESSION-NO-SIDE-EFFECT-1): a directory the host says the
 * session owns, or an isolated directory that is NOT yet allocated. Lifecycle events only record this; nothing is
 * created and nothing is announced until a kernel is actually constructed for the session.
 */
type IncomingArtifacts =
	| { readonly kind: "resolved"; readonly dir: string }
	| { readonly kind: "unallocated"; readonly cwd: string; readonly reason: string };

/** What the lifecycle needs from its surroundings. */
export interface SessionLifecycleHost {
	/** Delivers a custom message to the host at its next turn. */
	notify(customType: string, content: string, display: boolean): void;
	/** Builds the kernel port for the RESOLVED session artifacts directory (POST-SESSION-RESOLUTION-GATE-1). */
	buildKernel(dir: string): Promise<RlmExtensionKernelPort> | RlmExtensionKernelPort;
}

type HostSessionContext = {
	cwd?: string;
	sessionManager?: { resolveOwnArtifactsDir?: () => Promise<string | null> };
};

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class RlmSessionLifecycle {
	private kernel: RlmExtensionKernelPort | null = null;
	// null until a lifecycle event describes the session's directory (or first use allocates a fallback).
	private incoming: IncomingArtifacts | null = null;
	// POST-SESSION-RESOLUTION-GATE-1: the in-flight transition's directory resolution, and the single in-flight kernel
	// construction. A kernel is only ever built against a resolved directory.
	private pendingResolution: Promise<IncomingArtifacts | null> | null = null;
	private kernelConstruction: Promise<RlmExtensionKernelPort> | null = null;
	// POST-SESSION-TRANSITION-GEN-1 / POST-SESSION-SHUTDOWN-RACE-1: every lifecycle transition takes a generation at
	// entry; a transition that is no longer the latest (a newer one began, or shutdown invalidated it) never publishes a
	// directory, restores, or constructs a kernel.
	private generation = 0;

	constructor(private readonly host: SessionLifecycleHost) {}

	/** The current kernel's restored names (empty when none is live). */
	restoredNames(): readonly string[] {
		return this.kernel === null ? [] : this.kernel.restoredNames();
	}

	/** POST-TOOL-SESSION-BINDING-1: capture the kernel current NOW (or build it) and return a port bound to it. */
	acquire(): Promise<RlmToolKernelPort> {
		const current = this.kernel;
		if (current !== null) return Promise.resolve(this.bindKernel(current));
		return this.ensureKernel().then(kernel => this.bindKernel(kernel));
	}

	// Lazy, single-flight kernel construction — deferred until first use, gated on directory resolution.
	async ensureKernel(): Promise<RlmExtensionKernelPort> {
		if (this.kernel !== null) return this.kernel;
		if (this.kernelConstruction === null) {
			const construction = this.constructKernel(this.pendingResolution);
			this.kernelConstruction = construction;
			const clear = () => {
				if (this.kernelConstruction === construction) this.kernelConstruction = null;
			};
			construction.then(clear, clear);
		}
		return this.kernelConstruction;
	}

	private async constructKernel(
		resolutionAtStart: Promise<IncomingArtifacts | null> | null,
	): Promise<RlmExtensionKernelPort> {
		// Wait for the resolution in flight at entry only: a newer transition waits for THIS construction (to dispose
		// it), so waiting on it here would deadlock. The kernel belongs to the transition it started under: use THAT
		// transition's resolved directory even if a newer transition has since begun.
		const resolvedAtStart = resolutionAtStart !== null ? await resolutionAtStart : null;
		// POST-SESSION-NO-OWNED-DIR-ISOLATION-1 / NO-SIDE-EFFECT-1: an unowned session (or first use before any lifecycle
		// event) allocates its fresh isolated directory - and announces it - only now.
		const target: IncomingArtifacts = resolvedAtStart ??
			this.incoming ?? {
				kind: "unallocated",
				cwd: process.cwd(),
				reason: "No session lifecycle event resolved an artifacts directory before first kernel use",
			};
		const dir = target.kind === "resolved" ? target.dir : this.allocateIsolatedFallback(target.cwd, target.reason);
		// Remember it: exactly one directory and one announcement per session.
		this.incoming = { kind: "resolved", dir };
		// A synchronous builder (the test seam) yields no extra turn; only an asynchronous one is awaited.
		const built = this.host.buildKernel(dir);
		const created = built instanceof Promise ? await built : built;
		this.kernel = created;
		return created;
	}

	// POST-SESSION-FALLBACK-ISOLATION-1: a dedicated atomically unique (mkdtemp) directory, announced by an observable
	// warning naming it. It starts empty, so nothing is ever restored into it.
	private allocateIsolatedFallback(cwd: string, reason: string): string {
		const artifactsRoot = join(cwd, ".omp", "artifacts");
		fs.mkdirSync(artifactsRoot, { recursive: true });
		const fallbackDir = fs.mkdtempSync(join(artifactsRoot, `isolated-${Date.now()}-`));
		this.host.notify(
			"rlm-warning",
			`Warning: ${reason}. Starting with fresh isolated state; no snapshot restored. Fallback isolated directory assigned: ${fallbackDir}`,
			false,
		);
		return fallbackDir;
	}

	// POST-TOOL-SESSION-BINDING-1: a port bound to ONE kernel object. Each call is made on that object, and only while it
	// is still the lifecycle's current kernel; otherwise the call is not made and the invocation aborts visibly
	// (ERRORS-TOOL-SESSION-CHANGED-1). No per-call global slot, no lock: the check is a plain identity comparison and a
	// session transition never waits for a running cell.
	private bindKernel(bound: RlmExtensionKernelPort): RlmToolKernelPort {
		const assertCurrent = (): void => {
			if (this.kernel !== bound) throw new RlmSessionChangedError();
		};
		return {
			async ensureStarted(onProgress) {
				assertCurrent();
				await bound.ensureStarted(onProgress);
			},
			async execute(code) {
				assertCurrent();
				return bound.execute(code);
			},
			async kill() {
				assertCurrent();
				await bound.kill();
			},
			async dispose() {
				assertCurrent();
				await bound.dispose();
			},
			restoredNames() {
				return bound.restoredNames();
			},
		};
	}

	/** SEQ-KM-5: after a compaction the kernel announces what it persisted, once. */
	async onCompactionComplete(): Promise<void> {
		const kernel = await this.ensureKernel();
		await kernel.onCompactionComplete();
		const notice = kernel.compactionNotice();
		if (notice !== null) this.host.notify("rlm-compaction", notice, false);
	}

	// POST-SESSION-PREFLUSH-1: flush BEFORE the host copies artifacts. Never disposes (these hooks are cancellable),
	// never cancels the transition; a failure is surfaced, not swallowed.
	async preTransitionFlush(): Promise<void> {
		if (this.kernel === null) return;
		try {
			await this.kernel.flushSnapshot();
		} catch (err) {
			this.host.notify(
				"rlm-warning",
				`Warning: Pre-transition snapshot flush failed; a fork or branch may copy stale kernel state: ${errorText(err)}`,
				true,
			);
		}
	}

	// Save and dispose the outgoing kernel to prevent cross-session leakage (Comment 4366356325)
	private async disposeOutgoingKernel(): Promise<void> {
		const outgoing = this.kernel;
		if (outgoing === null) return;
		// POST-TOOL-SESSION-BINDING-1: relinquish ownership BEFORE the awaited dispose, so every later call from a cell
		// bound to this kernel fails closed instead of reaching the incoming session.
		this.kernel = null;
		try {
			await outgoing.dispose();
			// Check for observable teardown failure notices from KernelManager
			const teardownNotice = outgoing.takeTeardownNotice?.();
			if (teardownNotice) this.host.notify("rlm-warning", `Warning: ${teardownNotice}`, true);
		} catch (err) {
			// ERRORS-SESSION-SWITCH-DISPOSE-1: Surface observable diagnostic on flush failure
			this.host.notify(
				"rlm-warning",
				`Warning: Failed to cleanly dispose outgoing kernel during session switch: ${errorText(err)}`,
				true,
			);
		}
	}

	// POST-SESSION-MOVE-3: retarget the live kernel to the session's new owned directory. Returns whether a live kernel
	// was retargeted (false: none was live, so the ordinary restore applies). A flush that cannot settle is surfaced,
	// never silent; the kernel stays live and later snapshots land in the new directory.
	private async retargetLiveKernel(dir: string): Promise<boolean> {
		const live = this.kernel;
		if (live === null) return false;
		try {
			await live.retarget(dir);
		} catch (err) {
			this.host.notify(
				"rlm-warning",
				`Warning: Snapshot flush after the session move failed: ${errorText(err)}`,
				true,
			);
		}
		return true;
	}

	// POST-SESSION-OWNED-DIR-1 / POST-SESSION-READINESS-1: the kernel-state directory is exactly what the host's typed
	// sessionManager.resolveOwnArtifactsDir() returns: the CURRENT session file's own directory, resolved only after the
	// host's background artifact copy into that file has settled. getArtifactsDir()/getArtifactManager() are never
	// consulted: under adoption they name the parent's.
	private async resolveIncomingArtifactsDir(ctx: unknown): Promise<IncomingArtifacts> {
		const sessionCtx = ctx as HostSessionContext | undefined;
		const effectiveCwd = sessionCtx?.cwd ?? process.cwd();
		const sessionManager = sessionCtx?.sessionManager;
		let ownDir: string | null = null;
		let noOwnedDirReason: string;
		if (sessionManager === undefined) {
			noOwnedDirReason = "No session context supplied";
		} else if (typeof sessionManager.resolveOwnArtifactsDir !== "function") {
			noOwnedDirReason =
				"Session-owned artifacts directory cannot be established: host SessionManager lacks resolveOwnArtifactsDir()";
		} else {
			ownDir = await sessionManager.resolveOwnArtifactsDir();
			noOwnedDirReason = "Session has no session file, so it owns no artifacts directory";
		}
		// POST-SESSION-NO-OWNED-DIR-ISOLATION-1: no owned directory -> fresh isolated state, never a shared root.
		// Allocation is deferred (POST-SESSION-NO-SIDE-EFFECT-1).
		return ownDir !== null
			? { kind: "resolved", dir: ownDir }
			: { kind: "unallocated", cwd: effectiveCwd, reason: noOwnedDirReason };
	}

	// Handle session start, session switches, and branches (for /new, /fork, /resume, /branch)
	async handleSessionInit(event: unknown, ctx?: unknown): Promise<void> {
		const myGeneration = ++this.generation;
		const isCurrent = (): boolean => myGeneration === this.generation;
		// POST-SESSION-MOVE-2: the session is being relocated (the host's artifact copy started BEFORE this event). The
		// outgoing kernel's final snapshot must land in the session's NEW owned directory, after that copy has settled, so
		// the namespace executed since its last snapshot is not lost to the older copied one.
		const relocating = (event as { reason?: string } | undefined)?.reason === "move";
		const outcome = { retargeted: false };
		const resolution = this.runTransition(relocating, ctx, isCurrent, outcome);
		this.pendingResolution = resolution;
		try {
			await resolution;
		} finally {
			if (this.pendingResolution === resolution) this.pendingResolution = null;
		}
		// A newer transition started while this one resolved (or shutdown invalidated it); it owns the incoming
		// session's restore.
		const resolvedIncoming = this.incoming;
		if (!isCurrent() || this.pendingResolution !== null || resolvedIncoming === null) return;
		// An unallocated (unowned) session has nothing to restore: it starts fresh and isolated.
		const hasSnapshot =
			!outcome.retargeted &&
			resolvedIncoming.kind === "resolved" &&
			fs.existsSync(join(resolvedIncoming.dir, "kernel-state.dill"));
		if (hasSnapshot) await this.restoreIncoming();
	}

	/** The directory-resolution half of a transition: what happens to the outgoing kernel, and which directory is next. */
	private async runTransition(
		relocating: boolean,
		ctx: unknown,
		isCurrent: () => boolean,
		outcome: { retargeted: boolean },
	): Promise<IncomingArtifacts | null> {
		// POST-SESSION-RESOLUTION-GATE-1: a construction already in flight targets the outgoing session; let it finish so
		// it is disposed below instead of surviving into this session. Its failure is delivered to the caller that
		// requested the kernel, so it is not re-raised here.
		if (this.kernelConstruction !== null) await this.kernelConstruction.catch(() => undefined);
		if (!relocating) await this.disposeOutgoingKernel();
		// ERRORS-SESSION-RESOLUTION-FAILED-1: forget the outgoing directory before resolving, so a failed or abandoned
		// resolution can never leave it selectable by the next kernel. A superseded transition still resolves (a kernel
		// requested during it is built on ITS directory) but never touches the published state a newer transition owns.
		if (isCurrent()) this.incoming = null;
		let resolved: IncomingArtifacts;
		try {
			resolved = await this.resolveIncomingArtifactsDir(ctx);
		} catch (err) {
			if (isCurrent()) {
				this.incoming = {
					kind: "unallocated",
					cwd: (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd(),
					reason: `Incoming session artifacts directory could not be resolved (${err instanceof Error ? err.name : "error"})`,
				};
			}
			// A relocation whose directory cannot be resolved falls back to the ordinary dispose; the error propagates.
			if (relocating && isCurrent()) await this.disposeOutgoingKernel();
			throw err;
		}
		// POST-SESSION-MOVE-3: a relocation keeps the SAME kernel (the same logical session): it is retargeted to the new
		// owned directory and its live namespace flushed there. A relocation superseded by a newer transition neither
		// retargets nor flushes: the newest owns both.
		if (relocating && isCurrent()) {
			if (resolved.kind === "resolved") {
				outcome.retargeted = await this.retargetLiveKernel(resolved.dir);
			} else {
				await this.disposeOutgoingKernel();
			}
		}
		// POST-SESSION-TRANSITION-GEN-1: a stale completion never publishes its directory.
		if (isCurrent()) this.incoming = resolved;
		return resolved;
	}

	/** The restore half: start the kernel on the resolved directory and announce what came back (IP-2). */
	private async restoreIncoming(): Promise<void> {
		try {
			const kernel = await this.ensureKernel();
			await kernel.ensureStarted();
			const names = kernel.restoredNames();
			const skipped = kernel.restoredSkipped?.() ?? [];
			if (names.length === 0 && skipped.length === 0) return;
			const parts: string[] = [];
			if (names.length > 0) {
				parts.push(`IPython state restored. The following names are available again: ${names.join(", ")}`);
			}
			if (skipped.length > 0) {
				// IP-2: each skipped variable keeps the reason the runner reported, so an operator can tell a refused file
				// handle from a corrupt blob.
				const skippedNames = skipped.map(s => `${s.name} (${s.reason})`).join(", ");
				parts.push(`Warning: The following unpicklable variables were skipped: ${skippedNames}`);
			}
			this.host.notify("rlm-revival", parts.join("\n"), true);
		} catch {
			// Non-fatal on session_start / session_switch / session_branch: lazy start will retry on first explicit tool invocation
		}
	}

	/** POST-SESSION-SHUTDOWN-RACE-1: invalidate every in-flight transition, then dispose the current kernel. */
	async shutdown(): Promise<void> {
		// A pending resolution never constructs a kernel once it settles. Shutdown does not wait for a possibly stuck
		// resolution.
		this.generation++;
		// Never orphan a kernel whose construction is still in flight (its failure surfaces to its requester).
		if (this.kernelConstruction !== null) await this.kernelConstruction.catch(() => undefined);
		const outgoing = this.kernel;
		this.kernel = null; // in-flight cells bound to it abort visibly instead of reaching a replacement kernel
		if (outgoing !== null) await outgoing.dispose();
	}
}
