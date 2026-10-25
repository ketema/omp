/**
 * RLM Session Artifacts Isolation Contract — Specification Authority for SLICE-2.
 *
 * Defines the behavioral contract for session-partitioned persistent kernel state,
 * atomic fallback directory isolation, teardown error propagation, and non-theater
 * wire telemetry.
 *
 * Traceability:
 *   REQ-RLM-REHYDRATE-001 (Resilient Restore: skipped variables in telemetry)
 *   REQ-RLM-REHYDRATE-003 (State Isolation: fallback to dedicated isolated dir, no cross-session bleed, adopted manager identity separation, pre-switch flush)
 *   REQ-RLM-REHYDRATE-004 (Quarantine / Fallback: isolate unpartitioned legacy root)
 *
 * The implementation does NOT import from this file; tests import both.
 */

// =============================================================================
// Artifact 1: Importable Constants
// =============================================================================

export const DEFAULT_ARTIFACTS_DIRNAME = ".omp/artifacts";
export const SNAPSHOT_FILENAME = "kernel-state.dill";
export const MANIFEST_FILENAME = "kernel-state.json";
export const LEGACY_QUARANTINE_DIRNAME = ".omp/quarantine";

// =============================================================================
// Artifact 2: Domain Exception Classes
// =============================================================================

export class SessionIsolationContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionIsolationContractError";
  }
}

export class SharedRootBleedError extends SessionIsolationContractError {
  constructor(path: string) {
    super(`POST-SESSION-ISOLATION-1 violation: session resolved unpartitioned root artifacts directory: ${path}`);
    this.name = "SharedRootBleedError";
  }
}

export class FallbackCollisionError extends SessionIsolationContractError {
  constructor(path: string) {
    super(`POST-SESSION-FALLBACK-ISOLATION-1 violation: fallback directory collided with another session: ${path}`);
    this.name = "FallbackCollisionError";
  }
}

// =============================================================================
// Artifact 3: Immutable Typed Records
// =============================================================================

export interface SessionResolutionResult {
  readonly sessionId?: string;
  readonly sessionDir?: string;
  readonly artifactsDir: string;
  readonly isPartitioned: boolean;
  readonly isIsolatedFallback: boolean;
}

// =============================================================================
// Artifact 4: Pure Callable Validators
// =============================================================================

/**
 * Validates that the resolved artifacts directory is strictly partitioned
 * and not a bare unpartitioned workspace root.
 */
export function validateSessionArtifactsDir(
  artifactsDir: string,
  sessionContext?: { sessionId?: string; sessionDir?: string; cwd?: string }
): boolean {
  if (!artifactsDir || artifactsDir.trim() === "") {
    throw new SessionIsolationContractError("POST-SESSION-ISOLATION-1 violation: artifactsDir cannot be empty");
  }

  const effectiveCwd = sessionContext?.cwd ?? "";
  const bareRoot = effectiveCwd ? `${effectiveCwd}/.omp/artifacts` : ".omp/artifacts";

  if (artifactsDir === bareRoot) {
    throw new SharedRootBleedError(artifactsDir);
  }

  if (sessionContext?.sessionDir) {
    if (artifactsDir !== sessionContext.sessionDir && !artifactsDir.startsWith(sessionContext.sessionDir)) {
      throw new SharedRootBleedError(artifactsDir);
    }
  } else if (sessionContext?.sessionId) {
    if (!artifactsDir.includes(sessionContext.sessionId)) {
      throw new SharedRootBleedError(artifactsDir);
    }
  }

  return true;
}

// =============================================================================
// Artifact 5: Clause Contract Map
// =============================================================================

export interface Clause {
  readonly id: string;
  readonly method: "test" | "execution" | "tool";
  readonly description: string;
  readonly requirement_ids: readonly string[];
}

export const CONTRACT_RLM_SESSION_ISOLATION: Readonly<Record<string, Clause>> = {
  "POST-SESSION-ISOLATION-1": {
    id: "POST-SESSION-ISOLATION-1",
    method: "test",
    description: "RLM Extension re-resolves the incoming session's artifactsDir and disposes the outgoing kernel on session_start, session_switch and session_branch, so fresh unlinked sessions do not load snapshots from prior sessions",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
  "POST-SESSION-OWNED-DIR-1": {
    id: "POST-SESSION-OWNED-DIR-1",
    method: "test",
    description: "When the host session exposes a session file (.jsonl), the kernel-state directory is exactly that file path without the .jsonl suffix (the session-owned artifacts directory), never the directory returned by getArtifactsDir() when an adopted parent artifact manager makes the two differ; independent parent/child identities never share kernel-state files. No substring or identifier heuristic is used. PARKED (unestablished intent): adopted session without a session file",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
  "POST-SESSION-PREFLUSH-1": {
    id: "POST-SESSION-PREFLUSH-1",
    method: "test",
    description: "On session_before_switch and session_before_branch the extension flushes the live kernel snapshot through the typed RlmExtensionKernelPort.flushSnapshot boundary (KernelManager.flushSnapshot) BEFORE the host copies artifacts, never disposes the kernel on these cancellable hooks, never cancels the transition, leaves the outgoing kernel usable if the transition is vetoed, and surfaces a flush failure as an observable rlm-warning",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
  "POST-SESSION-READINESS-1": {
    id: "POST-SESSION-READINESS-1",
    method: "test",
    description: "Before probing for and restoring an incoming session's snapshot, the extension awaits the incoming artifact manager's public listFiles() (which awaits the host's pending background artifact copy) whenever that manager's dir is the resolved session-owned dir, so a linked fork's copied kernel-state is never missed. PARKED: adopted managers expose only the parent's readiness, so a child's own pending copy is not observable",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
  "POST-SESSION-FALLBACK-ISOLATION-1": {
    id: "POST-SESSION-FALLBACK-ISOLATION-1",
    method: "test",
    description: "When session ID or sessionDir is missing or invalid, RLM Extension SHALL allocate a dedicated atomically unique directory (mkdtemp with timestamp prefix) and emit an observable warning, guaranteeing zero collision between concurrent or frozen-clock sessions",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
  "ERRORS-SESSION-SWITCH-DISPOSE-1": {
    id: "ERRORS-SESSION-SWITCH-DISPOSE-1",
    method: "test",
    description: "When outgoing kernel snapshot flush or process disposal encounters errors or generates a teardownNotice, RLM Extension surfaces an observable warning and diagnostic rather than silently dropping the failure",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
  "POST-TRANS-SKIPPED-WIRE-PROPAGATION-1": {
    id: "POST-TRANS-SKIPPED-WIRE-PROPAGATION-1",
    method: "test",
    description: "KernelTransport stdio wire result frames carrying skipped unpicklable variable records must parse and propagate faithfully through real KernelTransport, KernelManager, and KernelManagerAdapter into extension revival notice without test theater",
    requirement_ids: ["REQ-RLM-REHYDRATE-001"],
  },
  "FORBIDDEN-CROSS-SESSION-BLEED-1": {
    id: "FORBIDDEN-CROSS-SESSION-BLEED-1",
    method: "test",
    description: "RLM Extension SHALL NOT auto-restore kernel-state.dill from a shared unpartitioned directory when a session has an explicit session identifier",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
  "IP-5": {
    id: "IP-5",
    method: "test",
    description: "RLM Extension api.on('session_start') delivers partitioned artifactsDir to createDefaultKernel",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
} as const;
