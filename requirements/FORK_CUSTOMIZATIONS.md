# Fork Customizations — MUST SURVIVE EVERY UPSTREAM RECONCILE

`ketema/omp`, forked from `can1357/oh-my-pi`.

This file is the **preservation checklist**. Every upstream reconcile MUST verify
each row below is present in the resulting build before that build is promoted.
`docs/RECONCILIATION_MANIFEST.md` holds the per-commit group assignments; this
file holds the *survivability contract* those groups exist to protect.

> **Why this file exists**: the 2026-10-14 reconcile replayed group
> G08-IPYTHON-PROMPT as documentation only. The requirements and contract text
> landed; the two `TOOL_DESCRIPTION` lines they describe did not. Tests passed,
> docs looked complete, and the guardrail was invisible to the model at runtime
> for the life of that build. A group is not "replayed" because its docs landed.

## Verification rule

A customization is preserved only when **all four** hold:

1. **Artifact present** — the file/symbol exists in the build tree.
2. **Reachable at runtime** — it is on the surface that actually executes or
   that the model actually reads, not merely described in `requirements/`.
3. **Pinned by a test** — a test fails if it is removed.
4. **Effective in the deployed environment** — the check in
   `scripts/verify-fork-customizations.sh` passes against the *deployed binary*
   and the *real launcher wrapper*, not just the source tree. Code can be
   present, reachable and tested while something outside the fork (the launcher,
   shell config) pre-empts it.

Docs-only presence is **NOT** preservation. Row 7 is the standing counterexample
for rule 2. Row 4 is the standing counterexample for rule 4: on 2026-10-26 the
askpass code survived the reconcile and its tests passed, but the `myomp`
wrapper exported a generic askpass first, so YubiKey PIN/touch prompts had no
sound for a build's lifetime.

## Preservation checklist

| # | Group | What must survive | Verify by |
|---|---|---|---|
| 1 | G01-RLM-IPYTHON | `packages/rlm` subsystem: kernel, transports, snapshots/compression, ledger, recursion, safety, 4 ported engines, `rlm-runtime` Python package | `git ls-files packages/rlm` >= 43 files; `bun test packages/rlm` |
| 2 | G01 (tool) | The `ipython` tool itself: `TOOL_NAME = "ipython"` in `packages/rlm/src/tool.ts`, registered in `packages/rlm/src/extension.ts` | tool appears in the live device inventory; `tool_alignment.test.ts` |
| 3 | G01 (pinning) | `ipython` pinned as an essential, top-level native tool | native-tool pinning tests |
| 4 | G02-SSH-ASKPASS | `YUBI_ASKPASS_PATH`, `SSH_ASKPASS_DISPLAY_VALUE`, `NATIVE_ASKPASS_ENVIRONMENT` in `packages/coding-agent/src/exec/non-interactive-env.ts`. omp honours a usable parent `SSH_ASKPASS` first and otherwise falls back to a generic `ssh-askpass` on PATH. `YUBI_ASKPASS_PATH` is **defined but not yet used** by the resolver, so the YubiKey beep and PIN/touch cue depend on the launcher wrapper exporting `~/bin/yubi-askpass` (see "Out-of-tree files" below) | `non-interactive-env.test.ts`; `scripts/verify-fork-customizations.sh` row 4 and `--live` |
| 5 | G03-NATIVE-MODIFIERS | `packages/tui/src/native-modifiers.ts` + `native-modifiers-internal.ts`: macOS CoreGraphics modifier recovery, Shift+Enter before paste classification | `native-modifier-detection.test.ts` |
| 6 | G04-HYGIENE-DOCS | `.gitignore` entries for `kernel-state.*` and local agent runtime artifacts | `grep kernel-state .gitignore` |
| 7 | G08-IPYTHON-PROMPT | **Two lines inside `TOOL_DESCRIPTION`** (`packages/rlm/src/tool.ts`): the literal/statically-inspectable write-path rule, and the `dill.dump_session` bare-filename rule. Origin `d77c5e1f1d`. **Lost in the 2026-10-14 reconcile; restored by `dbe99396e8`.** | `bun test packages/rlm/tests/tool.spec.ts -t "F-269"` |
| 8 | G07-PINNED-SPAWN (spawn half) | Per-spawn `model` on subagent dispatch: `if ("model" in item) spawn.model = item.model` in `packages/coding-agent/src/task/index.ts`. Omitting `model` falls back to on-disk config | `spawn-model.test.ts`, `vibe/spawn-model-role.test.ts` |
| 9 | G11-SHELL-ENV-PARITY | `packages/coding-agent/src/utils/shell-snapshot-fn-env.sh` and session shell-env parity | `extension-session-shell-env.test.ts` |

