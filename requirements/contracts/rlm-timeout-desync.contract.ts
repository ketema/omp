/**
 * RLM Timeout Desync Contract — specification authority.
 *
 * Enforces deterministic execution synchronization across cell timeouts and
 * interrupts. Guarantees that any in-flight execution promise is settled cleanly
 * before a subsequent execute operation proceeds, preventing frame de-sync
 * and promise deadlocks.
 *
 * Traceability: REQ-2026-RLM-TIMEOUT-DESYNC, issue ketema/omp#12.
 *
 * The implementation does NOT import from this file; tests import both.
 */

// =============================================================================
// Artifact 1: Importable Constants
// =============================================================================

export const EXECUTE_TIMEOUT_MS = 30000;
export const INTERRUPTED_ERROR_ENAME = "InterruptedError";
export const KERNEL_TIMEOUT_ERROR_ENAME = "KernelExecuteTimeoutError";
export const SUPERSEDED_EXECUTION_MSG = "Previous execution interrupted or superseded by new execute() call";

// =============================================================================
// Artifact 2: Domain Exception Classes
// =============================================================================

export class RlmTimeoutContractError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RlmTimeoutContractError";
  }
}

/** ERRORS-DESYNC-1: Frame received for mismatched execution ID. */
export class StaleFrameError extends RlmTimeoutContractError {
  constructor(frameId: string, activeId: string | null) {
    super(`Received stale frame ID ${frameId} while active execution ID is ${activeId ?? "none"}`);
    this.name = "StaleFrameError";
  }
}

/** ERRORS-DESYNC-2: Execution superseded by incoming operation. */
export class InterruptedExecutionError extends RlmTimeoutContractError {
  constructor(execId: string) {
    super(`Execution ${execId} was interrupted or superseded before completion`);
    this.name = "InterruptedExecutionError";
  }
}

/** ERRORS-DESYNC-3: Execution exceeded wall-clock timeout ceiling. */
export class TimeoutDesyncError extends RlmTimeoutContractError {
  constructor(durationMs: number, ceilingMs = EXECUTE_TIMEOUT_MS) {
    super(`Execution exceeded wall-clock timeout of ${ceilingMs}ms (took ${durationMs}ms)`);
    this.name = "TimeoutDesyncError";
  }
}

// =============================================================================
// Artifact 3: Types & Interfaces
// =============================================================================

export interface SettledExecution {
  code: number;
  stdout: string;
  stderr: string;
  result: string;
  errorEname?: string;
  traceback?: string;
}

export interface TimeoutDesyncState {
  activeExecId: string | null;
  hasActivePending: boolean;
}

// =============================================================================
// Artifact 4: Callable Pure Validators
// =============================================================================

export function validateExecutionSettlement(result: unknown): asserts result is SettledExecution {
  if (typeof result !== "object" || result === null) {
    throw new RlmTimeoutContractError("Settled execution must be a non-null object");
  }
  const r = result as Record<string, unknown>;
  if (typeof r.code !== "number") {
    throw new RlmTimeoutContractError("Settled execution code must be a number");
  }
  if (typeof r.stdout !== "string" || typeof r.stderr !== "string" || typeof r.result !== "string") {
    throw new RlmTimeoutContractError("Settled execution stdout/stderr/result must be strings");
  }
}

export function validateFrameIdMatch(frameId: string | undefined, activeExecId: string | null): boolean {
  if (!frameId || !activeExecId) return false;
  return frameId === activeExecId;
}

// =============================================================================
// Artifact 5: CONTRACT_RLM_TIMEOUT_DESYNC Traceability Dictionary
// =============================================================================

export const CONTRACT_RLM_TIMEOUT_DESYNC = {
  "POST-TRANS-2": {
    id: "POST-TRANS-2",
    description: "execute(id, code) sends op and settles cleanly from done frame or superseding execute",
    verification: "test",
  },
  "POST-KM-4": {
    id: "POST-KM-4",
    description: "Cell execution exceeding 30000ms is interrupted and settled as error",
    verification: "test",
  },
  "INV-TRANS-1": {
    id: "INV-TRANS-1",
    description: "Frames are only delivered to the matching active execution ID",
    verification: "test",
  },
  "SEQ-1": {
    id: "SEQ-1",
    description: "KernelManager arms timeout timer before transport execute",
    verification: "test",
  },
  "SEQ-2": {
    id: "SEQ-2",
    description: "KernelManager sends interrupt to transport upon timer expiry",
    verification: "test",
  },
  "SEQ-3": {
    id: "SEQ-3",
    description: "Transport settles prior activeExecPending before registering new execute ID",
    verification: "test",
  },
  "SEQ-4": {
    id: "SEQ-4",
    description: "Transport routes incoming done frame to active pending execution",
    verification: "test",
  },
  "ERRORS-1": {
    id: "ERRORS-1",
    description: "Runner exit during execution rejects pending execution with TransportProtocolError",
    verification: "test",
  },
  "ERRORS-2": {
    id: "ERRORS-2",
    description: "Stale done frame for inactive execution is discarded without error",
    verification: "test",
  },
  "ERRORS-3": {
    id: "ERRORS-3",
    description: "Malformed frame raises TransportProtocolError immediately",
    verification: "test",
  },
  "IP-1": {
    id: "IP-1",
    description: "KernelManager executeInternal passes cell ID and code to transport execute",
    verification: "test",
  },
  "IP-2": {
    id: "IP-2",
    description: "KernelManager execute timer invokes transport interrupt on expiry",
    verification: "test",
  },
  "IP-3": {
    id: "IP-3",
    description: "Transport sendOp writes JSON lines op to runner stdin",
    verification: "test",
  },
  "IP-4": {
    id: "IP-4",
    description: "Runner stdout is parsed by transport handleLine into protocol frames",
    verification: "test",
  },
  "FORBIDDEN-1": {
    id: "FORBIDDEN-1",
    description: "Transport SHALL NOT overwrite activeExecPending without settling prior promise",
    verification: "test",
  },
  "FORBIDDEN-2": {
    id: "FORBIDDEN-2",
    description: "Transport SHALL NOT deliver stream frames from prior execution ID to new execution",
    verification: "test",
  },
} as const;
