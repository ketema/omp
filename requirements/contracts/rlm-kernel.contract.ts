/**
 * RLM Kernel Manager Contract — specification authority.
 *
 * WHAT the kernel manager must guarantee (lifecycle, serialized execution,
 * output shaping, snapshot/revival timing), NOT how it spawns processes.
 *
 * The implementation (packages/rlm/src/*) does NOT import from this file.
 * It redeclares its own values; tests import BOTH and assert alignment.
 *
 * Traceability: REQ-RLM-0003, REQ-RLM-0004, REQ-RLM-0011; F-001..F-018,
 * F-029, F-031, F-032, F-170..F-183, F-220..F-224; IP-1, IP-5, IP-6;
 * SEQ-1..SEQ-5; A-005.
 */

// =============================================================================
// Artifact 1: Importable constants (behavioral, not implementation details)
// =============================================================================

/** F-003: readiness probe budget. */
export const KM_READY_TIMEOUT_MS = 5000
/** F-003: port resolution budget. */
export const KM_PORTS_RESOLVE_TIMEOUT_MS = 5000
/** F-006: per-stream output cap before truncation. */
export const KM_MAX_OUTPUT_CHARS = 65536
/** F-008: grace between interrupt and forced abort resolution. */
export const KM_ABORT_GRACE_MS = 1000
/** F-009: total wait before busy-after-interrupt failure. */
export const KM_BUSY_REUSE_WAIT_MS = 5000
/** F-009: interrupt cadence while kernel is busy. */
export const KM_BUSY_INTERRUPT_INTERVAL_MS = 500
/** F-011: grace between shutdown_request and process kill. */
export const KM_SHUTDOWN_GRACE_MS = 200
/** F-012: wait budget for in-flight host requests during dispose. */
export const KM_DISPOSE_TIMEOUT_MS = 5000
/** F-180: snapshot debounce after successful execution. */
export const KM_SNAPSHOT_DEBOUNCE_MS = 1500
/** F-181: snapshot flush budget during shutdown. */
export const KM_SNAPSHOT_DISPOSE_TIMEOUT_MS = 5000
/** F-174: total snapshot byte cap. */
export const KM_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024
/** F-017: stderr tail quoted in readiness/port failures. */
export const KM_STDERR_TAIL_CHARS = 1024
/** F-006: exact truncation marker (printf-style, %d = char count). */
export const KM_TRUNCATION_MARKER = '[... output truncated at %d chars ...]'
/** F-013: dead-kernel liveness poll cadence. */
export const KM_LIVENESS_POLL_MS = 1000
/** F-170: snapshot payload artifact name. */
export const KM_SNAPSHOT_PAYLOAD_FILE = 'kernel-state.dill'
/** F-170: snapshot manifest artifact name. */
export const KM_SNAPSHOT_MANIFEST_FILE = 'kernel-state.json'
/** F-176: manifest schema version. */
export const KM_SNAPSHOT_MANIFEST_VERSION = 1
/** F-173: names always excluded from snapshots. */
export const KM_SNAPSHOT_ALWAYS_SKIP: readonly string[] = [
  'rlm', 'asyncio', 'In', 'Out', 'get_ipython', 'exit', 'quit', 'open',
] as const

// =============================================================================
// Artifact 2: Exception classes (blame-preserving)
// =============================================================================

/** Base for kernel-manager contract violations. */
export class RlmKernelContractError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RlmKernelContractError'
  }
}

/** F-221: kernel still busy after repeated interrupts. */
export class KernelBusyAfterInterruptError extends RlmKernelContractError {
  constructor(detail: string) {
    super(
      `IPython kernel is still running the previously interrupted cell. Wait and try again, or kill the IPython kernel to start fresh. ${detail}`,
    )
    this.name = 'KernelBusyAfterInterruptError'
  }
}

