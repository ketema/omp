# Reconciliation Manifest: Upstream v18.18.7 -> v18.20.0
**Target**: Upstream `v18.20.0` | **Explicit Base**: `v18.18.7` (`e325ffc73a`) | **Fork Tip**: `reconcile/v18.20.0`
**Method**: Tree adoption of upstream `v18.20.0` plus fork customized paths (PR #45 precedent).

---

## 1. Executive Summary & Blast Radius
- **Upstream commits**: 1,140 commits across 1,063 paths.
- **Fork-customized paths**: 231 paths.
- **Overlapping paths**: Exactly 24 paths.
- **Textual conflicts on 3-way merge (`merge-base=v18.18.7`)**: Exactly 1 path (`packages/coding-agent/src/cli/find-cli.ts`).

---

## 2. Textual Conflict Decision (1 Path)

### `packages/coding-agent/src/cli/find-cli.ts`
- **Fork change**: Imports and invokes `stopRawIoHelper()` in the `finally` block of `runFindCommand` so find commands cleanly stop the in-process raw-IO helper.
- **Upstream change**: Adds `verifyJudge`, `threshold: cfgFindHitThreshold.get(settings)`, and `verifyJudge` lead judge wiring to `runFindCommand`.
- **Decision**: **PRESERVED & ADAPTED**. Retain upstream's new find verification judge and threshold settings while preserving the fork's `stopRawIoHelper()` cleanup in the `finally` block.

---

## 3. Overlapping Path Decisions (23 Paths)

1. **`crates/pi-natives/src/lib.rs`**: **PRESERVED**. Retains export of `held_files` and native modifier exports alongside upstream module additions.
2. **`crates/pi-natives/src/shell.rs`**: **PRESERVED**. Retains askpass environment and native modifier hooks.
3. **`crates/pi-walker/src/grep/run.rs`**: **PRESERVED**. Retains `helper_open` routing for raw-I/O safety on SQLite files.
4. **`packages/coding-agent/src/sdk.ts`**: **PRESERVED**. Retains unconditional `createRlmExtension()` admission (POST-NATIVE-3) and askpass setup.
5. **`packages/coding-agent/src/task/structured-subagent.ts`**: **PRESERVED**. Retains per-call model role alias resolution (`@smol`, `@default`) and candidate array resolution (POST-PCM-ALIAS, POST-PCM-ARRAY).
6. **`packages/coding-agent/src/config/model-resolver.ts`**: **PRESERVED**. Retains `resolveModelOverrideWithAuthFallback` and role resolution logic.
7. **`packages/coding-agent/src/tools/index.ts`**: **PRESERVED**. Retains device-only write transport wiring for read-only sessions (`session.deviceOnlyWrite`).
8. **`packages/coding-agent/src/tools/read.ts`**: **PRESERVED**. Retains raw-I/O helper routing for SQLite-family reads.
9. **`packages/coding-agent/src/tools/write.ts`**: **PRESERVED**. Retains raw-I/O helper routing for SQLite-family writes.
10. **`packages/coding-agent/src/tools/grep.ts`**: **PRESERVED**. Retains raw-I/O helper routing for grep searches.
11. **`packages/coding-agent/src/session/agent-session.ts`**: **PRESERVED**. Retains turnToolCalls event propagation and workbench integration.
12. **`packages/coding-agent/src/session/session-manager.ts`**: **PRESERVED**. Retains custom session directory configuration.
13. **`packages/coding-agent/src/session/session-tools.ts`**: **PRESERVED**. Retains essential native tool registration.
14. **`packages/coding-agent/src/modes/interactive-mode.ts`**: **PRESERVED**. Retains askpass notification hooks.
15. **`packages/coding-agent/src/main.ts`**: **PRESERVED**. Retains CLI bootstrap options.
16. **`packages/coding-agent/src/extensibility/extensions/types.ts`**: **PRESERVED**. Retains tool call extensions.
17. **`packages/tui/src/terminal.ts`**: **PRESERVED**. Retains native modifier detection hooks.
18. **`.github/workflows/ci.yml`**: **PRESERVED**. Retains fork CI runner modes and test filters.
19. **`scripts/ci-test-ts.ts`**: **PRESERVED**. Retains fork test inclusion filters.
20. **`packages/coding-agent/test/task/worktree.test.ts`**: **PRESERVED**. Retains worktree test coverage.
21. **`package.json`**: **PRESERVED & ADAPTED**. Upstream dependencies updated; fork workspaces and scripts retained.
22. **`packages/coding-agent/package.json`**: **PRESERVED & ADAPTED**. Upstream dependencies updated; fork metadata retained.
23. **`bun.lock`**: **ADAPTED**. Regenerated with package manager against merged package manifests.

---

## 4. Fork Customization Registry Coverage (Rows 1–14)
All 14 rows in `requirements/FORK_CUSTOMIZATIONS.md` remain 100% active and preserved:
- Row 1: `packages/rlm` (74 tracked files)
- Row 2: `ipython` tool in binary
- Row 3: `ipython` registered in `extension.ts`
- Row 4: Native SSH Askpass (`~/bin/yubi-askpass`)
- Row 5: Native modifier detection
- Row 6: `.gitignore` kernel-state ignores
- Row 7a/7b: RLM write-path and dill bare-filename rules
- Row 8: Upstream per-call model (`task.perCallModel`) with role aliases and arrays
- Row 9: Shell snapshot function environment
- Row 10: Raw-I/O helper POSIX lock protection
- Row 11: Context-efficiency prompt guardrail
- Row 12: `turnToolCalls` on `ToolCallEvent`
- Row 13: `scripts/verify-fork-customizations.sh`
- Row 14: GitHub Project auto-add workflow
