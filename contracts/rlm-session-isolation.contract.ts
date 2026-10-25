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
    description: "The kernel-state directory of a session is exactly the directory returned by the host's typed sessionManager.resolveOwnArtifactsDir() (POST-SM-OWN-ARTIFACTS-READY-1). sessionManager.getArtifactsDir(), getArtifactManager(), getSessionFile() string manipulation, and event payload fields are never identity sources, so an adopted parent artifact manager can never make two sessions share kernel-state files. No substring or identifier heuristic is used",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
  "POST-SM-OWN-ARTIFACTS-READY-1": {
    id: "POST-SM-OWN-ARTIFACTS-READY-1",
    method: "test",
    description: "SessionManager.resolveOwnArtifactsDir(): Promise<string | null> (also on ReadonlySessionManager) resolves the directory owned by the CURRENT session file (the session file path without .jsonl), and only after any background artifact copy whose destination is that same session file has settled. It ignores an adopted artifact manager (never returns an adopted parent's directory) and resolves null when the session has no session file. getArtifactsDir(), adoptArtifactManager(), getArtifactManager(), non-kernel artifact sharing and the copy layout are unchanged",
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
    description: "The extension probes for, restores, and lets a kernel read or write an incoming session's kernel-state only after that session's resolveOwnArtifactsDir() has resolved, i.e. after the host's background artifact copy into the session's OWN session file has settled; a linked fork/branch's copied kernel-state is therefore never missed or raced. A pending copy for a different session file is never awaited",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
  "POST-SESSION-FALLBACK-ISOLATION-1": {
    id: "POST-SESSION-FALLBACK-ISOLATION-1",
    method: "test",
    description: "Every fallback isolated directory is a dedicated atomically unique directory (mkdtemp with timestamp prefix under <cwd>/.omp/artifacts) announced by an observable rlm-warning naming it, guaranteeing zero collision between concurrent or frozen-clock sessions",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
  "POST-SESSION-NO-OWNED-DIR-ISOLATION-1": {
    id: "POST-SESSION-NO-OWNED-DIR-ISOLATION-1",
    method: "test",
    description: "When no session-owned directory can be established (resolveOwnArtifactsDir() resolves null because the session has no session file; the host sessionManager lacks resolveOwnArtifactsDir; no context is supplied; or a kernel is first used before any lifecycle event resolved a directory), the extension starts the session with fresh isolated state in a POST-SESSION-FALLBACK-ISOLATION-1 directory and restores nothing. It never uses getArtifactsDir() / an adopted parent root, a cwd-relative shared path, or any other session's files. PARKED (needs new intent): persistence/restore policy for sessions without a session file",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
  "POST-SESSION-RESOLUTION-GATE-1": {
    id: "POST-SESSION-RESOLUTION-GATE-1",
    method: "test",
    description: "No kernel is ever constructed against a stale (previous session's) or unresolved directory: kernel construction awaits any in-flight session transition's directory resolution, a transition awaits any in-flight kernel construction before disposing the outgoing kernel, at most one kernel is constructed per resolution, and the injected createKernel receives the resolved artifactsDir",
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
  "POST-TOOL-SESSION-BINDING-1": {
    id: "POST-TOOL-SESSION-BINDING-1",
    method: "test",
    description: "Each ipython tool invocation is bound, at entry and before any await, to the kernel current at that instant (an invocation entered while a session transition is in flight belongs to the incoming session and binds to its kernel once resolved). Every kernel call of that invocation - ensureStarted, execute, the busy-retry execute, and kill - targets exactly that kernel object, and is made only while that kernel is still the extension's current kernel. PERMITTED OUTCOMES, exhaustive: (O1) the cell runs on its bound kernel and returns that kernel's result; (O2) the bound kernel was replaced, disposed or shut down before the call is made: the call is NOT made, the cell code reaches NO kernel, and the tool returns the ERRORS-TOOL-SESSION-CHANGED-1 abort; (O3) the switch occurs while the cell is already running: the cell is left to finish or be bounded by the existing kernel dispose, on its own kernel, and its output is returned to its own invocation, never re-dispatched. FORBIDDEN: any cell code executing on a kernel other than the one bound at entry; any per-call global mutable slot; any lock that makes a session transition wait for a running cell",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
  "ERRORS-TOOL-SESSION-CHANGED-1": {
    id: "ERRORS-TOOL-SESSION-CHANGED-1",
    method: "test",
    description: "When POST-TOOL-SESSION-BINDING-1 outcome O2 occurs the tool does not throw: it returns isError true with details.status 'aborted' and text stating that the session changed and the cell was not executed. The abort is synthesised by the extension's bound kernel port (typed RlmSessionChangedError), never by probing private fields. The abort makes no kernel call, and a later invocation binds to the current session's kernel and runs normally. A session transition never waits for a running cell (no deadlock)",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
  "IP-5": {
    id: "IP-5",
    method: "test",
    description: "RLM Extension api.on('session_start') delivers partitioned artifactsDir to createDefaultKernel",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
} as const;