/** F-223: readiness probe exceeded budget. */
export class KernelUnresponsiveError extends RlmKernelContractError {
  constructor(stderrTail: string) {
    super(
      `Kernel did not respond to kernel_info_request within ${KM_READY_TIMEOUT_MS}ms. stderr tail: ${stderrTail}`,
    )
    this.name = 'KernelUnresponsiveError'
  }
}

/** F-224: connection ports did not resolve in budget. */
export class KernelPortsUnresolvedError extends RlmKernelContractError {
  constructor(stderrTail: string) {
    super(
      `Kernel did not resolve connection ports within ${KM_PORTS_RESOLVE_TIMEOUT_MS}ms. stderr tail: ${stderrTail}`,
    )
    this.name = 'KernelPortsUnresolvedError'
  }
}

/** F-222: execution aborted before completion. */
export class ExecutionAbortedError extends RlmKernelContractError {
  constructor() {
    super('IPython execution aborted')
    this.name = 'ExecutionAbortedError'
  }
}

// =============================================================================
// Artifact 3: Structural types (the dataclasses of the contract)
// =============================================================================

/** Observable execution status. F-031/F-032. */
export type KernelExecutionStatus = 'ok' | 'error' | 'aborted'

/** One execution's observable result. F-031. */
export interface KernelExecutionResult {
  readonly status: KernelExecutionStatus
  readonly stdout: string
  readonly stderr: string
  readonly result: string
  readonly traceback: string | undefined
  readonly errorEname: string | undefined
  readonly durationMs: number
}

/** Snapshot manifest v1. F-176. */
export interface KernelSnapshotManifest {
  readonly version: 1
  readonly savedNames: readonly string[]
  readonly skipped: readonly { readonly name: string; readonly reason: string }[]
  readonly bytes: number
  readonly pythonVersion: string
  readonly timestamp: string
}

// =============================================================================
// Artifact 4: Callable validators (runtime enforcement, trust boundaries)
// =============================================================================

/**
 * KM-V1: truncation marker formatting. The implementation must produce
 * markers of exactly this shape (F-006).
 */
export function validateTruncationMarker(marker: string, chars: number): string {
  const expected = KM_TRUNCATION_MARKER.replace('%d', String(chars))
  if (marker !== expected) {
    throw new RlmKernelContractError(
      `KM-V1 violation: truncation marker must be exactly ${JSON.stringify(expected)}, got ${JSON.stringify(marker)}`,
    )
  }
  return marker
}

/**
 * KM-V2: stderr tail bounding. Every error path quoting kernel stderr must
 * bound it to KM_STDERR_TAIL_CHARS (F-017).
 */
export function validateStderrTail(tail: string): string {
  if (tail.length > KM_STDERR_TAIL_CHARS) {
    throw new RlmKernelContractError(
      `KM-V2 violation: stderr tail exceeds ${KM_STDERR_TAIL_CHARS} chars (${tail.length})`,
    )
  }
  return tail
}

/**
 * KM-V3: snapshot manifest shape. F-176.
 */
export function validateSnapshotManifest(
  candidate: unknown,
): KernelSnapshotManifest {
  const m = candidate as Partial<KernelSnapshotManifest> | null
  const namesOk = Array.isArray(m?.savedNames)
    && m.savedNames.every((n: unknown) => typeof n === 'string' && n.length > 0)
  const skippedOk = Array.isArray(m?.skipped)
    && m.skipped.every(
      (s: unknown) => typeof s === 'object' && s !== null
        && typeof (s as { name?: unknown }).name === 'string'
        && typeof (s as { reason?: unknown }).reason === 'string',
    )
  if (
    m === null || typeof m !== 'object'
    || m.version !== KM_SNAPSHOT_MANIFEST_VERSION
    || !namesOk || !skippedOk
    || typeof m.bytes !== 'number'
    || typeof m.pythonVersion !== 'string'
    || typeof m.timestamp !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(m.timestamp)
  ) {
    throw new RlmKernelContractError(
      'KM-V3 violation: snapshot manifest must be schema v1 with UTC ISO timestamp, non-empty string savedNames, and {name, reason} skipped entries',
    )
  }
  return m as KernelSnapshotManifest
}

