/**
 * RLM Kernel Manager implementation.
 *
 * Implements the contract at requirements/contracts/rlm-kernel.contract.ts.
 * All constants are redeclared independently (no import from the contract);
 * tests import BOTH and assert alignment.
 */

import * as fs from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// =============================================================================
// Constants (redeclared; aligned with contract KM_*)
// =============================================================================

export const READY_TIMEOUT_MS = 5000
export const PORTS_RESOLVE_TIMEOUT_MS = 5000
export const MAX_OUTPUT_CHARS = 65536
export const ABORT_GRACE_MS = 1000
export const BUSY_REUSE_WAIT_MS = 5000
export const BUSY_INTERRUPT_INTERVAL_MS = 500
export const SHUTDOWN_GRACE_MS = 200
export const DISPOSE_TIMEOUT_MS = 5000
export const SNAPSHOT_DEBOUNCE_MS = 1500
export const SNAPSHOT_DISPOSE_TIMEOUT_MS = 5000
export const SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024
export const STDERR_TAIL_CHARS = 1024
export const TRUNCATION_MARKER = '[... output truncated at %d chars ...]'
export const LIVENESS_POLL_MS = 1000
export const SNAPSHOT_PAYLOAD_FILE = 'kernel-state.dill'
export const SNAPSHOT_MANIFEST_FILE = 'kernel-state.json'
export const SNAPSHOT_MANIFEST_VERSION = 1
export const SNAPSHOT_ALWAYS_SKIP: readonly string[] = [
  'rlm', 'asyncio', 'In', 'Out', 'get_ipython', 'exit', 'quit', 'open',
]

// =============================================================================
// Error classes
// =============================================================================

export class RlmKernelContractError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RlmKernelContractError'
  }
}

export class KernelBusyAfterInterruptError extends RlmKernelContractError {
  constructor(detail: string) {
    super(
      `IPython kernel is still running the previously interrupted cell. Wait and try again, or kill the IPython kernel to start fresh. ${detail}`,
    )
    this.name = 'KernelBusyAfterInterruptError'
  }
}

export class KernelUnresponsiveError extends RlmKernelContractError {
  constructor(stderrTail: string) {
    super(
      `Kernel did not respond to kernel_info_request within ${READY_TIMEOUT_MS}ms. stderr tail: ${stderrTail}`,
    )
    this.name = 'KernelUnresponsiveError'
  }
}

export class KernelPortsUnresolvedError extends RlmKernelContractError {
  constructor(stderrTail: string) {
    super(
      `Kernel did not resolve connection ports within ${PORTS_RESOLVE_TIMEOUT_MS}ms. stderr tail: ${stderrTail}`,
    )
    this.name = 'KernelPortsUnresolvedError'
  }
}

export class ExecutionAbortedError extends RlmKernelContractError {
  constructor() {
    super('IPython execution aborted')
    this.name = 'ExecutionAbortedError'
  }
}

// =============================================================================
// Types
// =============================================================================

export type KernelExecutionStatus = 'ok' | 'error' | 'aborted'

export interface KernelExecutionResult {
  readonly status: KernelExecutionStatus
  readonly stdout: string
  readonly stderr: string
  readonly result: string
  readonly traceback: string | undefined
  readonly errorEname: string | undefined
  readonly durationMs: number
  readonly kernelRestarted?: boolean
}

export interface KernelSnapshotManifest {
  readonly version: 1
  readonly savedNames: readonly string[]
  readonly skipped: readonly { readonly name: string; readonly reason: string }[]
  readonly bytes: number
  readonly pythonVersion: string
  readonly timestamp: string
}

export interface KernelClock {
  now(): number
  schedule(fn: () => void, ms: number): () => void
}

export interface KernelTransportExecuteResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly result: string
  readonly traceback?: string
  readonly errorEname?: string
}

export interface KernelOutputEvent {
  readonly id: string
  readonly stream: 'stdout' | 'stderr'
  readonly data: string
}

export interface KernelSnapshotWriteResult {
  readonly bytes: number
  readonly skipped: readonly { readonly name: string; readonly reason: string }[]
}

