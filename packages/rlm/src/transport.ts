/**
 * RLM Transport — real kernel runner transport over JSON-lines-on-stdio.
 *
 * Implements the contract at requirements/contracts/rlm-transport.contract.ts.
 * All constants and error classes are redeclared independently (the
 * implementation never imports the contract; tests import BOTH and assert
 * alignment — Contract-Implementation Independence).
 */

import { join } from "node:path";
import type { Subprocess } from "bun";
import type {
  KernelOutputEvent,
  KernelSnapshotWriteResult,
  KernelTransport,
  KernelTransportExecuteResult,
} from "./kernel";

// =============================================================================
// Exceptions (redeclared; aligned with contract TRANS error shapes)
// =============================================================================

export class RlmTransportContractError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RlmTransportContractError";
  }
}

/** ERRORS-TRANS-1: the runner process could not be spawned. */
export class TransportSpawnError extends RlmTransportContractError {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(`failed to spawn the RLM kernel runner: ${detail}`, options);
    this.name = "TransportSpawnError";
  }
}

/** ERRORS-TRANS-2: no readiness frame within the gate. */
export class TransportUnresponsiveError extends RlmTransportContractError {
  constructor(stderrTail: string) {
    super(
      `RLM kernel runner did not become ready within ${TRANS_READY_TIMEOUT_MS}ms; stderr tail: ${stderrTail}`,
    );
    this.name = "TransportUnresponsiveError";
  }
}

/** ERRORS-TRANS-3: a frame violated the wire protocol. */
export class TransportProtocolError extends RlmTransportContractError {
  constructor(detail: string) {
    super(`RLM kernel wire protocol violation: ${detail}`);
    this.name = "TransportProtocolError";
  }
}

// =============================================================================
// Constants (redeclared; aligned with contract TRANS_*)
// =============================================================================

export const TRANS_RUNNER_FILE = "rlm_kernel_runner.py";
export const TRANS_PROTOCOL_VERSION = 1;
export const TRANS_READY_TIMEOUT_MS = 5000;
export const TRANS_KILL_GRACE_MS = 200;
export const TRANS_STDERR_TAIL_CHARS = 1024;

// =============================================================================
// Structural types
// =============================================================================

/** PRE-TRANS-1: the transport's complete spawn configuration. */
export interface RlmTransportConfig {
  readonly interpreter: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly artifactsDir: string;
}

/** IP-9: the runner's readiness frame payload. */
export interface TransReadyFrame {
  readonly type: "ready";
  readonly protocol: number;
  readonly pythonVersion: string;
}

/** Structural process interface — matches Bun.Subprocess shape but injectable. */
export interface RlmTransportProcess {
  readonly stdin: {
    write(line: string): void;
    end(): void;
  };
  onStdout(cb: (chunk: string) => void): void;
  onStderr(cb: (chunk: string) => void): void;
  kill(signal?: string): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
}

export interface RlmTransportDeps {
  readonly clock?: {
    now(): number;
    schedule(fn: () => void, ms: number): () => void;
  };
  readonly spawn?: (
    cmd: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string> },
  ) => RlmTransportProcess;
}

// =============================================================================
// Wire protocol types (internal)
// =============================================================================

type OpName =
  | "execute"
  | "interrupt"
  | "snapshot_names"
  | "snapshot_write"
  | "snapshot_restore"
  | "bootstrap"
  | "shutdown";

interface WireOp {
  readonly op: OpName;
  readonly id?: string;
  readonly code?: string;
  readonly path?: string;
  readonly manifestPath?: string;
  readonly maxBytes?: number;
}

type FrameType =
  | "ready"
  | "started"
  | "stdout"
  | "stderr"
  | "result"
  | "error"
  | "done";