// =============================================================================
// Artifact 5: Traceability dict
// =============================================================================

export const RLM_KERNEL_CONTRACT = {
  'PRE-KM-1': 'execute() callers hold an admitted kernel; the manager serializes cells (F-004).',
  'POST-KM-1': 'Execute resolves with a KernelExecutionResult whose status is one of ok|error|aborted (F-031).',
  'POST-KM-2': 'Each stdout/stderr/result stream exceeding KM_MAX_OUTPUT_CHARS carries the exact truncation marker with the cap count (F-006).',
  'POST-KM-3': 'Output accepted only from the active execution id; stale-stream output never leaks into a later result (F-005).',
  'INV-KM-1': 'No two ordinary cells execute concurrently; the serialization queue preserves submission order (F-004).',
  'INV-KM-2': 'A crash during snapshot writing leaves the previous snapshot intact and readable (F-171, REQ-RLM-0011).',
  'INV-KM-3': 'Snapshot restore runs after process start and before runtime bootstrap overwrites live handles (F-177, SEQ-2).',
  'INV-KM-LIFETIME-1': 'From first admission through dispose, a dead kernel is replaced before the next execution, and one retry covers a mid-execution death (F-013).',
  'INV-KM-LIFETIME-3': 'An automatic mid-execution death replacement records kernelRestarted in the result details and emits no restart notice; the restart notice is reserved for the user-initiated interrupt→kill→restart path (F-013/F-031 vs F-029).',
  'INV-KM-LIFETIME-2': 'Dispose waits at most KM_DISPOSE_TIMEOUT_MS for in-flight host requests, then closes transports and kills the process (F-012).',
  'SEQ-KM-1': 'First tool call SHALL admit the kernel BEFORE any cell execution (IP-1, REQ-RLM-0003).',
  'SEQ-KM-2': 'Kernel start SHALL restore snapshot state BEFORE bootstrap injection (SEQ-2, IP-5, F-177).',
  'SEQ-KM-3': 'Each successful execution SHALL schedule a debounced snapshot within KM_SNAPSHOT_DEBOUNCE_MS (SEQ-3, IP-5, F-180).',
  'SEQ-KM-4': 'Session dispose SHALL flush a snapshot BEFORE transport teardown completes (SEQ-4, IP-5, F-181).',
  'SEQ-KM-5': 'Compaction completion SHALL inject the namespace-inventory notice (kernel persisted, live names listed) BEFORE the Model continues (SEQ-5, F-179, IP-6).',
  'ERRORS-KM-1': 'KernelBusyAfterInterruptError when busy persists past KM_BUSY_REUSE_WAIT_MS with interrupts at KM_BUSY_INTERRUPT_INTERVAL_MS (F-009/F-221).',
  'ERRORS-KM-2': 'KernelUnresponsiveError and KernelPortsUnresolvedError quote a stderr tail bounded by KM_STDERR_TAIL_CHARS (F-223/F-224).',
  'ERRORS-KM-3': 'ExecutionAbortedError resolves any execution cancelled mid-flight after KM_ABORT_GRACE_MS (F-008/F-222).',
  'FORBIDDEN-KM-1': 'The manager SHALL NOT lose the previous snapshot to a crash mid-write; the prior snapshot stays intact and readable (F-171, REQ-RLM-0011, A-005).',
  'FORBIDDEN-KM-2': 'The manager SHALL NOT accept output whose execution id differs from the active execution, except bridge comms (F-005, REQ-RLM-0004, A-005).',
  'FORBIDDEN-KM-3': 'The manager SHALL NOT snapshot names in KM_SNAPSHOT_ALWAYS_SKIP or any name exceeding the per-variable byte cap without recording it in skipped (F-173/F-174, REQ-RLM-0011, A-005).',
} as const

export type RlmKernelClauseId = keyof typeof RLM_KERNEL_CONTRACT