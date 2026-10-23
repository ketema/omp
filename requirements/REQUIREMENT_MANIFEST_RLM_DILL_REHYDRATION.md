# REQ-2026-RLM-DILL-REHYDRATION-AND-ISOLATION: Global Fix for IPython Dill Rehydration and Session State Isolation

**Status**: Draft
**Scope**: Restore IPython kernel snapshots resiliently without crashing on unpicklable individual variables, exclude shell-injected builtins from serialization, ensure base environment primitives are pre-loaded, partition persistent state per session, and isolate legacy snapshots to an inspectable quarantine directory.

## CCABDD Governance

Human owns: intent (front) + reality judgment (back).
AI owns: enforcement (middle).
Neither crosses the boundary.

Human MUST confirm real-world effect matches intent.
AI MAY NOT infer success from metrics.

## Actors

| Actor | Identifier |
|---|---|
| Kernel Runner | `rlm_kernel_runner.py` |
| Kernel Manager | `KernelManager` in `packages/rlm/src/kernel.ts` |
| RLM Extension | `createRlmExtension` in `packages/rlm/src/extension.ts` |
| Session Manager | `SessionManager` in `packages/coding-agent` |
| Quarantine Inspector | `scripts/quarantine_inspector.py` |
| Operator | Human authority (Ketema) |

## 1. Intent Traceability

- **Source Prose**:
  > "excellent. the dill rehydration problem needs a global fix. execute a ccabdd cycle starting with req-elicit with the goal of ensuring that ipython can be restored in any and all new sessions without fail. there should be no mixture of state."
  > "reflection is accurate. z1 - A. z2 - A and B. we have to account for all the existing dill files that need to be bypassed. I am curious about whether we should clear them out or try to isolate and examine so we can potentially recover anything useful you may have created."
  > "alt9-write-classifier just needs to be deleted. do not try to restore it. incorporate your other 2 fixes as requirements in the manifest along with the structural fix. the requirements should NOT specify HOW just the WHAT."

- **Our Understanding**: A permanent, global architectural fix to the persistent IPython kernel re-hydration and state isolation model:
  1. Snapshot restore in any session skips unpicklable variables, reports them in telemetry, and restores all valid variables into the active namespace.
  2. Shell-injected builtins are excluded from user variable snapshot persistence.
  3. Interactive environment and standard library primitives are available in the base kernel environment upon bootstrap.
  4. Persistent kernel state is strictly partitioned by session identity so that fresh sessions start with clean state.
  5. Existing legacy snapshots across workspaces are isolated into a quarantine directory for non-destructive inspection and recovery, while unresolvable legacy artifacts are purged.

- **Ambiguity Score**: 0

## 2. The Actor Matrix

| Actor | Permission Level | Prohibited Actions |
|:------|:-----------------|:-------------------|
| Kernel Runner | Deserializes snapshots, filters names, and injects valid variables into user namespace | Kernel Runner SHALL NOT terminate snapshot restore due to a single unpicklable variable. |
| Kernel Manager | Sends snapshot operations and manages kernel lifecycle | Kernel Manager SHALL NOT inspect raw dill bytes directly. |
| RLM Extension | Binds session lifecycle to kernel transport | RLM Extension SHALL NOT reuse a shared unpartitioned artifact directory across independent sessions. |
| Session Manager | Manages session directories and persistence | Session Manager SHALL NOT route fresh unlinked sessions to stale artifact stores. |
| Quarantine Inspector | Inspects and extracts variables from legacy snapshots | Quarantine Inspector SHALL NOT overwrite active session state with quarantined legacy artifacts. |
| Operator | Holds final acceptance and phase completion authority | Operator SHALL NOT bypass machine-gated state transitions. |

## 3. The State Transition

- **Initial State ($S_0$)**: Kernel Runner halts execution on unresolvable variables via `CorruptSnapshotError` and serializes interactive builtins into user snapshots while RLM Extension routes unlinked sessions to a shared artifact directory.
- **Transformation**: Kernel Runner executes per-variable isolated unpickling with failure skipping and manifest reporting, filters shell builtins from serialization, and pre-loads standard primitives. Session Manager partitions kernel artifacts by session ID. RLM Extension isolates legacy artifacts to a quarantine archive with non-destructive inspection.
- **Terminal State ($S_1$)**: Kernel Runner restores snapshots deterministically in any session regardless of broken variables, omits shell builtins from persistence, and RLM Extension starts fresh sessions with completely clean isolated state while Quarantine Inspector preserves legacy variables in quarantine.

## 3.5 Integration Specification

### Dependency Graph
- Kernel Runner DEPENDS ON dill for per-variable serialization and deserialization.
- Kernel Manager DEPENDS ON Kernel Runner (over transport stdio JSON-RPC) for `snapshot_write` and `snapshot_restore` operations.
- RLM Extension DEPENDS ON Session Manager for per-session `artifactsDir` isolation.
- Quarantine Inspector DEPENDS ON Kernel Runner snapshot format parser for non-destructive inspection.

