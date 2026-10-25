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
import { RlmSessionLifecycle } from "./session_lifecycle";
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
	dispose(): Promise<void>;
	/**
	 * POST-SESSION-MOVE-3: the session this kernel serves now owns `dir`. Later snapshots (including the one flushed
	 * here, bounded and serialized behind any running cell) are written there, never into the superseded directory.
	 * Rejects when the flush cannot settle; the kernel stays live either way.
	 */
	retarget(dir: string): Promise<void>;
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

export class KernelManagerAdapter implements RlmExtensionKernelPort {
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

	async retarget(dir: string): Promise<void> {
		this.manager.relocate(dir);
		await this.manager.flushSnapshot();
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
	/** Test seam: builds the kernel port for the RESOLVED session artifacts directory (POST-SESSION-RESOLUTION-GATE-1). */
	readonly createKernel?: (config: RlmKernelConfig, artifactsDir: string) => RlmExtensionKernelPort;
}

/**
 * Creates the RLM extension factory. Registers the tool, flags, commands,
 * and lifecycle hooks into the omp extension API. Which kernel serves the current session, and what each lifecycle
 * event does to it, is RlmSessionLifecycle's job (session_lifecycle.ts).
 */
export function createRlmExtension(
	options?: CreateRlmExtensionOptions,
): (api: StructuralExtensionAPI) => Promise<void> {
	return async (api: StructuralExtensionAPI): Promise<void> => {
		const notify = (customType: string, content: string, display: boolean): void =>
			api.sendMessage(
				{ role: "custom", customType, content, display, attribution: "agent", timestamp: Date.now() },
				{ deliverAs: "nextTurn" },
			);
		const lifecycle = new RlmSessionLifecycle({
			notify,
			buildKernel(dir) {
				const config = resolveConfigFromFlags(api);
				return options?.createKernel !== undefined
					? options.createKernel(config, dir)
					: createDefaultKernel(config, dir);
			},
		});

		// registerTool: exactly ONE tool, the ipython tool
		const toolDef = createRlmToolDefinition({
			kernel: {
				ensureStarted(onProgress?: (phase: "starting" | "restoring" | "preparing") => void) {
					return lifecycle.ensureKernel().then(k => k.ensureStarted(onProgress));
				},
				execute(code: string) {
					return lifecycle.ensureKernel().then(k => k.execute(code));
				},
				kill() {
					return lifecycle.ensureKernel().then(k => k.kill());
				},
				dispose() {
					return lifecycle.ensureKernel().then(k => k.dispose());
				},
				restoredNames: () => lifecycle.restoredNames(),
				// Captured synchronously when a kernel exists, so the binding is the kernel current at entry.
				acquire: () => lifecycle.acquire(),
			},
			// SEQ-KM-5: revival notice enumerating restored names
			onRevival: (names: readonly string[]) =>
				notify(
					"rlm-revival",
					`IPython state restored. The following names are available again: ${names.join(", ")}`,
					true,
				),
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
				if (Number.isNaN(parsed) || !Number.isInteger(parsed) || parsed < 0) {
					throw new Error(`rlm-max-depth argument must be a non-negative integer, got: ${trimmed}`);
				}
				// Valid: accept '0' and positive integers
				// The actual flag update would happen through the settings system
			},
		});

		// Lifecycle hooks
		api.on("auto_compaction_end", () => lifecycle.onCompactionComplete());
		api.on("session_before_switch", () => lifecycle.preTransitionFlush());
		api.on("session_before_branch", () => lifecycle.preTransitionFlush());
		api.on("session_start", (event, ctx) => lifecycle.handleSessionInit(event, ctx));
		api.on("session_switch", (event, ctx) => lifecycle.handleSessionInit(event, ctx));
		api.on("session_branch", (event, ctx) => lifecycle.handleSessionInit(event, ctx));
		api.on("session_shutdown", () => lifecycle.shutdown());
	};
}