interface WireFrame {
  readonly type: FrameType;
  readonly id?: string;
  readonly data?: string;
  readonly code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly result?: string;
  readonly traceback?: string;
  readonly errorEname?: string;
  readonly names?: string[];
  readonly bytes?: number;
  readonly skipped?: { readonly name: string; readonly reason: string }[];
  readonly restoredNames?: string[];
  readonly protocol?: number;
  readonly pythonVersion?: string;
}

// =============================================================================
// Utility
// =============================================================================

function boundedStderrTail(stderr: string): string {
  return stderr.length <= TRANS_STDERR_TAIL_CHARS
    ? stderr
    : stderr.slice(stderr.length - TRANS_STDERR_TAIL_CHARS);
}

function isKnownFrameType(type: unknown): type is FrameType {
  return (
    typeof type === "string" &&
    ["ready", "started", "stdout", "stderr", "result", "error", "done"].includes(type)
  );
}

// =============================================================================
// Default process wrapper (Bun.spawn)
// =============================================================================

interface DefaultProcessState {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  stdin: Bun.FileSink;
  stdoutReader: ReadableStreamDefaultReader<Uint8Array> | null;
  stderrReader: ReadableStreamDefaultReader<Uint8Array> | null;
  exited: boolean;
  exitCode: number | null;
  exitSignal: string | null;
  exitCallbacks: Array<(code: number | null, signal: string | null) => void>;
}

function wrapBunSubprocess(
  proc: Subprocess<"pipe", "pipe", "pipe">,
): RlmTransportProcess {
  const state: DefaultProcessState = {
    proc,
    stdin: proc.stdin,
    stdoutReader: null,
    stderrReader: null,
    exited: false,
    exitCode: null,
    exitSignal: null,
    exitCallbacks: [],
  };

  // Start the exit watcher
  void proc.exited.then((code: number) => {
    state.exited = true;
    state.exitCode = code;
    state.exitSignal = null;
    for (const cb of state.exitCallbacks) {
      cb(code, null);
    }
  });

  const wrapper: RlmTransportProcess = {
    stdin: {
      write(line: string): void {
        state.stdin.write(line);
        state.stdin.flush();
      },
      end(): void {
        state.stdin.end();
      },
    },
    onStdout(cb: (chunk: string) => void): void {
      if (state.stdoutReader !== null) return;
      const stream = proc.stdout as ReadableStream<Uint8Array>;
      const reader = stream.getReader();
      state.stdoutReader = reader;
      const decoder = new TextDecoder();
      void (async () => {
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            // Split on newlines — deliver complete lines
            while (true) {
              const nl = buffer.indexOf("\n");
              if (nl < 0) break;
              const line = buffer.slice(0, nl);
              buffer = buffer.slice(nl + 1);
              if (line.length > 0) cb(line);
            }
          }
          // Flush remaining
          buffer += decoder.decode();
          if (buffer.length > 0) cb(buffer);
        } catch {
          // reader closed
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // already released
          }
        }
      })();
    },
    onStderr(cb: (chunk: string) => void): void {
      if (state.stderrReader !== null) return;
      const stream = proc.stderr as ReadableStream<Uint8Array>;
      const reader = stream.getReader();
      state.stderrReader = reader;
      const decoder = new TextDecoder();
      void (async () => {
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            while (true) {
              const nl = buffer.indexOf("\n");
              if (nl < 0) break;
              const line = buffer.slice(0, nl);
              buffer = buffer.slice(nl + 1);
              if (line.length > 0) cb(line);
            }
          }
          buffer += decoder.decode();
          if (buffer.length > 0) cb(buffer);
        } catch {
          // reader closed
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // already released
          }
        }
      })();
    },
    kill(signal?: string): void {
      try {
        proc.kill(signal as unknown as number | undefined ?? "SIGTERM" as unknown as number);
      } catch {
        // already dead
      }
    },
    onExit(cb: (code: number | null, signal: string | null) => void): void {
      if (state.exited) {
        cb(state.exitCode, state.exitSignal);
      } else {
        state.exitCallbacks.push(cb);
      }
    },
  };

  return wrapper;
}