### Control Flow Requirements (Sequencing Specs)
| ID | Caller | Must Invoke | Temporal Constraint | Breaks If Missing |
|----|--------|-------------|---------------------|-------------------|
| SEQ-1 | `KernelRunner._snapshot_restore` | `dill.loads(blob)` | DURING loop over container variables | Cannot unpack individual variables |
| SEQ-2 | `KernelRunner._snapshot_restore` | `skipped_restores.append` | UPON `dill.loads` exception for any variable | Fails fast and breaks entire kernel restore |
| SEQ-3 | `KernelRunner._snapshot_restore` | `user_ns.update(temp_restored)` | AFTER all unpackable variables succeed AND only with valid variables | Pollutes namespace or aborts valid state |
| SEQ-4 | `KernelRunner._snapshot_restore` | `_emit({"type": "result", "restoredNames": ..., "skipped": ...})` | AFTER namespace update | Host never learns which variables were skipped |
| SEQ-5 | `KernelRunner._snapshot_names` | `filter_non_user_builtins` | BEFORE `dill.dumps` during snapshot creation | Shell-injected wrappers saved into user snapshot |
| SEQ-6 | `KernelRunner._bootstrap` | `load_base_primitives` | BEFORE user cell execution or snapshot restore | Standard interactive types unresolvable during restore |
| SEQ-7 | `RlmExtension.api.on("session_start")` | `resolveArtifactsDir(sessionEvent)` | BEFORE `ensureKernel()` or `restoreSnapshot()` | Kernel loads from wrong/shared session directory |
| SEQ-8 | `RlmExtension.api.on("session_start")` | `quarantineLegacyRootArtifacts(legacyDir, archiveDir)` | BEFORE kernel initialization in legacy CWDs | Stale unpartitioned snapshots bleed into fresh session |

### Integration Points Checklist
| ID | Source | Target | Handoff Data | Contract Clause |
|----|--------|--------|-------------|-----------------|
| IP-1 | Kernel Runner `_snapshot_restore` | Python runtime `user_ns` | `temp_restored` dict of clean unpickled variables | POST-RESTORE-SKIP-1 |
| IP-2 | Kernel Runner `_snapshot_restore` | Kernel Manager `onResult` | Restored names list plus skipped variables list | POST-RESTORE-TELEMETRY-1 |
| IP-3 | Kernel Runner `_snapshot_names` | Kernel Runner `_snapshot_write` | Filtered list of user variable names | POST-NAME-FILTER-1 |
| IP-4 | Kernel Runner `_bootstrap` | Python runtime `sys.modules` | Base interactive and standard library primitives | POST-BOOTSTRAP-PRIMITIVES-1 |
| IP-5 | RLM Extension `api.on("session_start")` | Kernel Transport `createTransport` | Partitioned `artifactsDir` keyed by session ID | POST-SESSION-ISOLATION-1 |
| IP-6 | Quarantine Inspector `inspect_file` | Operator output | Summary of recoverable versus unpicklable variables | POST-QUARANTINE-INSPECT-1 |

### Lifecycle Paths
| Component | INIT (created/started by) | CLEANUP (stopped/released by) |
|-----------|--------------------------|-------------------------------|
| Kernel Runner | Managed venv interpreter spawned by `createTransport` | Terminated by `transport.kill()` on session shutdown |
| Kernel Manager | Created by `createDefaultKernel` on session start | Disposed by `kernel.dispose()` on session shutdown |
| Session Artifacts | Created by `SessionManager` in session-specific directory | Retained per session data-retention policy |

## 4. Hard Invariants (The "Never" List)

| ID | Category | Invariant |
|----|----------|-----------|
| REQ-RLM-REHYDRATE-001 | Resilience | Kernel Runner SHALL NOT terminate snapshot restore due to a deserialization failure of an individual variable. |
| REQ-RLM-REHYDRATE-002 | Namespace Purity | Kernel Runner SHALL populate `user_ns` only after validating all container items. |
| REQ-RLM-REHYDRATE-003 | State Isolation | RLM Extension SHALL NOT load or restore `kernel-state.dill` from a different session in a new unlinked session. |
| REQ-RLM-REHYDRATE-004 | Quarantine | RLM Extension SHALL NOT delete existing legacy `.dill` files without first archiving them to a recoverable quarantine path. |
| REQ-RLM-REHYDRATE-005 | Environment | Kernel Runner SHALL NOT depend on ephemeral working directories to resolve module imports during restore. |
| REQ-RLM-REHYDRATE-006 | Telemetry | Kernel Runner SHALL report skipped unpicklable variable names and error types in the restore result frame. |
| REQ-RLM-REHYDRATE-007 | Builtin Exclusion | Kernel Runner SHALL NOT include interactive shell builtins or runtime wrappers in user snapshot variables. |
| REQ-RLM-REHYDRATE-008 | Base Primitives | Kernel Runner SHALL initialize base interactive and standard library module references upon bootstrap. |

