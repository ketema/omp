/**
 * RLM Transport Contract — specification authority.
 *
 * WHAT the real-kernel transport must guarantee (spawn, wire protocol,
 * readiness, teardown, snapshot ops), NOT how the runner is implemented
 * beyond its protocol obligations.
 *
 * The implementation does NOT import from this file; tests import both.
 *
 * Traceability: REQ-RLM-0019, REQ-RLM-0022, REQ-N-1, REQ-N-3;
 * F-001..F-018, F-072/F-073, F-223/F-224; A-005; IP-9; manifest SEQ-12.
 * Added by the 2026-08-16 constitutional-refactor re-assessment that
 * assigned the real kernel spawn to SLICE-4; host_request/host_reply wire
 * added by the 2026-08-17 MCP + in-kernel skills re-assessment.
 */

// =============================================================================
// Artifact 1: Constants
// =============================================================================

/** REQ-RLM-0019: the dedicated runner file shipped inside packages/rlm/. */
export const TRANS_RUNNER_FILE = 'rlm_kernel_runner.py'

/** IP-9: wire protocol version carried in the runner's readiness frame. */
export const TRANS_PROTOCOL_VERSION = 1

/** F-001/SEQ-12: readiness gate budget from spawn to ready frame. */
export const TRANS_READY_TIMEOUT_MS = 5000

/** SEQ-TRANS-2: SIGTERM→SIGKILL escalation grace. */
export const TRANS_KILL_GRACE_MS = 200

/** F-224: stderr tail bound carried into readiness/spawn errors. */
export const TRANS_STDERR_TAIL_CHARS = 1024

/** IP-9: host→runner op names, exact. host_reply settles an in-flight
 * host_request during an execute (REQ-RLM-0022, F-072/F-073). */
export const TRANS_OPS = [
  'execute',
  'interrupt',
  'snapshot_names',
  'snapshot_write',
  'snapshot_restore',
  'bootstrap',
  'shutdown',
  'host_reply',
] as const

/** IP-9: runner→host frame types, exact. host_request is emitted mid-execute
 * when kernel code calls host_request (REQ-RLM-0022, F-071). */
export const TRANS_FRAMES = [
  'ready',
  'started',
  'stdout',
  'stderr',
  'result',
  'error',
  'done',
  'host_request',
] as const

// =============================================================================
// Artifact 2: Exceptions
// =============================================================================

export class RlmTransportContractError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RlmTransportContractError'
  }
}

/** ERRORS-TRANS-1: the runner process could not be spawned. */
export class TransportSpawnError extends RlmTransportContractError {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(`failed to spawn the RLM kernel runner: ${detail}`, options)
    this.name = 'TransportSpawnError'
  }
}

/** ERRORS-TRANS-2: no readiness frame within the gate. */
export class TransportUnresponsiveError extends RlmTransportContractError {
  constructor(stderrTail: string) {
    super(
      `RLM kernel runner did not become ready within ${TRANS_READY_TIMEOUT_MS}ms; stderr tail: ${stderrTail}`,
    )
    this.name = 'TransportUnresponsiveError'
  }
}

/** ERRORS-TRANS-3: a frame violated the wire protocol. */
export class TransportProtocolError extends RlmTransportContractError {
  constructor(detail: string) {
    super(`RLM kernel wire protocol violation: ${detail}`)
    this.name = 'TransportProtocolError'
  }
}

// =============================================================================
// Artifact 3: Structural types
// =============================================================================

/** PRE-TRANS-1: the transport's complete spawn configuration. */
export interface RlmTransportConfig {
  /** Resolved interpreter path (REQ-RLM-0012 bootstrap output). */
  readonly interpreter: string
  /** Spawn env, exactly the buildKernelEnv output (FORBIDDEN-TRANS-2). */
  readonly env: Readonly<Record<string, string>>
  /** Working directory for the runner process. */
  readonly cwd: string
  /** Session artifacts dir; snapshot payload/manifest live here. */
  readonly artifactsDir: string
}

/** IP-9: the runner's readiness frame payload. */
export interface TransReadyFrame {
  readonly type: 'ready'
  readonly protocol: number
  readonly pythonVersion: string
}

// =============================================================================
// Artifact 4: Validators
// =============================================================================

/**
 * TRANS-V1: spawn configuration is complete and bounded (PRE-TRANS-1).
 * Interpreter is a non-empty path; env keys are all non-empty strings.
 */
