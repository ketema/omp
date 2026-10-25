/**
 * RLM extension — wires the tool, flags, commands, and lifecycle hooks
 * into omp's extension API surface.
 *
 * REQ-RLM-0002, REQ-RLM-0014, SEQ-BOOT-2, SEQ-KM-5 wiring, SEQ-TOOL-1.
 */

import * as fs from "node:fs";
import { join } from "node:path";
import { bootstrapManagedVenv, buildKernelEnv } from "./bootstrap";
import { EMBEDDED_RUNTIME_SOURCES, ensureExtractedAssets } from "./embedded_assets";
import type { KernelClock, KernelExecutionResult, KernelTransport } from "./kernel";
import { KernelManager } from "./kernel";
import {
	createRlmToolDefinition,
	RlmSessionChangedError,
	type RlmToolKernelPort,
	type RlmToolKernelResult,
} from "./tool";
import { createTransport } from "./transport";
// =============================================================================
// Config types
// =============================================================================

export interface RlmKernelConfig {
	kernelPython?: string;
	venvPath?: string;
	agentDir?: string;
	forkserver?: boolean;
	depth?: number;
	maxDepth?: number;
	modelSearchLimit?: number;
	nameMaxLength?: number;
}

// Mutable version for internal construction
type MutableKernelConfig = {
	-readonly [K in keyof RlmKernelConfig]: RlmKernelConfig[K];
};

/** The kernel port exposed to the extension, adding compaction and teardown lifecycle. */
export interface RlmExtensionKernelPort extends RlmToolKernelPort {
	onCompactionComplete(): Promise<void>;
	flushSnapshot(): Promise<void>;
	compactionNotice(): string | null;
	restoredSkipped?(): ReadonlyArray<{ readonly name: string; readonly reason: string }>;
	takeTeardownNotice?(): string | null;
}

// =============================================================================
// Structural ExtensionAPI (no coding-agent import — cycle-free)
// =============================================================================

interface StructuralToolDefinition {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: unknown;
	readonly executionMode: string;
	readonly execute: (
		toolCallId: string,
		params: { code: string },
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<unknown>;
	readonly onSession: (event: { reason: string }) => Promise<void>;
}

interface StructuralExtensionAPI {
	registerTool(tool: any): void;
	registerFlag(name: string, opts?: { type: "boolean" | "string"; default?: boolean | string }): void;
	registerCommand(name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }): void;
	on(event: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>): void;
	getFlag(name: string): string | boolean | undefined;
	sendMessage(payload: unknown, options?: { triggerTurn?: boolean; deliverAs?: string }): void;
}

// =============================================================================
// Kernel adapter — wraps KernelManager to satisfy RlmExtensionKernelPort
// =============================================================================

class KernelManagerAdapter implements RlmExtensionKernelPort {
	private readonly manager: KernelManager;
	private readonly transport: KernelTransport;
	private _restoredNames: readonly string[] = [];
	private _started = false;

	constructor(transport: KernelTransport, manager: KernelManager) {
		this.transport = transport;
		this.manager = manager;
	}

	async ensureStarted(onProgress?: (phase: "starting" | "restoring" | "preparing") => void): Promise<void> {
		if (this._started) return;
		await this.manager.ensureStarted(onProgress);
		this._started = true;
	}

	async execute(code: string): Promise<RlmToolKernelResult> {
		const result: KernelExecutionResult = await this.manager.execute(code);
		return {
			status: result.status,
			stdout: result.stdout,
			stderr: result.stderr,
			result: result.result,
			traceback: result.traceback,
			errorEname: result.errorEname,
			durationMs: result.durationMs,
			kernelRestarted: result.kernelRestarted,
		};
	}

	async kill(): Promise<void> {
		await this.transport.kill();
		this._started = false;
		// Reset the manager's started flag by re-admitting
		// The manager's kill() method resets the started flag
		await (this.manager as unknown as { kill(): Promise<void> }).kill();
	}

	async dispose(): Promise<void> {
		await this.manager.dispose({ snapshot: true });
	}

	async flushSnapshot(): Promise<void> {
		await this.manager.flushSnapshot();
	}

	takeTeardownNotice(): string | null {
		return this.manager.takeTeardownNotice();
	}

	restoredNames(): readonly string[] {
		return this.manager.restoredNames();
	}

	restoredSkipped(): ReadonlyArray<{ readonly name: string; readonly reason: string }> {
		return this.manager.restoredSkipped();
	}

