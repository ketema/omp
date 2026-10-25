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
import { createRlmToolDefinition, type RlmToolKernelPort, type RlmToolKernelResult } from "./tool";
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

export interface CreateRlmExtensionOptions {
	readonly createKernel?: (config: RlmKernelConfig) => RlmExtensionKernelPort;
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
		let artifactsDir = "";

		// Lazy kernel construction — deferred until first use
		const ensureKernel = async (): Promise<RlmExtensionKernelPort> => {
			if (kernel !== null) return kernel;

			const config = resolveConfigFromFlags(api);
			// artifactsDir is resolved at session start time
			if (options?.createKernel !== undefined) {
				kernel = options.createKernel(config);
			} else {
				kernel = await createDefaultKernel(config, artifactsDir);
			}
			return kernel;
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

		// Handle session start, session switches, and branches (for /new, /fork, /resume, /branch)
		const handleSessionInit = async (event: unknown, ctx?: unknown) => {
			// Save and dispose outgoing kernel if present to prevent cross-session leakage (Comment 4366356325)
			if (kernel !== null) {
				try {
					await kernel.dispose();
					// Check for observable teardown failure notices from KernelManager
					const teardownNotice = kernel.takeTeardownNotice?.();
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
				} finally {
					kernel = null;
				}
			}

			// POST-SESSION-OWNED-DIR-1 / F2 / F6: resolve the session-owned directory.
			// Host convention: artifactsDirectoryFor(sessionFile) = sessionFile without ".jsonl".
			// When getSessionFile() is available, it is the authoritative identity of this session's own artifacts,
			// even when an adopted parent ArtifactManager makes sessionManager.getArtifactsDir() return the parent's.
			const sessionCtx = ctx as
				| {
						cwd?: string;
						sessionManager?: {
							getSessionFile?: () => string | undefined;
							getArtifactsDir?: () => string | null;
							getSessionId?: () => string;
							getArtifactManager?: () => { dir?: string; listFiles?: () => Promise<string[]> } | null;
						};
				  }
				| undefined;
			const sessionEvent = event as { sessionDir?: string; sessionId?: string; cwd?: string } | undefined;

			const effectiveCwd = sessionCtx?.cwd ?? sessionEvent?.cwd ?? process.cwd();
			const rawSessionFile = sessionCtx?.sessionManager?.getSessionFile?.();
			const ownedFromSessionFile =
				typeof rawSessionFile === "string" && rawSessionFile.endsWith(".jsonl")
					? rawSessionFile.slice(0, -".jsonl".length)
					: undefined;

			const managerArtifactsDir = sessionCtx?.sessionManager?.getArtifactsDir?.();
			const sessionId = sessionCtx?.sessionManager?.getSessionId?.() ?? sessionEvent?.sessionId;

			if (ownedFromSessionFile !== undefined && ownedFromSessionFile.trim() !== "") {
				artifactsDir = ownedFromSessionFile;
			} else if (typeof managerArtifactsDir === "string" && managerArtifactsDir.trim() !== "") {
				// Non-file session or test fixture that provides getArtifactsDir() directly.
				// PARKED (unestablished intent): adopted session with no session file.
				artifactsDir = managerArtifactsDir;
			} else if (typeof sessionEvent?.sessionDir === "string" && sessionEvent.sessionDir.trim() !== "") {
				artifactsDir = sessionEvent.sessionDir;
			} else if (typeof sessionId === "string" && sessionId.trim() !== "") {
				artifactsDir = join(effectiveCwd, ".omp", "artifacts", sessionId.trim());
			} else {
				// POST-SESSION-FALLBACK-ISOLATION-1: REQ-003 line 143
				// Missing session identifier falls back to a dedicated atomically unique directory, NEVER bare root
				const artifactsRoot = join(effectiveCwd, ".omp", "artifacts");
				fs.mkdirSync(artifactsRoot, { recursive: true });
				const fallbackDir = fs.mkdtempSync(join(artifactsRoot, `isolated-${Date.now()}-`));
				artifactsDir = fallbackDir;

				api.sendMessage(
					{
						role: "custom",
						customType: "rlm-warning",
						content: `Warning: Session ID missing or invalid. Fallback isolated directory assigned: ${artifactsDir}`,
						display: false,
						attribution: "agent",
						timestamp: Date.now(),
					},
					{ deliverAs: "nextTurn" },
				);
			}

			// POST-SESSION-READINESS-1: await the incoming session's artifact manager readiness
			// (which settles when any background copy finishes) before probing snapshot existence.
			// Applied ONLY when the artifact manager's dir matches the resolved session-owned dir.
			// PARKED: adopted managers expose only parent readiness, not child's.
			const incomingArtifactManager = sessionCtx?.sessionManager?.getArtifactManager?.();
			if (
				incomingArtifactManager &&
				typeof incomingArtifactManager.dir === "string" &&
				incomingArtifactManager.dir === artifactsDir &&
				typeof incomingArtifactManager.listFiles === "function"
			) {
				try {
					await incomingArtifactManager.listFiles();
				} catch {
					// Readiness wait is best-effort; snapshot probe proceeds below
				}
			}
			const hasSnapshot = fs.existsSync(join(artifactsDir, "kernel-state.dill"));
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
			if (kernel !== null) {
				await kernel.dispose();
				kernel = null;
			}
		});
	};
}