export function validateTransportConfig(config: unknown): RlmTransportConfig {
  if (typeof config !== 'object' || config === null) {
    throw new RlmTransportContractError(
      'TRANS-V1 violation: transport config requires interpreter, cwd, artifactsDir, and env',
    )
  }
  const c = config as Record<string, unknown>
  const { interpreter, cwd, artifactsDir, env } = c
  if (
    typeof interpreter !== 'string' || interpreter.trim() === ''
    || typeof cwd !== 'string' || cwd.trim() === ''
    || typeof artifactsDir !== 'string' || artifactsDir.trim() === ''
    || typeof env !== 'object' || env === null
  ) {
    throw new RlmTransportContractError(
      'TRANS-V1 violation: transport config requires interpreter, cwd, artifactsDir, and env',
    )
  }
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (key === '' || typeof value !== 'string') {
      throw new RlmTransportContractError(
        'TRANS-V1 violation: spawn env keys and values must be non-empty strings',
      )
    }
  }
  return config as RlmTransportConfig
}

/**
 * TRANS-V2: a wire frame carries a known type (IP-9). Unknown types are a
 * protocol violation, never silently dropped (ERRORS-TRANS-3).
 */
export function validateFrameType(type: unknown): (typeof TRANS_FRAMES)[number] {
  if (typeof type !== 'string' || !(TRANS_FRAMES as readonly string[]).includes(type)) {
    throw new TransportProtocolError(`unknown frame type ${JSON.stringify(type)}`)
  }
  return type as (typeof TRANS_FRAMES)[number]
}

// =============================================================================
// Artifact 5: Traceability
// =============================================================================

export const RLM_TRANSPORT_CONTRACT = {
  'PRE-TRANS-1': 'The transport is constructed with a resolved interpreter path, the buildKernelEnv env set, a cwd, and an artifactsDir (TRANS-V1, REQ-RLM-0012).',
  'POST-TRANS-1': 'start() spawns the dedicated runner (TRANS_RUNNER_FILE) with the configured interpreter and env and resolves only after the ready frame arrives within TRANS_READY_TIMEOUT_MS (F-001, SEQ-12).',
  'POST-TRANS-2': 'execute(id, code) streams the runner stdout/stderr frames through onOutput keyed by id and settles with the cell result: stdout, stderr, result, traceback and errorEname when the cell failed (IP-9).',
  'POST-TRANS-3': 'interrupt() aborts the running cell; the in-flight execute settles as an interrupted error, and the runner stays usable for the next op (F-006).',
  'POST-TRANS-4': 'snapshotNames(), writeSnapshot(names, maxBytes), and restoreSnapshot() round-trip the runner-reported names, byte count, and skip reasons; restore returns the revived names in runner order (F-170..F-183 transport surface).',
  'POST-TRANS-5': 'bootstrap() runs the runtime bootstrap cell in the runner and reports a failed bootstrap as an error, never as success (F-190 transport surface).',
  'POST-TRANS-6': 'During an in-flight execute, the transport delivers a host_request frame from the runner to the host bridge and writes the matching host_reply op back to the runner; the exchange suspends the cell without settling the execute, which settles only on the done frame (F-072/F-073 transport surface, REQ-RLM-0022).',
  'INV-TRANS-1': 'Frames carrying an id that is not the active execution id never leak into any execution result or onOutput delivery (POST-KM-3 transport surface).',
  'SEQ-TRANS-1': 'The transport spawns the runner and passes the readiness gate BEFORE delivering any op; ops issued before start() are a contract violation (manifest SEQ-12, IP-9).',
  'SEQ-TRANS-2': 'kill()/dispose() send SIGTERM and escalate to SIGKILL after TRANS_KILL_GRACE_MS when the runner has not exited; the process handle is released exactly once (F-016).',
  'ERRORS-TRANS-1': 'A spawn failure raises TransportSpawnError with the underlying cause; the error propagates to the caller (fail fast, CL15).',
  'ERRORS-TRANS-2': 'A missing readiness frame within TRANS_READY_TIMEOUT_MS raises TransportUnresponsiveError carrying the stderr tail bounded to TRANS_STDERR_TAIL_CHARS (F-224).',
  'ERRORS-TRANS-3': 'A malformed or unknown frame raises TransportProtocolError; malformed wire input never degrades silently (CL15-B).',
  'FORBIDDEN-TRANS-1': 'The transport and runner are dedicated packages/rlm files; omp eval runner files, kernel registry, and runner semantics are never modified or re-parented (REQ-N-1).',
  'FORBIDDEN-TRANS-2': 'The spawn env carries exactly the provided buildKernelEnv entries; the transport adds no variables of its own (REQ-N-3, F-207 last hop).',
} as const

export type RlmTransportClauseId = keyof typeof RLM_TRANSPORT_CONTRACT
