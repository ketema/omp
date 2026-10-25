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
  "POST-SESSION-NO-SIDE-EFFECT-1": {
    id: "POST-SESSION-NO-SIDE-EFFECT-1",
    method: "test",
    description: "Timing refinement of POST-SESSION-NO-OWNED-DIR-ISOLATION-1 / POST-SESSION-FALLBACK-ISOLATION-1; the isolation guarantee is unchanged (nothing restored, no shared directory, no other session's files). A lifecycle event (session_start, session_switch, session_branch) for a session with no owned artifacts directory creates NO filesystem entry and sends NO message into the host transcript: the host loads this extension in every unrestricted session, including in-memory ones that never use ipython. The fallback isolated directory is allocated, and its single rlm-warning emitted, only when a kernel is first constructed for that session - exactly once per session, not once per cell. A session that never constructs a kernel leaves the host transcript and filesystem untouched",
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
  "POST-CI-RLM-SELECTION-1": {
    id: "POST-CI-RLM-SELECTION-1",
    method: "test",
    description: "The repo's test-selection script (scripts/ci-test-ts.ts) dispatches mode 'rlm' to exactly one command: `bun test` in packages/rlm with NO file filter, name filter or exclusion, so every spec under packages/rlm/tests - including the real-SessionManager/native-backed, default-path and atomicity specs - is selected; mode 'rlm-python' dispatches to the Python recovery/quarantine suite through the pinned rlm-runtime uv project with `--locked` (lock drift fails) and its dependency group, never an unpinned or host-global interpreter; modes 'workspace' and 'native' select exactly the packages they selected before (no broadening, none dropped); 'all' and 'local-ts' additionally select the rlm TS command. Verified by running the script's real --dry-run dispatch, not by matching config strings",
    requirement_ids: ["REQ-RLM-REHYDRATE-001", "REQ-RLM-REHYDRATE-003"],
  },
  "POST-CI-RLM-EXECUTION-1": {
    id: "POST-CI-RLM-EXECUTION-1",
    method: "execution",
    description: "The GitHub Actions run for the PR head contains a dedicated, visibly named job (needs native_addons; real linux-x64 native artifacts via the existing native-artifacts action) that runs, each to completion: the selection/dispatch test, the full packages/rlm TS suite, and the Python recovery/quarantine suite in an isolated pinned uv environment. Evidence is the actual job log and API result: non-zero executed counts, zero skipped, zero failed, and the real-SessionManager spec files executed rather than failing to load. A missing prerequisite (uv, native addon, interpreter) is a failure, never a skip. The job adds no secrets, no token scope beyond the workflow's `contents: read`, and no deploy/publish trigger; the runner strips credentials from test processes",
    requirement_ids: ["REQ-RLM-REHYDRATE-001", "REQ-RLM-REHYDRATE-003"],
  },
  "POST-CI-NATIVE-ABI-1": {
    id: "POST-CI-NATIVE-ABI-1",
    method: "execution",
    description: "When a PR run has no main-built native addon cache and falls back to a published npm addon, the fallback is the release whose version equals packages/natives/package.json of the tree under test - never `latest`. A `latest` addon can carry a different ABI than the source (observed: 18.12.6 requires EditPolicy.maxColumns and a 4th encodeSixelAsync backgroundRgb argument; this tree, at 18.11.0, supplies neither), turning every native-backed job red for reasons that are not defects of the PR. A version with no published tarball MUST fail the step (fail-fast), never fall through to another version. Evidence is the real job log: the fetch step prints the pinned version, and the previously failing `Missing field maxColumns` / `Undefined into rust type u32` clusters no longer fail. The change adds no secrets, no token scope, no deploy trigger, and removes no test",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
  "POST-SESSION-TRANSITION-GEN-1": {
    id: "POST-SESSION-TRANSITION-GEN-1",
    method: "test",
    description: "Each lifecycle transition (session_start, session_switch, session_branch) takes a monotonically increasing generation at entry. A transition publishes its resolved artifacts directory, and may revive state, ONLY if it is still the latest generation when its resolution settles. If a newer transition began while an older one (B) was still resolving, B's completion - however late - neither replaces the newer session's directory nor restores into it nor sends a revival notice; the newer transition's directory is the one a later kernel is built against. Covers Copilot comments 4370059188 and its duplicate 4369992551 (same defect: stale B overwrites C's directory; same generation-token remedy; same slow-B/fast-C regression test)",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
  "POST-SESSION-SHUTDOWN-RACE-1": {
    id: "POST-SESSION-SHUTDOWN-RACE-1",
    method: "test",
    description: "session_shutdown invalidates every in-flight transition: a directory resolution still pending at shutdown never constructs or starts a kernel once it settles (no leaked Python process), however late it settles. Shutdown itself does NOT wait for a pending resolution (a stuck host resolution must not deadlock shutdown); it still waits for an in-flight kernel construction, then disposes the current kernel",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
  "ERRORS-SESSION-RESOLUTION-FAILED-1": {
    id: "ERRORS-SESSION-RESOLUTION-FAILED-1",
    method: "test",
    description: "When resolving the incoming session's artifacts directory rejects, the outgoing session's directory is never reused: the extension forgets it before resolving, the error still propagates to the host (not swallowed), and the next kernel use allocates a fresh isolated directory with its single observable rlm-warning. Fail closed, never fail open onto the previous session's state",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
  "POST-KM-START-SINGLEFLIGHT-1": {
    id: "POST-KM-START-SINGLEFLIGHT-1",
    method: "test",
    description: "KernelManager.ensureStarted is single-flight: concurrent callers (a tool invocation and a revival, say) share ONE start - the transport is started, restored and bootstrapped exactly once, never twice - and all of them settle together. If that start fails every concurrent caller rejects with the same readiness error and a later call may start afresh. Covers Copilot comment 4369992537",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
  "POST-SESSION-PREFLUSH-BOUNDED-1": {
    id: "POST-SESSION-PREFLUSH-BOUNDED-1",
    method: "test",
    description: "Refines POST-SESSION-PREFLUSH-1: KernelManager.flushSnapshot settles within SNAPSHOT_DISPOSE_TIMEOUT_MS even if the kernel or serializer hangs, rejecting with the typed SnapshotFlushTimeoutError (the extension already surfaces any rejection as an observable rlm-warning and the transition proceeds). Snapshot work abandoned by that timeout never commits afterwards: it writes neither the payload nor the manifest into the artifacts directory, so it cannot race the host's artifact copy of the same directory. Covers Copilot comments 4369849292, 4370038281 and 4369909562",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
  "POST-CI-RLM-NOSKIP-1": {
    id: "POST-CI-RLM-NOSKIP-1",
    method: "test",
    description: "Refines POST-CI-RLM-SELECTION-1: the rlm TS command fails when Bun's OWN run summary reports any skipped or todo test. The judgement is made from the actual runner output, not from spec source text, so computed or aliased skips (`test['skip'](...)`, `const t = test; t.skip(...)`) are caught and harmless comments mentioning skip are not flagged. The rule is a pure function over Bun's summary (`skippedOrTodoCount`), verified against real Bun output for a fixture containing aliased skip and todo tests and for a clean fixture; the script's dry-run plan marks the rlm command as skip-gated and no other command. Covers Copilot comment 4370304315",
    requirement_ids: ["REQ-RLM-REHYDRATE-001", "REQ-RLM-REHYDRATE-003"],
  },
  "POST-KM-NO-RESURRECT-1": {
    id: "POST-KM-NO-RESURRECT-1",
    method: "test",
    description: "KernelManager never re-creates an artifacts directory that existed (it was present at construction or a snapshot already wrote into it) and has since been removed by the host - for example the host's /delete drops the session's artifacts BEFORE the switch that disposes its kernel. A dispose-time, flush or debounced snapshot into a removed directory is skipped: no directory, temp directory, payload or manifest is created, and teardown still completes. The check is made again immediately before every filesystem write of a snapshot, not only when it is requested: a directory removed while the kernel is still serializing (snapshotNames / writeSnapshot pending) is never re-created when that work settles, and a snapshot abandoned by the flush timeout never creates a directory or staging area at all. A directory that never existed (a fresh session's first snapshot) is still created as before. Covers Copilot comment 4370059184 and the parent review of 5fa85b0",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
  "POST-KM-SNAPSHOT-SERIAL-1": {
    id: "POST-KM-SNAPSHOT-SERIAL-1",
    method: "test",
    description: "Snapshots run through the same serialization chain as cells: a snapshot's side effects (snapshotNames, writeSnapshot, any staging or artifact write) do not START until every earlier chain entry - an active cell included - has settled, whether that entry fulfilled or rejected. A flush requested while a cell runs queues behind it and touches the kernel namespace only afterwards",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
  "POST-KM-SNAPSHOT-PAIR-1": {
    id: "POST-KM-SNAPSHOT-PAIR-1",
    method: "test",
    description: "A snapshot commits its payload and manifest as one generation. Every asynchronous preparation step (names, serialization, the kernel's Python version, payload staging) completes BEFORE either artifact is replaced, and the commit itself is synchronous with a rollback: if the commit cannot complete, or the snapshot was abandoned or its directory removed while preparing, the previously committed payload and manifest are left exactly as they were - never a new payload beside an old manifest, and never the reverse",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
  "POST-STAGE-1": {
    id: "POST-STAGE-1",
    method: "test",
    description: "Refines POST-KM-NO-RESURRECT-1 and POST-KM-SNAPSHOT-PAIR-1 for the REAL provider (RlmTransport and the Python runner), not only a fake. Every byte the runner writes for a snapshot goes into an owned staging directory OUTSIDE the live artifacts directory: a same-filesystem sibling of it (`<parent>/.rlm-snapshot-stage-<unique>`), created mode 0700, its files mode 0600, and the live directory (or any ancestor) is never created, written or modified by the runner. KernelManager is the single commit authority: it moves the staged payload into the live directory only after its own removal and abandonment checks, so a live directory removed while the runner serializes stays absent, a snapshot abandoned by the flush timeout leaves the previously committed payload and manifest byte-identical when the runner finally finishes, and a failing stage never reaches the live pair. Only stages the transport itself created are removed - when the snapshot commits, is abandoned, fails, or the transport is disposed. Evidence is the real runner (a slow __reduce__ keeps it inside serialization while the host removes the directory or the flush times out), never a fake transport. Covers audit findings 7 and 13 of f5611865",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
  "POST-SESSION-MOVE-1": {
    id: "POST-SESSION-MOVE-1",
    method: "test",
    description: "When the host relocates the active session - the explicit /move, or a persistence move-off that re-keys the session to a new session file with a background artifact copy - it emits the existing lifecycle events with reason 'move' (session_before_switch before an explicit /move so the live kernel flushes into the directory that is about to move; session_switch after). The extension resolves the session's NEW owned directory after the host's artifact copy settles and moves the live kernel there as POST-SESSION-MOVE-3 specifies, so a live kernel never keeps writing to the old directory. Covers Copilot comments 4370059196 and 4369909544",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
  "POST-SESSION-MOVE-2": {
    id: "POST-SESSION-MOVE-2",
    method: "test",
    description: "Refines POST-SESSION-MOVE-1 for the live namespace. On a 'move' transition the outgoing kernel's final snapshot is written to the session's NEW owned directory, and only after the host's background artifact copy into it has settled - never into the superseded directory (a persistence move-off leaves that directory with the process that wrote the original session, and the host copy may already have finished before this kernel flushed). The session restored in the new directory therefore carries state executed after the last idle snapshot (marker2), not the older copied one (marker1), and the superseded directory is left exactly as it was. A transition superseded by a newer one (repeated persistence notices) neither disposes nor snapshots: the newest transition owns the kernel and its directory. If the new directory cannot be resolved the outgoing kernel falls back to the ordinary dispose and the error propagates. Covers the parent review of 6672c6a (persistence move-off ordering)",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
  "POST-SESSION-MOVE-3": {
    id: "POST-SESSION-MOVE-3",
    method: "test",
    description: "Refines POST-SESSION-MOVE-1 and POST-SESSION-MOVE-2: a 'move' relocates the SAME logical session, so its live kernel is retargeted, not replaced. After the host's artifact copy into the new owned directory has settled, the extension retargets the live kernel (manager and provider) to that directory and flushes the live namespace there; it never disposes the kernel, never starts a replacement, and never restores over the live namespace. Consequently (a) state executed since the last idle snapshot is kept by the very process that executed it, (b) a cell running when the move lands finishes on that same kernel and returns its own result, not an abort, (c) the transition itself never waits for that cell: the flush is serialized behind it and bounded by SNAPSHOT_DISPOSE_TIMEOUT_MS, and a flush abandoned at the bound is surfaced as an observable warning while later snapshots still land in the new directory, (d) the superseded directory is never written again, and (e) shutdown and new-session transitions keep their existing bounds. A transition superseded by a newer one retargets nothing. If the new directory cannot be resolved the kernel falls back to the ordinary dispose and the error propagates. When no kernel is live at the move (none was started yet) there is nothing to retarget: the ordinary start applies and restores from the new owned directory when it holds a snapshot. When the session owns no directory after the move, the live kernel is disposed and the session starts fresh and isolated. Other reasons (new, resume, fork, branch) still dispose the outgoing kernel. Decided By: the human directive to preserve state and bounded shutdown on same-logical-session relocation; the per-session working directory of the kernel is not a promise this contract makes (the kernel is spawned with the process cwd)",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
  "IP-5": {
    id: "IP-5",
    method: "test",
    description: "RLM Extension api.on('session_start') delivers partitioned artifactsDir to createDefaultKernel",
    requirement_ids: ["REQ-RLM-REHYDRATE-003"],
  },
} as const;