## 5. High-Entropy Zones (Adjudicated)

| Zone | Question | Resolution | Decided By |
|------|----------|------------|------------|
| Zone 1: Unpickling Failure Handling | Which restore policy applies to individual unpickling errors? | Option A: Skip failing variables, record them in manifest/telemetry, and restore all valid variables into `user_ns`. | User (Ketema) |
| Zone 2: Session State Isolation | Which strategy applies to session state isolation and legacy snapshots? | Option A and B: Partition artifacts by session ID and isolate existing legacy snapshots into a quarantine directory for inspection and recovery. | User (Ketema) |
| Zone 3: Shell Builtin Filtration | Which names qualify for snapshot exclusion? | Shell-injected builtins and wrappers (including `open`) are excluded from user variable serialization. | User (Ketema) |
| Zone 4: Base Environment Availability | Which primitives must exist at bootstrap? | Standard interactive display and data primitives are pre-loaded during kernel bootstrap. | User (Ketema) |

## 5.5 Rejected Alternatives

| Decision | Alternative Considered | Why Rejected | Decided By |
|----------|----------------------|--------------|------------|
| Skip-and-report unpickling failures | Abort entire restore with `CorruptSnapshotError` | Causes catastrophic kernel failure when a single historical variable loses its module path. | User (Ketema) |
| Quarantine and inspect legacy dill files | Immediately delete all legacy dill files | Destroys potentially valuable in-memory structures and user-created data. | User (Ketema) |
| Session-UUID partitioned artifact directories | Single shared `.omp/artifacts` per workspace | Causes silent state bleed between successive sessions in the same directory. | User (Ketema) |
| Filter shell builtins at snapshot source | Attempt to unpickle shell wrappers in subsequent processes | Shell wrappers hold process-specific closures that cannot be deserialized cleanly across processes. | User (Ketema) |

## 6. Tool/API Interface Summary

| Interface | Purpose | Mutates State? | Called By | Triggered When |
|-----------|---------|----------------|----------|----------------|
| `_snapshot_restore(path, manifest_path)` | Restores valid variables and reports skipped | YES | Kernel Runner `_handle_op` | Host sends `snapshot_restore` op |
| `_snapshot_names()` | Returns filtered user variable names | NO | Kernel Runner `_snapshot_write` | Snapshot write initiated |
| `_bootstrap()` | Loads base primitives and freezes codec | YES | Kernel Runner `_handle_op` | Host sends `bootstrap` op |
| `restoreSnapshot()` | Sends restore op and awaits result | NO | Kernel Manager `ensureStarted` | Kernel boots with snapshot present |
| `quarantine_legacy_dill(target_dir)` | Isolates unpartitioned legacy snapshots | YES | RLM Extension bootstrap | Legacy snapshot detected in unpartitioned root |

## 7. Failure Mode Specification

| Requirement | Failure Condition | Behavior | Notification |
|------------|-------------------|----------|--------------|
| REQ-RLM-REHYDRATE-001 | Variable blob in snapshot fails `dill.loads` | Kernel Runner SHALL skip the failing variable and continue restoring remaining variables. | Manifest telemetry and revival notice include skipped variable names and errors. |
| REQ-RLM-REHYDRATE-002 | Entire snapshot file is 0 bytes or has invalid compression magic | Kernel Runner SHALL raise `CorruptSnapshotError` with actionable header diagnostics. | Kernel Runner SHALL emit an error frame to host; host logs warning and starts kernel clean. |
| REQ-RLM-REHYDRATE-003 | Session ID missing or invalid | RLM Extension SHALL fallback to a dedicated isolated timestamped directory. | RLM Extension SHALL log a directory resolution warning. |
| REQ-RLM-REHYDRATE-007 | Shell builtin detected in namespace | Kernel Runner SHALL omit the builtin name from serialization without error. | Manifest telemetry records excluded builtin count. |

## 8. Completion Promise (Ralph Loop Exit)

Kernel Runner restores all valid variables into `user_ns` with 100% fidelity, records unpicklable variables in telemetry, excludes shell builtins from persistence, and leaves the IPython kernel fully operational when restoring a snapshot containing corrupted blobs, missing modules, and valid variables. RLM Extension starts fresh sessions with zero state bleed and catalogues legacy snapshots in quarantine.

## 9. Contract Authority

Authoritative Source: `packages/rlm/python/rlm_dill_resilient_restore_contract.py` and `contracts/rlm-session-isolation.contract.ts`

## 10. Revision History

| Date | Author | Change |
|------|--------|--------|
| 2026-10-23 | Ketema Harris & Claude | Initial requirement manifest for global dill rehydration, builtin filtering, and session isolation fix |