	async onCompactionComplete(): Promise<void> {
		await this.manager.onCompactionComplete();
	}

	compactionNotice(): string | null {
		return this.manager.compactionNotice();
	}
}

// =============================================================================
// Default kernel factory
// =============================================================================

function resolveConfigFromFlags(api: StructuralExtensionAPI): RlmKernelConfig {
	const kernelPython = api.getFlag("RLM_KERNEL_PYTHON");
	const venvPath = api.getFlag("RLM_KERNEL_VENV");
	const agentDir = api.getFlag("OMP_RLM_AGENT_DIR");
	const depth = api.getFlag("RLM_DEPTH");
	const maxDepth = api.getFlag("RLM_MAX_DEPTH");
	const modelSearchLimit = api.getFlag("RLM_MODEL_SEARCH_LIMIT");
	const nameMaxLength = api.getFlag("RLM_NAME_MAX_LENGTH");
	const forkserver = api.getFlag("RLM_KERNEL_FORKSERVER");

	const config: MutableKernelConfig = {
		depth: typeof depth === "string" ? parseInt(depth, 10) : 0,
		maxDepth: typeof maxDepth === "string" ? parseInt(maxDepth, 10) : 1,
		modelSearchLimit: typeof modelSearchLimit === "string" ? parseInt(modelSearchLimit, 10) : 8,
		nameMaxLength: typeof nameMaxLength === "string" ? parseInt(nameMaxLength, 10) : 64,
		forkserver: typeof forkserver === "boolean" ? forkserver : true,
	};
	if (typeof kernelPython === "string") config.kernelPython = kernelPython;
	if (typeof venvPath === "string") config.venvPath = venvPath;
	if (typeof agentDir === "string") config.agentDir = agentDir;
	return config;
}

async function createDefaultKernel(config: RlmKernelConfig, artifactsDir: string): Promise<RlmExtensionKernelPort> {
	// Resolve interpreter via bootstrap
	const agentDir =
		config.agentDir ??
		join(
			// Default to ~/.omp/agent
			process.env.HOME ?? "/tmp",
			".omp",
			"agent",
		);
	const venvDir = config.venvPath ?? join(agentDir, "kernel-venv");
	const xdgDir = join(agentDir, "xdg");
	fs.mkdirSync(agentDir, { recursive: true });

	// Ensure physical Python runner and rlm-runtime package exist on disk
	const { runnerScriptPath, runtimePackagePath } = ensureExtractedAssets(agentDir);

	let interpreterPath: string;

	if (config.kernelPython !== undefined && config.kernelPython !== "") {
		// Explicit override — skip managed bootstrap
		interpreterPath = config.kernelPython;
	} else {
		// Managed venv bootstrap
		const result = await bootstrapManagedVenv(
			{
				venvDir,
				xdgDir,
			},
			{
				runner: {
					async run(cmd: string, args: readonly string[]) {
						let executable = cmd;
						if (cmd === "uv") {
							executable =
								Bun.which("uv") ||
								(fs.existsSync("/opt/homebrew/bin/uv")
									? "/opt/homebrew/bin/uv"
									: fs.existsSync("/usr/local/bin/uv")
										? "/usr/local/bin/uv"
										: "uv");
						}
						const proc = Bun.spawn({
							cmd: [executable, ...args],
							stdout: "pipe",
							stderr: "pipe",
							stdin: "ignore",
							// uv walks UP from cwd looking for a pyproject.toml; any
							// ancestor project whose requires-python excludes the managed
							// kernel interpreter would reject venv creation. agentDir is
							// neutral and created above.
							cwd: agentDir,
						});
						const stdout = await new Response(proc.stdout).text();
						const stderr = await new Response(proc.stderr).text();
						const code = await proc.exited;
						return { code, stdout, stderr };
					},
				},
				exists(path: string) {
					try {
						return fs.existsSync(path);
					} catch {
						return false;
					}
				},
				readTextFile(path: string) {
					try {
						return fs.readFileSync(path, "utf8");
					} catch {
						return null;
					}
				},
				runtimeSources: EMBEDDED_RUNTIME_SOURCES,
				runtimePackagePath,
				skills: [],
			},
		);
		interpreterPath = result.interpreterPath;
	}

	// Build spawn env via buildKernelEnv
	const sessionDir = artifactsDir;
	const harnessDir = join(artifactsDir, "harness");
	const globalHarnessDir = join(agentDir, "harness");

	const env = buildKernelEnv(
		{
			sessionDir,
			harnessDir,
			globalHarnessDir,
			agentDir,
			depth: config.depth ?? 0,
			maxDepth: config.maxDepth ?? 1,
		},
		{
			maxOutputChars: 65536,
			snapshotMaxBytes: 256 * 1024 * 1024,
		},
	);

	// Create transport
	const transport = createTransport({
		interpreter: interpreterPath,
		env,
		cwd: process.cwd(),
		artifactsDir,
		runnerScriptPath,
	});
	// Create kernel manager over the transport
	const clock: KernelClock = {
		now(): number {
			return Date.now();
		},
		schedule(fn: () => void, ms: number): () => void {
			const timer = setTimeout(fn, ms);
			return () => clearTimeout(timer);
		},
	};

	const manager = new KernelManager(transport, {
		clock,
		artifactsDir,
	});

	return new KernelManagerAdapter(transport, manager);
}

