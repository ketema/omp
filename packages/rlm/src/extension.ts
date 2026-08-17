/**
 * RLM extension — wires the tool, flags, commands, and lifecycle hooks
 * into omp's extension API surface.
 *
 * REQ-RLM-0002, REQ-RLM-0014, SEQ-BOOT-2, SEQ-KM-5 wiring, SEQ-TOOL-1.
 */

import { join } from "node:path";
import * as fs from "node:fs";
import type {
  KernelClock,
  KernelExecutionResult,
  KernelTransport,
} from "./kernel";
import { KernelManager } from "./kernel";
import { createTransport } from "./transport";
import {
  createRlmToolDefinition,
  type RlmToolKernelPort,
  type RlmToolKernelResult,
} from "./tool";
import { buildKernelEnv, bootstrapManagedVenv } from "./bootstrap";

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

/** The kernel port exposed to the extension, adding compaction lifecycle. */
export interface RlmExtensionKernelPort
  extends RlmToolKernelPort {
  onCompactionComplete(): Promise<void>;
  compactionNotice(): string | null;
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
  registerTool(tool: StructuralToolDefinition): void;
  registerFlag(
    name: string,
    opts: { type: "boolean" | "string"; default?: boolean | string },
  ): void;
  registerCommand(
    name: string,
    opts: { handler: (args: string, ctx: unknown) => Promise<void> },
  ): void;
  on(event: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>): void;
  getFlag(name: string): string | boolean | undefined;
  sendMessage(
    payload: unknown,
    options?: { triggerTurn?: boolean; deliverAs?: string },
  ): void;
}

// =============================================================================
// Kernel adapter — wraps KernelManager to satisfy RlmExtensionKernelPort
// =============================================================================

class KernelManagerAdapter implements RlmExtensionKernelPort {
  private readonly manager: KernelManager;
  private readonly transport: KernelTransport;
  private _restoredNames: readonly string[] = [];
  private _started = false;

  constructor(
    transport: KernelTransport,
    manager: KernelManager,
  ) {
    this.transport = transport;
    this.manager = manager;
  }

  async ensureStarted(
    onProgress?: (phase: "starting" | "restoring" | "preparing") => void,
  ): Promise<void> {
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

  restoredNames(): readonly string[] {
    return this._restoredNames;
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

function resolveConfigFromFlags(
  api: StructuralExtensionAPI,
): RlmKernelConfig {
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
    modelSearchLimit:
      typeof modelSearchLimit === "string" ? parseInt(modelSearchLimit, 10) : 8,
    nameMaxLength:
      typeof nameMaxLength === "string" ? parseInt(nameMaxLength, 10) : 64,
    forkserver: typeof forkserver === "boolean" ? forkserver : true,
  };
  if (typeof kernelPython === "string") config.kernelPython = kernelPython;
  if (typeof venvPath === "string") config.venvPath = venvPath;
  if (typeof agentDir === "string") config.agentDir = agentDir;
  return config;
}

async function createDefaultKernel(
  config: RlmKernelConfig,
  artifactsDir: string,
): Promise<RlmExtensionKernelPort> {
  // Resolve interpreter via bootstrap
  const agentDir = config.agentDir ?? join(
    // Default to ~/.omp/agent
    process.env.HOME ?? "/tmp",
    ".omp",
    "agent",
  );
  const venvDir =
    config.venvPath ?? join(agentDir, "kernel-venv");
  const xdgDir = join(agentDir, "xdg");
  fs.mkdirSync(agentDir, { recursive: true });

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
            const proc = Bun.spawn({
              cmd: [cmd, ...args],
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
        runtimeSources: (() => {
          const sources: Record<string, string> = {};
          const runnerFile = new URL("../python/rlm_kernel_runner.py", import.meta.url).pathname;
          const runtimeInit = new URL(
            "../python/rlm-runtime/src/rlm/__init__.py",
            import.meta.url,
          ).pathname;
          for (const [name, path] of [["runner.py", runnerFile], ["rlm/__init__.py", runtimeInit]] as const) {
            try {
              sources[name] = fs.readFileSync(path, "utf8");
            } catch {
              // missing source: identity changes force a rebuild anyway
            }
          }
          return sources;
        })(),
        runtimePackagePath: new URL(
          "../python/rlm-runtime",
          import.meta.url,
        ).pathname,
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
  readonly createKernel?: (
    config: RlmKernelConfig,
  ) => RlmExtensionKernelPort;
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

    // on('session_start'): restore and announce revived names
    api.on("session_start", async (event: unknown) => {
      // Resolve artifactsDir from the session event (structural)
      const sessionEvent = event as { sessionDir?: string };
      if (typeof sessionEvent?.sessionDir === "string") {
        artifactsDir = sessionEvent.sessionDir;
      } else {
        artifactsDir = join(process.cwd(), ".omp", "artifacts");
      }

      // Start kernel and announce revival
      const k = await ensureKernel();
      await k.ensureStarted();
      const names = k.restoredNames();
      if (names.length > 0) {
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
      }
    });

    // on('session_shutdown'): dispose kernel
    api.on("session_shutdown", async () => {
      if (kernel !== null) {
        await kernel.dispose();
        kernel = null;
      }
    });
  };
}