export interface KernelTransport {
  start(): Promise<void> | void
  execute(id: string, code: string): Promise<KernelTransportExecuteResult>
  interrupt(): Promise<void> | void
  /** F-011 graceful shutdown request before the hard kill. */
  shutdown?(): Promise<void> | void
  kill(): Promise<void> | void
  onOutput(cb: (event: KernelOutputEvent) => void): void
  snapshotNames(): Promise<string[]>
  writeSnapshot(names: readonly string[], maxBytes: number): Promise<KernelSnapshotWriteResult>
  writeSnapshotPayload?(dir: string): Promise<void>
  /** C6: reports the kernel's Python version for the snapshot manifest. */
  pythonVersion?(): Promise<string>
  restoreSnapshot(): Promise<string[]>
  bootstrap(): Promise<void> | void
  isBusy(): boolean
  alive(): boolean
  dispose(): Promise<void> | void
}

// =============================================================================
// Utility
// =============================================================================

function truncateStream(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return (
    text.slice(0, MAX_OUTPUT_CHARS) +
    TRUNCATION_MARKER.replace('%d', String(MAX_OUTPUT_CHARS))
  )
}

/** C3/F-10: incrementally cap accumulated streams so a runaway cell cannot
 * grow memory without bound before settle-time truncation. */
function appendCapped(current: string, chunk: string): string {
  // Keep a small margin beyond the cap so the final truncation applies the
  // exact marker; the bound is cap + marker length, not the raw stream
  const markerLength = TRUNCATION_MARKER.replace('%d', String(MAX_OUTPUT_CHARS)).length
  const next = current + chunk
  if (next.length <= MAX_OUTPUT_CHARS + markerLength) return next
  return next.slice(0, MAX_OUTPUT_CHARS + markerLength)
}

/** V4/V5/F3/F4: atomic file write — temp file in the SAME directory as the
 * destination, then rename (POSIX same-filesystem rename is atomic). A
 * crash mid-write leaves the prior file intact and readable. */
