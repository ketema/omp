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
  kill(): Promise<void> | void
  onOutput(cb: (event: KernelOutputEvent) => void): void
  snapshotNames(): Promise<string[]>
  writeSnapshot(names: readonly string[]): Promise<KernelSnapshotWriteResult>
  writeSnapshotPayload?(dir: string): Promise<void>
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
  private abortGraceFired = false

  // Snapshot debounce timer (SEQ-KM-3)
  private snapshotCancel: (() => void) | null = null

  // Compaction notice (SEQ-KM-5)
  private compactionNoticeValue: string | null = null

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
          this.activeStdout += event.data
        } else {
          this.activeStderr += event.data
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

    this.clock.schedule(() => {
      const settle = this.activeSettle
      if (settle !== null) {
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
      } else {
        this.abortGraceFired = true
      }
    }, ABORT_GRACE_MS)

    return Promise.resolve()
  }

  /** SEQ-KM-5: returns the compaction notice (null before first snapshot). */
  compactionNotice(): string | null {
    return this.compactionNoticeValue
  }

  /**
   * SEQ-KM-4: dispose({snapshot:true}) flushes snapshot before teardown.
   * INV-KM-LIFETIME-2: waits at most DISPOSE_TIMEOUT_MS for in-flight
   * executions, then calls kill() and transport dispose.
   */
  async dispose(options?: { readonly snapshot?: boolean }): Promise<void> {
    this.disposed = true

    // Cancel any pending debounced snapshot
    if (this.snapshotCancel !== null) {
      this.snapshotCancel()
      this.snapshotCancel = null
    }

    // SEQ-KM-4: flush snapshot before teardown if requested
    if (options?.snapshot === true) {
      await this.runSnapshot()
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

    const killResult = this.transport.kill()
    if (killResult instanceof Promise) await killResult
    const disposeResult = this.transport.dispose()
    if (disposeResult instanceof Promise) await disposeResult
  }

  // ---- Internal: start sequence (SEQ-KM-1/SEQ-KM-2) ----

  /**
   * SEQ-KM-1: admits the kernel BEFORE any cell execution.
   * SEQ-KM-2: start -> restoreSnapshot -> bootstrap.
   */
  private async ensureStarted(): Promise<void> {
    if (this.started) return
    await this.transport.start()
    await this.transport.restoreSnapshot()
    await this.transport.bootstrap()
    this.started = true
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

    const id = this.generateExecId()
    const startTime = this.clock.now()

    this.activeExecutionId = id
    this.activeStdout = ''
    this.activeStderr = ''
    this.aborted = false
    this.activeStartTime = startTime

    // Check if abort grace timer already fired while we were in
    // waitForNotBusy / ensureStarted
    if (this.abortGraceFired) {
      this.abortGraceFired = false
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
      }).catch(() => {
        // If aborted, do not restart
        if (this.aborted) return

        // INV-KM-LIFETIME-1/3: kernel death — restart and retry once
        this.handleKernelDeath(code, startTime).then((result) => {
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
  ): Promise<KernelExecutionResult> {
    // Restart kernel: full start sequence (SEQ-KM-2)
    this.started = false
    await this.ensureStarted()

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
      void this.runSnapshot().catch(() => {
        // Snapshot write failed; previous snapshot remains intact (FORBIDDEN-KM-1)
      })
    }, SNAPSHOT_DEBOUNCE_MS)
  }

  /**
   * FORBIDDEN-KM-1/SEQ-KM-5: snapshot flow — snapshotNames → filter
   * SNAPSHOT_ALWAYS_SKIP → writeSnapshot → atomic payload write → manifest.
   */
  private async runSnapshot(): Promise<void> {
    // Gather all names from the kernel
    const allNames = await this.transport.snapshotNames()

    // Filter out always-skip names
    const skipSet = new Set<string>(SNAPSHOT_ALWAYS_SKIP)
    const filteredNames = allNames.filter(
      (n: string) => !skipSet.has(n),
    )

    // Write snapshot (serialization in kernel process)
    const writeResult = await this.transport.writeSnapshot(filteredNames)

    // Atomic payload write: write to temp dir, then move to artifactsDir
    // FORBIDDEN-KM-1: crash mid-write must leave prior artifacts intact
    const payloadFn = this.transport.writeSnapshotPayload
    if (typeof payloadFn === 'function') {
      const tempDir = join(
        tmpdir(),
        `kernel-snapshot-${this.clock.now()}-${Math.random().toString(36).slice(2, 10)}`,
      )
      try {
        fs.mkdirSync(tempDir, { recursive: true })
        await payloadFn(tempDir)

        // On success, move payload to artifactsDir
        const payloadSrc = join(tempDir, SNAPSHOT_PAYLOAD_FILE)
        fs.mkdirSync(this.artifactsDir, { recursive: true })
        const payloadDest = join(this.artifactsDir, SNAPSHOT_PAYLOAD_FILE)
        // Try atomic rename; fall back to copy for cross-filesystem
        try {
          fs.renameSync(payloadSrc, payloadDest)
        } catch {
          fs.copyFileSync(payloadSrc, payloadDest)
        }
      } finally {
        // Clean up temp dir regardless of success/failure
        try {
          fs.rmSync(tempDir, { recursive: true, force: true })
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    // Write manifest (SEQ-KM-5)
    fs.mkdirSync(this.artifactsDir, { recursive: true })
    const manifest: KernelSnapshotManifest = {
      version: SNAPSHOT_MANIFEST_VERSION,
      savedNames: filteredNames,
      skipped: writeResult.skipped,
      bytes: writeResult.bytes,
      pythonVersion: '',
      timestamp: utcIsoTimestamp(this.clock),
    }
    fs.writeFileSync(
      join(this.artifactsDir, SNAPSHOT_MANIFEST_FILE),
      JSON.stringify(manifest),
    )
  }

  /**
   * SEQ-KM-5: compaction completion sets the notice (queried via
   * compactionNotice()): null before, and after contains every live name
   * from snapshotNames() and the word 'persist'. Snapshots themselves are
   * not compaction events and never set the notice.
   */
  async onCompactionComplete(): Promise<void> {
    const allNames = await this.transport.snapshotNames()
    this.compactionNoticeValue =
      `Kernel state persisted. Namespace inventory: ${allNames.join(', ')}`
  }

  // ---- Internal: id generation ----

  private generateExecId(): string {
    this.execCounter += 1
    return `exec-${this.execCounter}`
  }
}