function defaultSpawn(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string> },
): RlmTransportProcess {
  let proc: Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn({
      cmd: [cmd, ...args],
      cwd: opts.cwd,
      env: opts.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error: unknown) {
    throw new TransportSpawnError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  return wrapBunSubprocess(proc);
}

// =============================================================================
// RlmTransport
// =============================================================================

interface PendingExecution {
  resolve: (result: KernelTransportExecuteResult) => void;
  reject: (error: unknown) => void;
  stdout: string;
  stderr: string;
}

interface PendingOp<T> {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/**
 * The real-kernel transport. Spawns the dedicated Python runner, speaks
 * JSON-lines-over-stdio, and implements the KernelTransport interface.
 */
export class RlmTransport implements KernelTransport {
  private readonly config: RlmTransportConfig;
  private readonly clock: { now(): number; schedule(fn: () => void, ms: number): () => void };
  private readonly spawnFn: (
    cmd: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string> },
  ) => RlmTransportProcess;

  private process: RlmTransportProcess | null = null;
  private started = false;
  private disposed = false;
  private stderrAccum = "";
  private pyVersion = "";

  private outputCallback: ((event: KernelOutputEvent) => void) | null = null;

  private activeExecId: string | null = null;
  private activeExecPending: PendingExecution | null = null;

  private pendingOps = new Map<string, PendingOp<unknown>>();
  private opIdCounter = 0;

  // Ready promise (resolved on 'ready' frame)
  private readyResolve: ((frame: TransReadyFrame) => void) | null = null;
  private readyReject: ((error: unknown) => void) | null = null;

  constructor(config: RlmTransportConfig, deps?: RlmTransportDeps) {
    this.config = config;
    this.clock = deps?.clock ?? {
      now: () => Date.now(),
      schedule(fn: () => void, ms: number): () => void {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    };
    this.spawnFn = deps?.spawn ?? defaultSpawn;
  }

  // ---- KernelTransport implementation ----

  /**
   * POST-TRANS-1/SEQ-TRANS-1: spawn the runner and wait for the ready frame
   * within TRANS_READY_TIMEOUT_MS. Any op attempted before start() rejects.
   */
  async start(): Promise<void> {
    if (this.started) return;
    if (this.disposed) throw new TransportSpawnError("transport has been disposed");

    const runnerPath = join(
      // packages/rlm/src/transport.ts → packages/rlm/python/rlm_kernel_runner.py
      new URL("../python/rlm_kernel_runner.py", import.meta.url).pathname,
    );

    // POST-TRANS-1: spawn [interpreter, <absolute path of runner>]
    let process: RlmTransportProcess;
    try {
      process = this.spawnFn(this.config.interpreter, [runnerPath], {
        cwd: this.config.cwd,
        // FORBIDDEN-TRANS-2: exactly the provided env, nothing added
        env: { ...this.config.env },
      });
    } catch (error: unknown) {
      throw new TransportSpawnError(
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    this.process = process;

    // Collect stderr for error reporting
    process.onStderr((chunk: string) => {
      this.stderrAccum += chunk;
    });

    // Set up the ready frame promise with timeout
    const readyPromise = new Promise<TransReadyFrame>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    // Timeout gate (TRANS_READY_TIMEOUT_MS via clock)
    const cancelTimeout = this.clock.schedule(() => {
      if (this.readyReject !== null) {
        this.readyReject(
          new TransportUnresponsiveError(boundedStderrTail(this.stderrAccum)),
        );
        this.readyResolve = null;
        this.readyReject = null;
      }
    }, TRANS_READY_TIMEOUT_MS);

    // Wire up stdout handler
    process.onStdout((line: string) => {
      this.handleLine(line);
    });

    // Process exit handler
    process.onExit((code: number | null, _signal: string | null) => {
      if (this.readyReject !== null) {
        this.readyReject(
          new TransportUnresponsiveError(boundedStderrTail(this.stderrAccum)),
        );
        this.readyResolve = null;
        this.readyReject = null;
      }
    });

    try {
      const readyFrame = await readyPromise;
      // Validate protocol version
      if (readyFrame.protocol !== TRANS_PROTOCOL_VERSION) {
        throw new TransportProtocolError(
          `ready frame protocol version ${readyFrame.protocol} !== expected ${TRANS_PROTOCOL_VERSION}`,
        );
      }
      this.pyVersion = readyFrame.pythonVersion;
      this.started = true;
    } finally {
      cancelTimeout();
    }
  }

  /**
   * POST-TRANS-2: execute(id, code) sends the execute op, streams
   * stdout/stderr through onOutput, settles from the done frame.
   */
  async execute(id: string, code: string): Promise<KernelTransportExecuteResult> {
    this.assertNotDisposed();
    this.assertStarted();

    return new Promise<KernelTransportExecuteResult>((resolve, reject) => {
      this.activeExecId = id;
      this.activeExecPending = {
        resolve,
        reject,
        stdout: "",
        stderr: "",
      };

      this.sendOp({
        op: "execute",
        id,
        code,
      });
    });
  }

  /** POST-TRANS-3: interrupt the running cell; runner stays usable. */
  async interrupt(): Promise<void> {
    if (!this.started || this.process === null) return;
    this.sendOp({ op: "interrupt" });
  }

  /**
   * SEQ-TRANS-2: kill sends SIGTERM; escalate SIGKILL after
   * TRANS_KILL_GRACE_MS (clock-scheduled).
   */
  async kill(): Promise<void> {
    if (this.process === null) return;
    this.started = false;
    const proc = this.process;

    const exitPromise = new Promise<boolean>((resolve) => {
      proc.onExit((_code, _signal) => resolve(true));
      // If already exited
      // (onExit fires immediately if already exited in the default wrapper)
    });

    proc.kill("SIGTERM");

    const cancelEscalation = this.clock.schedule(() => {
      proc.kill("SIGKILL");
    }, TRANS_KILL_GRACE_MS);

    await Promise.race([exitPromise, new Promise<void>(r => this.clock.schedule(() => r(), TRANS_KILL_GRACE_MS + 50))]);

    cancelEscalation();
  }

  onOutput(cb: (event: KernelOutputEvent) => void): void {
    this.outputCallback = cb;
  }

  /** POST-TRANS-4: snapshotNames → runner-reported name list. */
  async snapshotNames(): Promise<string[]> {
    this.assertNotDisposed();
    this.assertStarted();

    const id = `snap-names-${this.opIdCounter++}`;
    return new Promise<string[]>((resolve, reject) => {
      this.pendingOps.set(id, {
        resolve: (v: unknown) => resolve(v as string[]),
        reject,
      });
      this.sendOp({ op: "snapshot_names", id });
    });
  }

  /** POST-TRANS-4: writeSnapshot → {bytes, skipped}. */
  async writeSnapshot(
    names: readonly string[],
    maxBytes: number,
  ): Promise<KernelSnapshotWriteResult> {
    this.assertNotDisposed();
    this.assertStarted();

    const id = `snap-write-${this.opIdCounter++}`;
    const payloadPath = join(this.config.artifactsDir, "kernel-state.dill");
    const manifestPath = join(this.config.artifactsDir, "kernel-state.json");

    return new Promise<KernelSnapshotWriteResult>((resolve, reject) => {
      this.pendingOps.set(id, {
        resolve: (v: unknown) => resolve(v as KernelSnapshotWriteResult),
        reject,
      });
      this.sendOp({
        op: "snapshot_write",
        id,
        path: payloadPath,
        manifestPath,
        maxBytes,
      });
    });
  }

  /** POST-TRANS-4: restoreSnapshot → revived names in runner order. */
  async restoreSnapshot(): Promise<string[]> {
    this.assertNotDisposed();
    this.assertStarted();

    const id = `snap-restore-${this.opIdCounter++}`;
    const payloadPath = join(this.config.artifactsDir, "kernel-state.dill");
    const manifestPath = join(this.config.artifactsDir, "kernel-state.json");

    return new Promise<string[]>((resolve, reject) => {
      this.pendingOps.set(id, {
        resolve: (v: unknown) => resolve(v as string[]),
        reject,
      });
      this.sendOp({
        op: "snapshot_restore",
        id,
        path: payloadPath,
        manifestPath,
      });
    });
  }

  /** POST-TRANS-5: bootstrap runs the runtime bootstrap op. */
  async bootstrap(): Promise<void> {
    this.assertNotDisposed();
    this.assertStarted();

    const id = `bootstrap-${this.opIdCounter++}`;
    return new Promise<void>((resolve, reject) => {
      this.pendingOps.set(id, {
        resolve: () => resolve(),
        reject,
      });
      this.sendOp({ op: "bootstrap", id });
    });
  }

  isBusy(): boolean {
    return this.activeExecId !== null;
  }

  alive(): boolean {
    return this.started && this.process !== null && !this.disposed;
  }

  /** C6: reports the kernel's Python version for the snapshot manifest. */
  async pythonVersion(): Promise<string> {
    return this.pyVersion;
  }

  /** SEQ-TRANS-2: dispose is idempotent and releases the process. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;

    if (this.process !== null) {
      // Try graceful shutdown
      try {
        this.sendOp({ op: "shutdown" });
      } catch {
        // process may already be dead
      }

      // Wait briefly for graceful exit, then kill
      const proc = this.process;
      const cancelKill = this.clock.schedule(() => {
        proc.kill("SIGTERM");
      }, 50);

      const cancelEscalation = this.clock.schedule(() => {
        proc.kill("SIGKILL");
      }, TRANS_KILL_GRACE_MS + 50);

      // Give a moment for graceful exit
      await new Promise<void>(r => this.clock.schedule(() => r(), 100));

      cancelKill();
      cancelEscalation();
    }

    this.process = null;
  }

  // ---- Internal: wire protocol ----

  private sendOp(op: WireOp): void {
    if (this.process === null) {
      throw new RlmTransportContractError("transport not started");
    }
    this.process.stdin.write(JSON.stringify(op) + "\n");
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new RlmTransportContractError("transport has been disposed");
    }
  }

  private assertStarted(): void {
    if (!this.started) {
      throw new RlmTransportContractError("transport not started; call start() first");
    }
  }

  /**
   * ERRORS-TRANS-3: route a protocol error to the appropriate rejection handler
   * so it surfaces as a rejected promise rather than an uncaught throw in a
   * stream callback.
   */
  private routeProtocolError(error: TransportProtocolError): void {
    if (this.readyReject !== null) {
      this.readyReject(error);
      this.readyResolve = null;
      this.readyReject = null;
    } else if (this.activeExecPending !== null) {
      const pending = this.activeExecPending;
      this.activeExecId = null;
      this.activeExecPending = null;
      pending.reject(error);
    }
    // If no pending handler, the error is still thrown for fail-loud semantics
    // but won't crash the process if no one is listening
    else {
      // Store it for the next op or re-throw
      throw error;
    }
  }

  private handleLine(line: string): void {
    let frame: WireFrame;
    try {
      frame = JSON.parse(line) as WireFrame;
    } catch {
      // ERRORS-TRANS-3: non-JSON line → protocol error, never silently dropped.
      // Route to readyReject or active exec or pending op so the error
      // surfaces as a rejected promise, not an uncaught throw in a stream callback.
      const err = new TransportProtocolError(`non-JSON line: ${line.slice(0, 200)}`);
      this.routeProtocolError(err);
      return;
    }

    // Validate frame type
    if (!isKnownFrameType(frame.type)) {
      const err = new TransportProtocolError(
        `unknown frame type ${JSON.stringify(frame.type)}`,
      );
      this.routeProtocolError(err);
      return;
    }

    switch (frame.type) {
      case "ready": {
        if (this.readyResolve !== null) {
          this.readyResolve({
            type: "ready",
            protocol: frame.protocol ?? 0,
            pythonVersion: frame.pythonVersion ?? "",
          });
          this.readyResolve = null;
          this.readyReject = null;
        }
        return;
      }

      case "started": {
        // Execution started acknowledgment — no action needed
        return;
      }

      case "stdout":
      case "stderr": {
        // INV-TRANS-1: only deliver frames for the active execution id
        if (
          frame.id !== undefined &&
          this.activeExecId !== null &&
          frame.id === this.activeExecId &&
          this.activeExecPending !== null &&
          this.outputCallback !== null
        ) {
          this.outputCallback({
            id: frame.id,
            stream: frame.type,
            data: frame.data ?? "",
          });
        }
        // Also accumulate for the done frame
        if (
          frame.id !== undefined &&
          this.activeExecId !== null &&
          frame.id === this.activeExecId &&
          this.activeExecPending !== null
        ) {
          if (frame.type === "stdout") {
            this.activeExecPending.stdout += frame.data ?? "";
          } else {
            this.activeExecPending.stderr += frame.data ?? "";
          }
        }
        return;
      }

      case "done": {
        // Settle the active execution
        if (
          frame.id !== undefined &&
          this.activeExecId !== null &&
          frame.id === this.activeExecId &&
          this.activeExecPending !== null
        ) {
          const pending = this.activeExecPending;
          this.activeExecId = null;
          this.activeExecPending = null;

          pending.resolve({
            code: frame.code ?? 0,
            stdout: frame.stdout ?? pending.stdout,
            stderr: frame.stderr ?? pending.stderr,
            result: frame.result ?? "",
            ...(frame.traceback !== undefined ? { traceback: frame.traceback } : {}),
            ...(frame.errorEname !== undefined ? { errorEname: frame.errorEname } : {}),
          });
        }
        return;
      }

      case "result": {
        // A standalone result frame — route to pending ops if it has an id
        if (frame.id !== undefined && this.pendingOps.has(frame.id)) {
          const op = this.pendingOps.get(frame.id)!;
          this.pendingOps.delete(frame.id);
          // Result frames for snapshot ops carry the data
          if (frame.names !== undefined) {
            op.resolve(frame.names);
          } else if (frame.restoredNames !== undefined) {
            op.resolve(frame.restoredNames);
          } else if (frame.bytes !== undefined) {
            op.resolve({
              bytes: frame.bytes,
              skipped: frame.skipped ?? [],
            });
          } else {
            op.resolve(undefined);
          }
        }
        return;
      }

      case "error": {
        // Error frame — reject pending op or settle active execution as error
        if (frame.id !== undefined && this.pendingOps.has(frame.id)) {
          const op = this.pendingOps.get(frame.id)!;
          this.pendingOps.delete(frame.id);
          op.reject(
            new RlmTransportContractError(
              `runner error: ${frame.errorEname ?? "unknown"}: ${frame.data ?? ""}`,
            ),
          );
        } else if (
          frame.id !== undefined &&
          this.activeExecId !== null &&
          frame.id === this.activeExecId &&
          this.activeExecPending !== null
        ) {
          const pending = this.activeExecPending;
          this.activeExecId = null;
          this.activeExecPending = null;
          pending.resolve({
            code: 1,
            stdout: pending.stdout,
            stderr: pending.stderr,
            result: "",
            ...(frame.data !== undefined ? { traceback: frame.data } : {}),
            ...(frame.errorEname !== undefined ? { errorEname: frame.errorEname } : {}),
          });
        }
        return;
      }
    }
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createTransport(
  config: RlmTransportConfig,
  deps?: RlmTransportDeps,
): RlmTransport {
  return new RlmTransport(config, deps);
}