function atomicWriteFileSync(destPath: string, content: string): void {
  const tempPath = `${destPath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tempPath, content)
  fs.renameSync(tempPath, destPath)
}

/** C1/F-017: stderr tails quoted in errors are bounded to
 * STDERR_TAIL_CHARS (prime-agent slices the last 1024 at throw sites). */
function boundedStderrTail(stderr: string): string {
  return stderr.length <= STDERR_TAIL_CHARS
    ? stderr
    : stderr.slice(stderr.length - STDERR_TAIL_CHARS)
}

function utcIsoTimestamp(clock: KernelClock): string {
  return new Date(clock.now()).toISOString()
}

function safeInterrupt(transport: KernelTransport): void {
  const result = transport.interrupt()
  if (result instanceof Promise) {
    result.catch(() => {})
  }
}

// =============================================================================
// KernelManager
// =============================================================================

export class KernelManager {
  private readonly transport: KernelTransport
  private readonly clock: KernelClock
  private readonly artifactsDir: string

  private started = false
  private disposed = false
  /** C9: dispose completed — later dispose calls are no-ops. */
  private disposeCompleted = false
  /** F8: teardown-time observability (snapshot flush failures). */
  private teardownNotice: string | null = null
  private execCounter = 0

  // Execution serialization (PRE-KM-1/INV-KM-1)
  // null = no previous execution; a promise = wait for it before starting
  private chainTail: Promise<void> | null = null

  // Active execution state (POST-KM-3/FORBIDDEN-KM-2)
  private activeExecutionId: string | null = null
  private activeSettle: ((result: KernelExecutionResult) => void) | null = null
  private activeStartTime = 0
  private activeStdout = ''
  private activeStderr = ''
  private aborted = false

  // Pending abort: abort() called before executeInternal set up active state
  private pendingAbort = false

  // Snapshot debounce timer (SEQ-KM-3)
  private snapshotCancel: (() => void) | null = null

  // Compaction notice (SEQ-KM-5)
  private compactionNoticeValue: string | null = null

  // SLICE-4 additive: names restored by the last admission (for tool/extension)
  private lastRestoredNames: readonly string[] = []

  constructor(
    transport: KernelTransport,
    options: { clock: KernelClock; artifactsDir: string },
  ) {
    this.transport = transport
    this.clock = options.clock
    this.artifactsDir = options.artifactsDir

    // POST-KM-3/FORBIDDEN-KM-2: accept output only for the active execution id
    this.transport.onOutput((event: KernelOutputEvent) => {
      if (
        this.activeExecutionId !== null &&
        event.id === this.activeExecutionId
      ) {
        if (event.stream === 'stdout') {
          this.activeStdout = appendCapped(this.activeStdout, event.data)
        } else {
          this.activeStderr = appendCapped(this.activeStderr, event.data)
        }
      }
    })
  }

  // ---- Public API ----

  /**
   * PRE-KM-1/INV-KM-1: serializes executions through a queue preserving
   * submission order; concurrent calls never overlap transport.execute.
   *
   * The FIRST execute starts executeInternal immediately (synchronously until
   * the first await) so the virtual clock can drive timers. Subsequent calls
   * chain off the previous execution's completion.
   */
  execute(code: string): Promise<KernelExecutionResult> {
    if (this.disposed) {
      return Promise.reject(
        new RlmKernelContractError('KernelManager has been disposed'),
      )
    }

    const prev = this.chainTail
    let exec: Promise<KernelExecutionResult>
    if (prev === null) {
      // First execution — start immediately
      exec = this.executeInternal(code)
    } else {
      // Subsequent execution — chain after previous
      exec = prev.then(() => {
        if (this.disposed) {
          throw new RlmKernelContractError('KernelManager has been disposed')
        }
        return this.executeInternal(code)
      })
    }

    // Attach an internal rejection handler to prevent unhandled rejection
    // crashes. This also ensures the promise is "observed" so that
    // expect().rejects works correctly in the test harness (bun's
    // expect().rejects needs an already-observed promise).
    this.chainTail = exec.then(
      () => undefined,
      () => undefined,
    )

    return exec
  }

  /**
   * ERRORS-KM-3: interrupts the active execution; if it has not settled
   * within ABORT_GRACE_MS (clock-scheduled), resolves with status 'aborted'.
   */
  abort(): Promise<void> {
    this.aborted = true
    if (this.activeExecutionId !== null) {
      safeInterrupt(this.transport)
    } else {
      // Abort arrived before executeInternal set up active state.
      // Schedule the grace timer so it can fire even if executeInternal
      // hasn't started yet.
      this.pendingAbort = true
    }

    // The grace callback may only settle a THEN-ACTIVE execution. An
    // execution that already settled normally (or was never started)
    // must not latch a poison flag for the next one (audit r2 V1:
    // grace firing into a consumed settle re-created the poisoning).
    this.clock.schedule(() => {
      const settle = this.activeSettle
      if (settle !== null && this.activeExecutionId !== null) {
        this.activeSettle = null
        this.activeExecutionId = null
        settle({
          status: 'aborted',
          stdout: truncateStream(this.activeStdout),
          stderr: truncateStream(this.activeStderr),
          result: '',
          traceback: undefined,
          errorEname: undefined,
          durationMs: this.clock.now() - this.activeStartTime,
        })
      }
      // No active execution at grace time: nothing to settle — an idle
      // abort must leave NO trace for subsequent executions
    }, ABORT_GRACE_MS)

    return Promise.resolve()
  }

  /** SEQ-KM-5: returns the compaction notice (null before first snapshot). */
  compactionNotice(): string | null {
    return this.compactionNoticeValue
  }

  /**
   * SLICE-4 additive: the names restored by the last admission, empty
   * before first start. The tool/extension reads this for revival notices.
   */
  restoredNames(): readonly string[] {
    return this.lastRestoredNames
  }

  /**
   * SLICE-4 additive: user-initiated kernel kill (the tool's busy-restart
   * path). Kills the transport and resets the started flag so the next
   * admission runs the full start→restore→bootstrap sequence.
   */
  async kill(): Promise<void> {
    this.started = false
    this.lastRestoredNames = []
    const killResult = this.transport.kill()
    if (killResult instanceof Promise) await killResult.catch(() => undefined)
  }

  /**
   * SEQ-KM-4: dispose({snapshot:true}) flushes snapshot before teardown.
   * INV-KM-LIFETIME-2: waits at most DISPOSE_TIMEOUT_MS for in-flight
   * executions, then calls kill() and transport dispose.
   */
  async dispose(options?: { readonly snapshot?: boolean }): Promise<void> {
    // C9: idempotent — second dispose (signal handler + session teardown)
    // is a no-op, never re-snapshotting or re-killing a dead transport
    if (this.disposeCompleted) return
    this.disposed = true

    // Cancel any pending debounced snapshot
    if (this.snapshotCancel !== null) {
      this.snapshotCancel()
      this.snapshotCancel = null
    }

    // SEQ-KM-4/F-181 (V2): flush snapshot before teardown if requested —
    // bounded by SNAPSHOT_DISPOSE_TIMEOUT_MS so a hung kernel cannot
    // deadlock teardown (prime-agent flushSnapshotForDispose shape)
    if (options?.snapshot === true) {
      await Promise.race([
        this.runSnapshot().catch((error: unknown) => {
          // Snapshot failure at teardown is observable, not silent (F8):
          // the durability loss is named; teardown proceeds
          this.teardownNotice = `snapshot flush failed during dispose: ${String(error)}`
        }),
        new Promise<void>(resolve => {
          this.clock.schedule(() => resolve(), SNAPSHOT_DISPOSE_TIMEOUT_MS)
        }),
      ])
    }

    // INV-KM-LIFETIME-2: wait for in-flight executions with timeout
    const waitTarget =
      this.chainTail ?? Promise.resolve()
    await Promise.race([
      waitTarget,
      new Promise<void>(resolve => {
        this.clock.schedule(() => resolve(), DISPOSE_TIMEOUT_MS)
      }),
    ])

    // V3/F11: any execution still in flight at teardown gets a terminal
    // state — the future tool layer must never hang on a settled session
    // (prime-agent rejectActiveExecution shape)
    const stranded = this.activeSettle
    if (stranded !== null) {
      this.activeSettle = null
      this.activeExecutionId = null
      stranded({
        status: 'aborted',
        stdout: truncateStream(this.activeStdout),
        stderr: truncateStream(this.activeStderr),
        result: '',
        traceback: undefined,
        errorEname: undefined,
        durationMs: this.clock.now() - this.activeStartTime,
      })
    }

    // N2: graceful shutdown request before the hard kill (F-011):
    // shutdown_request, wait SHUTDOWN_GRACE_MS, then kill
    const shutdownResult = this.transport.shutdown?.()
    if (shutdownResult instanceof Promise) await shutdownResult
    if (this.transport.shutdown !== undefined) {
      await new Promise<void>(resolve => {
        this.clock.schedule(() => resolve(), SHUTDOWN_GRACE_MS)
      })
    }
    const killResult = this.transport.kill()
    if (killResult instanceof Promise) await killResult
    const disposeResult = this.transport.dispose()
    if (disposeResult instanceof Promise) await disposeResult
    this.disposeCompleted = true
  }

  // ---- Internal: start sequence (SEQ-KM-1/SEQ-KM-2) ----

  /**
   * SEQ-KM-1: admits the kernel BEFORE any cell execution.
   * SEQ-KM-2: start -> restoreSnapshot -> bootstrap.
   *
   * SLICE-4 additive: onProgress callback reports phases ('starting',
   * 'restoring', 'preparing') for the tool's working messages. Existing
   * no-arg calls are unchanged.
   */
  async ensureStarted(onProgress?: (phase: 'starting' | 'restoring' | 'preparing') => void): Promise<void> {
    if (this.started) return
    try {
      if (onProgress !== undefined) onProgress('starting')
      await this.transport.start()
    } catch (error) {
      // C1/ERRORS-KM-2: start failures surface as the readiness error
      // with the kernel's stderr tail bounded to STDERR_TAIL_CHARS
      const tail = boundedStderrTail(error instanceof Error ? error.message : String(error))
      throw new KernelUnresponsiveError(tail)
    }
    if (onProgress !== undefined) onProgress('restoring')
    this.lastRestoredNames = await this.transport.restoreSnapshot()
    if (onProgress !== undefined) onProgress('preparing')
    await this.transport.bootstrap()
    this.started = true
  }

  /** C4/INV-KM-LIFETIME-1: a kernel that died BETWEEN executions is
   * replaced BEFORE the next execution runs — reactive retry stays as the
   * mid-execution safety net, but the common idle-death case never burns
   * it. */
  private async ensureAlive(): Promise<void> {
    if (this.started && !this.transport.alive()) {
      this.started = false
      const killResult = this.transport.kill()
      if (killResult instanceof Promise) await killResult.catch(() => undefined)
      await this.ensureStarted()
    }
  }

  // ---- Internal: busy-wait (ERRORS-KM-1) ----

  /**
   * ERRORS-KM-1: if transport.isBusy(), interrupt every
   * BUSY_INTERRUPT_INTERVAL_MS for up to BUSY_REUSE_WAIT_MS; if still busy,
   * reject with KernelBusyAfterInterruptError.
   *
   * Called BEFORE ensureStarted so the virtual clock can drive the interrupt
   * cadence without waiting for async admission to complete.
   */
  private async waitForNotBusy(): Promise<void> {
    if (!this.transport.isBusy()) return
    const startTime = this.clock.now()

    while (this.transport.isBusy()) {
      const elapsed = this.clock.now() - startTime
      if (elapsed >= BUSY_REUSE_WAIT_MS) {
        throw new KernelBusyAfterInterruptError(
          `waited ${elapsed}ms`,
        )
      }
      safeInterrupt(this.transport)
      await new Promise<void>(resolve => {
        this.clock.schedule(() => resolve(), BUSY_INTERRUPT_INTERVAL_MS)
      })
    }
  }

  // ---- Internal: execute (POST-KM-1 through ERRORS-KM-3) ----

  private async executeInternal(
    code: string,
  ): Promise<KernelExecutionResult> {
    // ERRORS-KM-1: busy-wait if kernel is occupied (before admission so
    // the virtual clock can drive the interrupt cadence)
    await this.waitForNotBusy()

    // SEQ-KM-1/SEQ-KM-2: admit kernel before execution
    await this.ensureStarted()

    // C4: idle death replaced reactively above; between-execution death
    // replaced HERE, before the cell is dispatched
    await this.ensureAlive()

    const id = this.generateExecId()
    const startTime = this.clock.now()

    this.activeExecutionId = id
    this.activeStdout = ''
    this.activeStderr = ''
    this.aborted = false
    this.activeStartTime = startTime

    // An abort requested during waitForNotBusy/ensureStarted applies to
    // THIS execution only (it was mid-flight in the serialization chain);
    // it must never poison executions that start after this one
    if (this.pendingAbort) {
      this.pendingAbort = false
      this.activeExecutionId = null
      return {
        status: 'aborted',
        stdout: '',
        stderr: '',
        result: '',
        traceback: undefined,
        errorEname: undefined,
        durationMs: 0,
      }
    }

    // Handle abort that arrived before executeInternal set up active state
    if (this.pendingAbort) {
      this.pendingAbort = false
      this.aborted = true
      safeInterrupt(this.transport)
      // Grace timer is already scheduled; set up settle so it can resolve
      return new Promise<KernelExecutionResult>((resolve) => {
        this.activeSettle = resolve
      })
    }

    return new Promise<KernelExecutionResult>((resolve) => {
      this.activeSettle = resolve

      // If abort was called between setting activeExecutionId and entering
      // this promise constructor, don't call transport.execute
      if (this.aborted) return

      this.transport.execute(id, code).then((execResult) => {
        // If already settled by abort, do nothing
        const settle = this.activeSettle
        if (settle === null) return
        this.activeSettle = null
        this.activeExecutionId = null

        const durationMs = this.clock.now() - startTime
        const result = this.buildResult(execResult, durationMs)
        settle(result)

        // SEQ-KM-3: schedule debounced snapshot after successful execution
        if (execResult.code === 0) {
          this.scheduleSnapshot()
        }
      }).catch((deathCause: unknown) => {
        // If aborted, do not restart
        if (this.aborted) return

        // INV-KM-LIFETIME-1/3: kernel death — restart and retry once
        this.handleKernelDeath(code, startTime, deathCause).then((result) => {
          const settle = this.activeSettle
          if (settle === null) return
          this.activeSettle = null
          this.activeExecutionId = null
          settle(result)
          if (result.status === 'ok') {
            this.scheduleSnapshot()
          }
        }).catch(() => {
          const settle = this.activeSettle
          if (settle === null) return
          this.activeSettle = null
          this.activeExecutionId = null
          settle({
            status: 'error',
            stdout: '',
            stderr: '',
            result: '',
            traceback: undefined,
            errorEname: undefined,
            durationMs: this.clock.now() - startTime,
          })
        })
      })
    })
  }

  // ---- Internal: kernel death handling (INV-KM-LIFETIME-1/3) ----

  private async handleKernelDeath(
    code: string,
    startTime: number,
    deathCause: unknown,
  ): Promise<KernelExecutionResult> {
    // Restart kernel: full start sequence (SEQ-KM-2)
    this.started = false
    try {
      await this.ensureStarted()
    } catch (restartError) {
      // F8: double-death diagnostics surface — a blank error for the
      // model is worse than the failure itself
      throw new RlmKernelContractError(
        `kernel died mid-execution and restart also failed: ${String(deathCause)}; restart error: ${String(restartError)}`,
        { cause: restartError },
      )
    }

    // Retry the cell ONCE with a fresh execution id
    const id = this.generateExecId()
    this.activeExecutionId = id
    this.activeStdout = ''
    this.activeStderr = ''

    const execResult = await this.transport.execute(id, code)
    const durationMs = this.clock.now() - startTime
    const baseResult = this.buildResult(execResult, durationMs)

    // INV-KM-LIFETIME-3: carry kernelRestarted:true on success;
    // compactionNotice stays null on this path
    return { ...baseResult, kernelRestarted: true }
  }

  // ---- Internal: build result (POST-KM-1/POST-KM-2) ----

  private buildResult(
    execResult: KernelTransportExecuteResult,
    durationMs: number,
  ): KernelExecutionResult {
    // POST-KM-1: transport code !== 0 → status 'error'
    const status: KernelExecutionStatus =
      execResult.code !== 0 ? 'error' : 'ok'

    // POST-KM-3: combine streaming output with transport reply
    const stdout = this.activeStdout + execResult.stdout
    const stderr = this.activeStderr + execResult.stderr

    // POST-KM-2: truncate each stream exceeding MAX_OUTPUT_CHARS
    return {
      status,
      stdout: truncateStream(stdout),
      stderr: truncateStream(stderr),
      result: truncateStream(execResult.result),
      traceback: execResult.traceback,
      errorEname: execResult.errorEname,
      durationMs: Math.max(0, durationMs),
    }
  }

  // ---- Internal: snapshot (SEQ-KM-3/FORBIDDEN-KM-1/SEQ-KM-5) ----

  /**
   * SEQ-KM-3: schedule a debounced snapshot write SNAPSHOT_DEBOUNCE_MS later;
   * each new successful execution cancels the pending timer and reschedules
   * (coalescing: exactly one writeSnapshot per quiet window).
   */
  private scheduleSnapshot(): void {
    if (this.snapshotCancel !== null) {
      this.snapshotCancel()
      this.snapshotCancel = null
    }

    this.snapshotCancel = this.clock.schedule(() => {
      this.snapshotCancel = null
      void this.runSnapshot().catch((error: unknown) => {
        // F8: snapshot failure is observable, never silent — the previous
        // snapshot remains intact (FORBIDDEN-KM-1) and the loss is named
        this.teardownNotice = `debounced snapshot failed: ${String(error)}`
      })
    }, SNAPSHOT_DEBOUNCE_MS)
  }

  /** F8: observable failures (snapshot loss at teardown or debounce);
   * cleared on read so each notice is delivered once. */
  takeTeardownNotice(): string | null {
    const notice = this.teardownNotice
    this.teardownNotice = null
    return notice
  }

  /**
   * FORBIDDEN-KM-1/SEQ-KM-5: snapshot flow — snapshotNames → filter
   * SNAPSHOT_ALWAYS_SKIP → writeSnapshot → atomic payload write → manifest.
   */
  private async runSnapshot(): Promise<void> {
    // C5: snapshots run through the serialization chain — a snapshot cell
    // concurrent with an active cell races kernel state (prime-agent
    // enqueues snapshot cells; same discipline here)
    const run = (async (): Promise<void> => {
      // Gather all names from the kernel
      const allNames = await this.transport.snapshotNames()

      // Filter out always-skip names (FORBIDDEN-KM-3)
      const skipSet = new Set<string>(SNAPSHOT_ALWAYS_SKIP)
      const filteredNames = allNames.filter(
        (n: string) => !skipSet.has(n),
      )

      // Write snapshot (serialization in kernel process); C2/F-174: the
      // byte cap flows through the seam — the writer is TOLD the budget
      const writeResult = await this.transport.writeSnapshot(
        filteredNames,
        SNAPSHOT_MAX_BYTES,
      )

      // Atomic payload write: write to a temp dir INSIDE artifactsDir,
      // then rename within the same filesystem (V4/F3: a cross-filesystem
      // temp location silently degrades to non-atomic copy — same-dir
      // rename is atomic on POSIX)
      // FORBIDDEN-KM-1: crash mid-write must leave prior artifacts intact
      const payloadFn = this.transport.writeSnapshotPayload
      if (typeof payloadFn === 'function') {
        const tempDir = join(
          this.artifactsDir,
          `.kernel-snapshot-tmp-${this.clock.now()}-${Math.random().toString(36).slice(2, 10)}`,
        )
        try {
          fs.mkdirSync(this.artifactsDir, { recursive: true })
          fs.mkdirSync(tempDir, { recursive: true })
          await payloadFn(tempDir)

          // Same-filesystem rename: atomic
          const payloadSrc = join(tempDir, SNAPSHOT_PAYLOAD_FILE)
          const payloadDest = join(this.artifactsDir, SNAPSHOT_PAYLOAD_FILE)
          fs.renameSync(payloadSrc, payloadDest)
        } finally {
          // Clean up temp dir regardless of success/failure
          try {
            fs.rmSync(tempDir, { recursive: true, force: true })
          } catch {
            // temp cleanup failure never affects the committed payload
          }
        }
      }

      // C6: the manifest's pythonVersion comes from the kernel when the
      // transport can report it (prime-agent writes sys.version)
      const pythonVersion = await (this.transport.pythonVersion?.()
        ?? Promise.resolve(''))

      // V5/F4: the manifest gets the same atomicity guarantee as the
      // payload — temp file in artifactsDir + rename (a torn manifest
      // makes the prior snapshot unreadable per INV-KM-2)
      const manifest: KernelSnapshotManifest = {
        version: SNAPSHOT_MANIFEST_VERSION,
        savedNames: filteredNames,
        skipped: writeResult.skipped,
        bytes: writeResult.bytes,
        pythonVersion,
        timestamp: utcIsoTimestamp(this.clock),
      }
      atomicWriteFileSync(
        join(this.artifactsDir, SNAPSHOT_MANIFEST_FILE),
        JSON.stringify(manifest),
      )
    })()
    // The chain tail carries this snapshot; a cell submitted meanwhile
    // serializes AFTER it (chain discipline preserved)
    const prev = this.chainTail
    const next = (prev ?? Promise.resolve()).then(() => run, () => run)
    this.chainTail = next.then(() => undefined, () => undefined)
    await next
  }

  /**
   * SEQ-KM-5: compaction completion sets the notice (queried via
   * compactionNotice()): null before, and after contains every live name
   * from snapshotNames() and the word 'persist'. Snapshots themselves are
   * not compaction events and never set the notice.
   */
  async onCompactionComplete(): Promise<void> {
    const allNames = await this.transport.snapshotNames()
    const skipSet = new Set<string>(SNAPSHOT_ALWAYS_SKIP)
    const liveNames = allNames.filter((n: string) => !skipSet.has(n))
    this.compactionNoticeValue =
      `Kernel state persisted. Namespace inventory: ${liveNames.join(', ')}`
  }

  // ---- Internal: id generation ----

  private generateExecId(): string {
    this.execCounter += 1
    return `exec-${this.execCounter}`
  }
}