### Deliberately NOT carried

| Group | Disposition |
|---|---|
| G07-PINNED-SPAWN (**pinned dock half**) | **Intentionally dropped.** The pinned TUI prompt input box (`packages/tui/src/pinned-viewport.ts`, `contracts/pinned_dock.contract.ts`, `plans/pinned-dock-refactor.plan.yml`, and 6 further artifacts) is not carried forward. Do not re-replay without an explicit decision. The **spawn-model half of G07 is separate and MUST survive** — see row 8. |
| G05-UPSTREAM-SYNC-MARKERS, G06-FORK-MERGES | Historical topology/markers; superseded, dropped by disposition. |
| G13-OLD-PROMPT, G14-OLD-PINNED-TIPS, G15-ORIGIN-UPSTREAM | Superseded or already upstream. |
| `packages/coding-agent/src/utils/git.ts` | **Not ours to keep.** Upstream removed it in `2a7db5855d` (pi-vcs crate unifying Git and Jujutsu). A prior replay resurrected it by accident; `148c11294a` correctly deleted it again. Its absence is *correct*, not a regression. |

## Post-reconcile audit procedure

Run before promoting any reconcile build:

```sh
BUILD=<reconcile worktree>
cd "$BUILD"

# Rows 1-3, 7: RLM subsystem + ipython tool + prompt guardrails
bun test packages/rlm

# Row 7 specifically — the regression this file was written for
bun test packages/rlm/tests/tool.spec.ts -t "F-269"

# Row 8: per-spawn model selector
bun test packages/coding-agent/test/spawn-model.test.ts

# Rows 4, 5, 9
bun test packages/coding-agent/test/non-interactive-env.test.ts
bun test packages/tui/test/native-modifier-detection.test.ts
bun test packages/coding-agent/test/extension-session-shell-env.test.ts

# Row 6
grep -q 'kernel-state' .gitignore && echo "gitignore OK"
```

Then confirm **reachability**, which tests alone do not prove: the `ipython` tool
is present in the live device inventory, and its description text actually
contains the row-7 guardrails as delivered to the model.

### Deployed-build acceptance (rule 4)

```sh
# Fast, deterministic: build contents, binary strings, wrapper logic. No network.
scripts/verify-fork-customizations.sh --binary <deployed omp> --wrapper ~/bin/myomp

# Add the bun tests the checklist names, and one end-to-end model call that
# reads the SSH_ASKPASS a tool subprocess actually receives.
scripts/verify-fork-customizations.sh --binary <deployed omp> --tests --live
```

Exit 0 only if every check passes; a check that cannot run fails. Do not report
"customizations preserved" without this output for the build being promoted.
When a row changes, update its check in the script in the same change.

## Out-of-tree files that interact with the fork

These live outside this repository (in `ketema/HomeDirectory` and the home
directory) but change what the fork's behaviour amounts to at runtime. A
reconcile or deploy must confirm each still does its part.

| File | Must do | Checked by |
|---|---|---|
| `~/bin/myomp` | Export `SSH_ASKPASS=$HOME/bin/yubi-askpass` before launching omp (first branch; warn on stderr if falling back) | script row 4, `--live` |
| `~/bin/yubi-askpass` | Be executable; beep and notify on touch, beep and raise the PIN and host-key dialogs | script row 4 |
| `~/.omp/agent/config.yml` | Model roles and fallback chains point at providers that still exist | manual review after provider changes |
| `~/.ssh/config` + `~/bin/forwarded-agent-heal` + `~/bin/presence-check` | GitHub auth picks the YubiKey at the desk or the forwarded agent on the phone without hanging | `ssh -G github.com`, `presence-check --explain` |

## Follow-ups (not done)

- Make the resolver use `YUBI_ASKPASS_PATH` as a real fallback so omp does not
  depend on the wrapper for the cue. This is a source change with its own tests.

## Known environment coupling (not code, do not "fix")

- `~/.omp/agent/config.yml` `disabledProviders` intentionally excludes `claude`,
  `codex`, `cursor`, `gemini`, and others. The Python hook suite under
  `~/.claude/hooks/` is run by the Claude Code harness, not by OMP. This
  separation is deliberate.
- The `dist/omp` binary is signed with a Developer ID but **not notarized**.
  That is correct: it is local-only and moves between machines over git/SSH,
  which never sets `com.apple.quarantine`.