// =============================================================================
// Extension factory
// =============================================================================

/**
 * Where the CURRENT session's kernel state lives (POST-SESSION-NO-SIDE-EFFECT-1): a directory the host says the
 * session owns, or an isolated directory that is NOT yet allocated. Lifecycle events only record this; nothing is
 * created and nothing is announced until a kernel is actually constructed for the session.
 */
type IncomingArtifacts =
	| { readonly kind: "resolved"; readonly dir: string }
	| { readonly kind: "unallocated"; readonly cwd: string; readonly reason: string };

export interface CreateRlmExtensionOptions {
	/** Test seam: builds the kernel port for the RESOLVED session artifacts directory (POST-SESSION-RESOLUTION-GATE-1). */
	readonly createKernel?: (config: RlmKernelConfig, artifactsDir: string) => RlmExtensionKernelPort;
}

/**
 * Creates the RLM extension factory. Registers the tool, flags, commands,
 * and lifecycle hooks into the omp extension API.
 */
export function createRlmExtension(
	options?: CreateRlmExtensionOptions,
): (api: StructuralExtensionAPI) => Promise<void> {
	return async (api: StructuralExtensionAPI): Promise<void> => {
		let kernel: RlmExtensionKernelPort | null = null;
		// null until a lifecycle event describes the session's directory (or first use allocates a fallback).
		let incoming: IncomingArtifacts | null = null;
		// POST-SESSION-RESOLUTION-GATE-1: the in-flight transition's directory resolution, and the single
		// in-flight kernel construction. A kernel is only ever built against a resolved directory.
		let pendingResolution: Promise<IncomingArtifacts | null> | null = null;
		let kernelConstruction: Promise<RlmExtensionKernelPort> | null = null;
		// POST-SESSION-TRANSITION-GEN-1 / POST-SESSION-SHUTDOWN-RACE-1: every lifecycle transition takes a
		// generation at entry; a transition that is no longer the latest (a newer one began, or shutdown
		// invalidated it) never publishes a directory, restores, or constructs a kernel.
		let generation = 0;

		// POST-SESSION-FALLBACK-ISOLATION-1: a dedicated atomically unique (mkdtemp) directory, announced by an
		// observable warning naming it. It starts empty, so nothing is ever restored into it.
		const allocateIsolatedFallback = (cwd: string, reason: string): string => {
			const artifactsRoot = join(cwd, ".omp", "artifacts");
			fs.mkdirSync(artifactsRoot, { recursive: true });
			const fallbackDir = fs.mkdtempSync(join(artifactsRoot, `isolated-${Date.now()}-`));
			api.sendMessage(
				{
					role: "custom",
					customType: "rlm-warning",
					content: `Warning: ${reason}. Starting with fresh isolated state; no snapshot restored. Fallback isolated directory assigned: ${fallbackDir}`,
					display: false,
					attribution: "agent",
					timestamp: Date.now(),
				},
				{ deliverAs: "nextTurn" },
			);
			return fallbackDir;
		};

		// Lazy, single-flight kernel construction — deferred until first use, gated on directory resolution.
		const ensureKernel = async (): Promise<RlmExtensionKernelPort> => {
			if (kernel !== null) return kernel;
			if (kernelConstruction === null) {
				const resolutionAtStart = pendingResolution;
				const construction = (async (): Promise<RlmExtensionKernelPort> => {
					// Wait for the resolution in flight at entry only: a newer transition waits for THIS construction
					// (to dispose it), so waiting on it here would deadlock.
					// The kernel belongs to the transition it started under: use THAT transition's resolved directory
					// even if a newer transition has since begun (it waits for this construction and disposes it).
					const resolvedAtStart = resolutionAtStart !== null ? await resolutionAtStart : null;
					// POST-SESSION-NO-OWNED-DIR-ISOLATION-1 / NO-SIDE-EFFECT-1: an unowned session (or first use before
					// any lifecycle event) allocates its fresh isolated directory - and announces it - only now.
					const target: IncomingArtifacts = resolvedAtStart ??
						incoming ?? {
							kind: "unallocated",
							cwd: process.cwd(),
							reason: "No session lifecycle event resolved an artifacts directory before first kernel use",
						};
					const dir =
						target.kind === "resolved" ? target.dir : allocateIsolatedFallback(target.cwd, target.reason);
					// Remember it: exactly one directory and one announcement per session.
					incoming = { kind: "resolved", dir };
					const config = resolveConfigFromFlags(api);
					const created =
						options?.createKernel !== undefined
							? options.createKernel(config, dir)
							: await createDefaultKernel(config, dir);
					kernel = created;
					return created;
				})();
				kernelConstruction = construction;
				const clear = () => {
					if (kernelConstruction === construction) kernelConstruction = null;
				};
				construction.then(clear, clear);
			}
			return kernelConstruction;
		};

		// POST-TOOL-SESSION-BINDING-1: a port bound to ONE kernel object. Each call is made on that object, and
		// only while it is still the extension's current kernel; otherwise the call is not made and the invocation
		// aborts visibly (ERRORS-TOOL-SESSION-CHANGED-1). No per-call global slot, no lock: the check is a plain
		// identity comparison and a session transition never waits for a running cell.
		const bindKernel = (bound: RlmExtensionKernelPort): RlmToolKernelPort => {
			const assertCurrent = (): void => {
				if (kernel !== bound) throw new RlmSessionChangedError();
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
		};

		// registerTool: exactly ONE tool, the ipython tool
		const toolDef = createRlmToolDefinition({
			kernel: {
				ensureStarted(onProgress?: (phase: "starting" | "restoring" | "preparing") => void) {
					return ensureKernel().then(k => k.ensureStarted(onProgress));
				},
				execute(code: string) {
					return ensureKernel().then(k => k.execute(code));
				},
				kill() {
					return ensureKernel().then(k => k.kill());
				},
				dispose() {
					return ensureKernel().then(k => k.dispose());
				},
				restoredNames() {
					if (kernel === null) return [];
					return kernel.restoredNames();
				},
				acquire() {
					// Capture synchronously when a kernel exists, so the binding is the kernel current at entry.
					const current = kernel;
					if (current !== null) return Promise.resolve(bindKernel(current));
					return ensureKernel().then(bindKernel);
				},
			},
			onRevival: (names: readonly string[]) => {
				// SEQ-KM-5: revival notice enumerating restored names via api.sendMessage
				api.sendMessage(
					{
						role: "custom",
						customType: "rlm-revival",
						content: `IPython state restored. The following names are available again: ${names.join(", ")}`,
						display: true,
						attribution: "agent",
						timestamp: Date.now(),
					},
					{ deliverAs: "nextTurn" },
				);
			},
		});

		// Register tool with exactly the required keys (FORBIDDEN-TOOL-1)
		api.registerTool({
			name: toolDef.name,
			label: toolDef.label,
			description: toolDef.description,
			parameters: toolDef.parameters,
			executionMode: toolDef.executionMode,
			execute: toolDef.execute as StructuralToolDefinition["execute"],
			onSession: toolDef.onSession as StructuralToolDefinition["onSession"],
		});

		// registerFlag (REQ-RLM-0014, F-250..F-257)
		api.registerFlag("RLM_DEPTH", { type: "string", default: "0" });
		api.registerFlag("RLM_MAX_DEPTH", { type: "string", default: "1" });
		api.registerFlag("RLM_KERNEL_PYTHON", { type: "string" });
		api.registerFlag("RLM_KERNEL_FORKSERVER", { type: "boolean", default: true });
		api.registerFlag("OMP_RLM_AGENT_DIR", { type: "string" });
		api.registerFlag("RLM_KERNEL_VENV", { type: "string" });
		api.registerFlag("RLM_MODEL_SEARCH_LIMIT", { type: "string", default: "8" });
		api.registerFlag("RLM_NAME_MAX_LENGTH", { type: "string", default: "64" });

		// registerCommand (F-258): 'rlm-max-depth'
		api.registerCommand("rlm-max-depth", {
			async handler(args: string, _ctx: unknown): Promise<void> {
				const trimmed = args.trim();
				if (trimmed === "") {
					throw new Error("rlm-max-depth requires a non-negative integer argument");
				}
				const parsed = Number(trimmed);
				if (Number.isNaN(parsed)) {
					throw new Error(`rlm-max-depth argument must be a non-negative integer, got: ${trimmed}`);
				}
				if (!Number.isInteger(parsed)) {
					throw new Error(`rlm-max-depth argument must be a non-negative integer, got: ${trimmed}`);
				}
				if (parsed < 0) {
					throw new Error(`rlm-max-depth argument must be a non-negative integer, got: ${trimmed}`);
				}
				// Valid: accept '0' and positive integers
				// The actual flag update would happen through the settings system
			},
		});

		// on('auto_compaction_end', handler): SEQ-KM-5 compaction notice
		api.on("auto_compaction_end", async () => {
			const k = await ensureKernel();
			await k.onCompactionComplete();
			const notice = k.compactionNotice();
			if (notice !== null) {
				api.sendMessage(
					{
						role: "custom",
						customType: "rlm-compaction",
						content: notice,
						display: false,
						attribution: "agent",
						timestamp: Date.now(),
					},
					{ deliverAs: "nextTurn" },
				);
			}
		});

		// POST-SESSION-PREFLUSH-1: flush BEFORE the host copies artifacts. Never disposes (these hooks are
		// cancellable), never cancels the transition; a failure is surfaced, not swallowed.
		const handlePreTransitionFlush = async () => {
			if (kernel === null) return;
			try {
				await kernel.flushSnapshot();
			} catch (err) {
				api.sendMessage(
					{
						role: "custom",
						customType: "rlm-warning",
						content: `Warning: Pre-transition snapshot flush failed; a fork or branch may copy stale kernel state: ${err instanceof Error ? err.message : String(err)}`,
						display: true,
						attribution: "agent",
						timestamp: Date.now(),
					},
					{ deliverAs: "nextTurn" },
				);
			}
		};
		api.on("session_before_switch", handlePreTransitionFlush);
		api.on("session_before_branch", handlePreTransitionFlush);

		// Save and dispose the outgoing kernel to prevent cross-session leakage (Comment 4366356325)
		const disposeOutgoingKernel = async (): Promise<void> => {
			const outgoing = kernel;
			if (outgoing === null) return;
			// POST-TOOL-SESSION-BINDING-1: relinquish ownership BEFORE the awaited dispose, so every later call
			// from a cell bound to this kernel fails closed instead of reaching the incoming session.
			kernel = null;
			try {
				await outgoing.dispose();
				// Check for observable teardown failure notices from KernelManager
				const teardownNotice = outgoing.takeTeardownNotice?.();
				if (teardownNotice) {
					api.sendMessage(
						{
							role: "custom",
							customType: "rlm-warning",
							content: `Warning: ${teardownNotice}`,
							display: true,
							attribution: "agent",
							timestamp: Date.now(),
						},
						{ deliverAs: "nextTurn" },
					);
				}
			} catch (err) {
				// ERRORS-SESSION-SWITCH-DISPOSE-1: Surface observable diagnostic on flush failure
				api.sendMessage(
					{
						role: "custom",
						customType: "rlm-warning",
						content: `Warning: Failed to cleanly dispose outgoing kernel during session switch: ${err instanceof Error ? err.message : String(err)}`,
						display: true,
						attribution: "agent",
						timestamp: Date.now(),
					},
					{ deliverAs: "nextTurn" },
				);
			}
		};

		// POST-SESSION-OWNED-DIR-1 / POST-SESSION-READINESS-1: the kernel-state directory is exactly what
		// the host's typed sessionManager.resolveOwnArtifactsDir() returns: the CURRENT session file's own
		// directory, resolved only after the host's background artifact copy into that file has settled.
		// getArtifactsDir()/getArtifactManager() are never consulted: under adoption they name the parent's.
		const resolveIncomingArtifactsDir = async (ctx: unknown): Promise<IncomingArtifacts> => {
			const sessionCtx = ctx as
				| { cwd?: string; sessionManager?: { resolveOwnArtifactsDir?: () => Promise<string | null> } }
				| undefined;
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
		};

		// Handle session start, session switches, and branches (for /new, /fork, /resume, /branch)
		const handleSessionInit = async (_event: unknown, ctx?: unknown) => {
			const myGeneration = ++generation;
			const isCurrent = (): boolean => myGeneration === generation;
			const resolution = (async (): Promise<IncomingArtifacts | null> => {
				// POST-SESSION-RESOLUTION-GATE-1: a construction already in flight targets the outgoing
				// session; let it finish so it is disposed below instead of surviving into this session.
				// Its failure is delivered to the caller that requested the kernel, so it is not re-raised here.
				if (kernelConstruction !== null) await kernelConstruction.catch(() => undefined);
				await disposeOutgoingKernel();
				// ERRORS-SESSION-RESOLUTION-FAILED-1: forget the outgoing directory before resolving, so a failed
				// or abandoned resolution can never leave it selectable by the next kernel. A superseded transition
				// still resolves (a kernel requested during it is built on ITS directory) but never touches the
				// published state a newer transition owns.
				if (isCurrent()) incoming = null;
				let resolved: IncomingArtifacts;
				try {
					resolved = await resolveIncomingArtifactsDir(ctx);
				} catch (err) {
					if (isCurrent()) {
						const sessionCtx = ctx as { cwd?: string } | undefined;
						incoming = {
							kind: "unallocated",
							cwd: sessionCtx?.cwd ?? process.cwd(),
							reason: `Incoming session artifacts directory could not be resolved (${err instanceof Error ? err.name : "error"})`,
						};
					}
					throw err;
				}
				// POST-SESSION-TRANSITION-GEN-1: a stale completion never publishes its directory.
				if (isCurrent()) incoming = resolved;
				return resolved;
			})();
			pendingResolution = resolution;
			try {
				await resolution;
			} finally {
				if (pendingResolution === resolution) pendingResolution = null;
			}
			// A newer transition started while this one resolved (or shutdown invalidated it); it owns the
			// incoming session's restore.
			const resolvedIncoming = incoming;
			if (!isCurrent() || pendingResolution !== null || resolvedIncoming === null) return;
			// An unallocated (unowned) session has nothing to restore: it starts fresh and isolated.
			const hasSnapshot =
				resolvedIncoming.kind === "resolved" && fs.existsSync(join(resolvedIncoming.dir, "kernel-state.dill"));
			if (hasSnapshot) {
				try {
					const k = await ensureKernel();
					await k.ensureStarted();
					const names = k.restoredNames();
					const skipped = k.restoredSkipped?.() ?? [];
					if (names.length > 0 || skipped.length > 0) {
						const parts: string[] = [];
						if (names.length > 0) {
							parts.push(`IPython state restored. The following names are available again: ${names.join(", ")}`);
						}
						if (skipped.length > 0) {
							const skippedNames = skipped.map(s => s.name).join(", ");
							parts.push(`Warning: The following unpicklable variables were skipped: ${skippedNames}`);
						}
						api.sendMessage(
							{
								role: "custom",
								customType: "rlm-revival",
								content: parts.join("\n"),
								display: true,
								attribution: "agent",
								timestamp: Date.now(),
							},
							{ deliverAs: "nextTurn" },
						);
					}
				} catch {
					// Non-fatal on session_start / session_switch / session_branch: lazy start will retry on first explicit tool invocation
				}
			}
		};

		api.on("session_start", handleSessionInit);
		api.on("session_switch", handleSessionInit);
		api.on("session_branch", handleSessionInit);

		// on('session_shutdown'): dispose kernel
		api.on("session_shutdown", async () => {
			// POST-SESSION-SHUTDOWN-RACE-1: invalidate every in-flight transition (a pending resolution never
			// constructs a kernel once it settles). Shutdown does not wait for a possibly stuck resolution.
			generation++;
			// Never orphan a kernel whose construction is still in flight (its failure surfaces to its requester).
			if (kernelConstruction !== null) await kernelConstruction.catch(() => undefined);
			const outgoing = kernel;
			kernel = null; // in-flight cells bound to it abort visibly instead of reaching a replacement kernel
			if (outgoing !== null) await outgoing.dispose();
		});
	};
}
