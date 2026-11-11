# REQ-2026-RECON-18187: Reconcile ketema/omp onto upstream v18.18.7 without losing any customization

Retroactive. Written 2026-11-11, after the work shipped (issue ketema/omp#70; PRs #74 and #75; HomeDirectory PR #844). The audit of that work needs requirement IDs to bind to and none were written first. Nothing here is new intent: every row transcribes something Ketema said, with its source. Ketema has not yet approved this document.

## CCABDD Governance

Human owns: intent (front) + reality judgment (back).
AI owns: enforcement (middle).
Neither crosses the boundary.

Human confirms whether real-world effect matches intent.
AI never infers success from metrics.

Rule 3: No discretion. No judgment. Only state.
No contract executes unless all predicates evaluate to TRUE.

## Definitions

| Term | Meaning |
|:-----|:--------|
| Fork | ketema/omp |
| Upstream | can1357/oh-my-pi |
| Explicit Base | Tag `v18.13.0`, the last upstream release the fork's tree equalled. Git's default merge base is 2026-08-19 and reports 2,234 meaningless conflicts. |
| Adopted Tree | The tree of signed commit `dedca4bb7e`: upstream tag `v18.18.7` plus the fork-customized paths (223 paths differ from the tag). |
| Registry | `requirements/FORK_CUSTOMIZATIONS.md`, rows 1 to 14. |
| Raw-I/O Helper | The helper of registry row 10: `crates/pi-vfs/src/helper.rs`, `packages/coding-agent/src/tools/raw-io-*.ts`, `contracts/raw_io_helper.contract.{py,ts}`. |
| Baseline | The pristine `v18.18.7` tree built and tested the same way as the Adopted Tree. |
| Fork-Owned Delta | `git diff --name-only 5280099794 5ac31fdae1` intersected with `git diff --name-only v18.18.7 5ac31fdae1`: the 56 fork-owned paths this reconcile touched. |

## Assumptions

- Fork `main` before the work was `5280099794` (PR #69). Upstream was at `v18.18.7` (`e325ffc73a`), published 2026-11-10.
- A fast-forward was impossible; a 3-way merge on the Explicit Base gave 41 conflicting paths.
- The earlier reconcile (PR #45, v18.11.0 to v18.13.0) adopted upstream's tree plus the fork's customized paths and is the precedent for the method.
- `origin/main` requires signed commits, and upstream history is unsigned; the result therefore reaches `main` as one signed commit descended from `origin/main`.
- Upstream fixed the SQLite lock loss independently (can1357/oh-my-pi#15586, PR #17833, Linux-only open-file-description locks). The 15586 manifest (Z8) says this is adopted through the standard upstream merge.

## Actors

| Actor | Identifier |
|:------|:-----------|
| Ketema | `ketema` |
| Claude | `claude` |
| Operator | `operator` |
| Fork | `fork` |
| Independent Auditor | `auditor` |
| omp | `omp` |
| Raw-I/O Helper | `raw_io_helper` |
| Launcher | `launcher` |

## 1. Intent Traceability

- **Source Prose**:
  > "Task: bring the ketema/omp fork up to upstream v18.18.7 without losing any customization" (`/tmp/reconcile-v18.18.7-prompt.md`, Ketema)
  >
  > "Every registry row 1 to 14 survives. `sh scripts/verify-fork-customizations.sh --binary <candidate> --wrapper ~/bin/myomp --tests --live` exits 0. The script checks rows 1 to 9 only; run rows 10 to 14 "verify by" by hand and paste the output. Never say "preserved" without that output."
  >
  > "The context-efficiency enforcement extension stays intentionally unmounted. The pinned dock stays dropped. Do not re-add either."
  >
  > "Work in a `wt` worktree off `main`. No direct commits to `main`, no force-push, no `reset --hard` on shared branches. Deliver a PR through `~/bin/gh-pr-create`. Back up before any destructive step."
  >
  > "do NOT drop or replace our fix without Ketema's explicit decision."
  >
  > "take upstream on the per task model selection, but make an issue to merge our functionality into it. using aliases is valuable, and being able to explicitly call a sub agent with a specific model string is critical, be sure to make sure our config files are set to enable the feature." (Ketema, 2026-11-10)
  >
  > "good call out. I like out design better. What is your opinion? I do not agree just because you are my agent. answer based on merit of code. the taxonomyfile is meant to be edited, read the block guidance." (Ketema, 2026-11-10)
  >
  > "2 - yes. now, manifest is approved. 3 - yes 4 - agreed" (Ketema, 2026-11-10, approving the conflict manifest, the backup tag and the tree-adoption method)
  >
  > "delete the scratch branches (baseline/*) make a pr and get the detailed history into main." (Ketema, 2026-11-11)
- **Ambiguity Score**: 3

## Known Ambiguities

| Item | Open Question | Where It Is Settled |
|:-----|:--------------|:--------------------|
| Port contracts | Do the new `pi-walker` and `pi-shell` routing paths need contract clauses of their own, given the Raw-I/O Helper contracts were written for the pre-port architecture? | The independent audit reports it; Ketema decides |
| Superseded spawn-model contract | `contracts/spawn-model.contract.ts` and `plans/spawn-model.plan.yml` describe the dropped passthrough and remain on `main` | Ketema decides removal |
| Aliases and arrays | Restoring role aliases, explicit model strings and ordered arrays on top of upstream's approval set | ketema/omp#72 |

## 2. The Actor Matrix

| Actor | Permission Level | Prohibited Actions |
|:------|:-----------------|:-------------------|
| Ketema | Approves requirements, decisions, pushes, deployment and acceptance | — |
| Claude | Edits, builds, tests and deploys on the Mac within what Ketema approved | Dropping or replacing the Raw-I/O Helper without Ketema's decision; deploying or replacing `~/bin/omp` before Ketema authorised it; committing to `main` |
| Operator | Sets machine configuration in `~/.omp/agent/config.yml` | Enabling models outside project settings without a governing role |
| Fork | Carries source code, tests, documentation and CI definitions | Diverging from the Adopted Tree on shared branches |
| Independent Auditor | Reads files, tests and commits; reports findings | Modifying any file, branch, worktree or live state |
| omp | Runs tools for agents | Opening or closing a SQLite database file or its `-shm` file through a raw descriptor in the omp addon process |
| Raw-I/O Helper | Opens, reads and closes files for Trigger Paths | Opening a SQLite database connection |
| Launcher | Launches the signed binary from `~/bin/omp` | Bypassing the askpass wrapper |

## 3. The State Transition

- **Initial State (S0)**: Fork `main` is `5280099794`, behind upstream `v18.18.7`. Ketema deployed an omp build from 2026-11-06 that predates PR #66.
- **Transformation**: Claude merges upstream `v18.18.7` onto the Explicit Base, resolves 41 conflicts keeping both intents, ports the Raw-I/O Helper routing onto upstream's new walker and shell engine, updates the registry, builds, signs, verifies and deploys.
- **Terminal State (S1)**: `origin/main` carries the Adopted Tree; `origin/main` carries the detailed history; Claude deploys an omp build from the Adopted Tree to `~/bin/omp`; Fork passes Registry rows 1 to 14 with evidence; Operator enables `task.perCallModel` in config.

## 3.5 Integration Specification

### Dependency Graph

- The walker and the embedded shell DEPEND ON the Raw-I/O Helper (`pi_vfs::helper`) for regular-file opens in the omp addon process.
- Native grep DEPENDS ON the walker's file layer (`crates/pi-walker/src/grep/run.rs`).
- Upstream's per-call model DEPENDS ON the operator config (`task.perCallModel`, `modelRoles`) held in ketema/HomeDirectory.
- Deployment DEPENDS ON the built natives and the Developer ID signature.

### Control Flow Requirements (Sequencing Specs)

| ID | Caller | Must Invoke | Temporal Constraint | Breaks If Missing |
|----|--------|-------------|---------------------|-------------------|
| SEQ-1 | pi-walker native open | `pi_vfs::helper::routes_opens()` then `helper_open` | BEFORE any regular-file open in the omp addon process | the walker closes a descriptor on an omp-held inode |
| SEQ-2 | pi-shell `VfsFs::open` | `opens_in_helper` | BEFORE the redirect or builtin consumes the file | redirects release omp's locks |
| SEQ-3 | adoption commit | verify tree equals reconciled branch tree | BEFORE push | a wrong tree reaches `main` |
| SEQ-4 | deploy | backup of the previous binary, then signature check | BEFORE replacing `~/bin/omp` | no rollback |

### Integration Points Checklist

| ID | Source | Target | Handoff Data | Contract Clause |
|----|--------|--------|--------------|-----------------|
| IP-1 | pi-walker | Raw-I/O Helper | path → bytes or `RawIoHelperFailure` | existing `raw_io_helper` clauses (not amended) |
| IP-2 | pi-shell | Raw-I/O Helper | path, open flags → file or failure | existing `raw_io_helper` clauses (not amended) |
| IP-3 | operator config | `task.perCallModel` | `"on"` plus `modelRoles` → approved model set | none (upstream behaviour) |

### Lifecycle Paths

| Component | INIT (created/started by) | CLEANUP (stopped/released by) |
|-----------|---------------------------|-------------------------------|
| Raw-I/O Helper | omp addon first routed open | omp exit |
| Reconcile worktrees and branches | `wt switch --create` | `wt remove` and the prune tool after PRs #74 and #75 merged |

## 4. Hard Invariants (The "Never" List)

| ID | Category | Invariant | Verification | Priority | Rationale |
|----|----------|-----------|--------------|----------|-----------|
| INV-RECON-01 | Merge base | Claude SHALL NOT merge against `upstream/main` with git's default merge base. | Inspection | High | 2,234 meaningless conflicts (task statement). |
| INV-RECON-02 | Branch safety | Claude SHALL NOT commit directly to `main`, force-push, or `reset --hard` a shared branch. | Inspection | High | Task statement. |
| INV-RECON-03 | Exclusions | Claude SHALL NOT mount the context-efficiency enforcement extension. | Inspection | High | Task statement. |
| INV-RECON-05 | Exclusions | Claude SHALL NOT re-add the pinned dock. | Inspection | High | Task statement. |
| INV-RECON-04 | Helper | Claude SHALL NOT drop or replace the Raw-I/O Helper without Ketema's explicit decision. | Inspection | High | Task statement. |
| REQ-RECON-01 | Method | Claude SHALL compute the 3-way merge against the Explicit Base `v18.13.0`. | Inspection | High | Task statement. |
| REQ-RECON-02 | Result | Fork SHALL preserve all fork-customized paths on top of upstream `v18.18.7`. | Inspection | High | Task statement; PR #45 precedent. |
| REQ-RECON-03 | Delivery | Claude SHALL deliver the result to `main` as one signed commit descended from `origin/main` through a pull request created by `~/bin/gh-pr-create`. | Inspection | High | Task statement; branch rules require signed commits. |
| REQ-RECON-04 | Preservation | Fork SHALL pass `scripts/verify-fork-customizations.sh --binary <candidate> --wrapper ~/bin/myomp --tests --live` with exit code 0. | Test | High | Task statement. |
| REQ-RECON-06 | Per-call model | Fork SHALL adopt upstream's `task.perCallModel` feature. | Test | High | Ketema decision 2026-11-10. |
| REQ-RECON-14 | Per-call model | Claude SHALL remove the fork's open `model` passthrough from task items. | Test | High | Ketema decision 2026-11-10. |
| REQ-RECON-07 | SQLite lock safety | Raw-I/O Helper SHALL serve regular-file opens for native grep, walker ignore-file reads, and embedded-shell redirects and builtins in the omp addon process. | Test | High | Task statement; conflict manifest approved 2026-11-10. |
| REQ-RECON-08 | Parity | Fork SHALL match the Baseline failing-test set plus the failures that already exist on fork `main`. | Test | High | Task statement. |
| REQ-RECON-09 | Deployment | Claude SHALL build the deployed `~/bin/omp` binary from the Adopted Tree with Developer ID signature. | Demonstration | High | Ketema authorisation 2026-11-11; skill `omp-fork-build-deploy`. |
| REQ-RECON-15 | Deployment | Claude SHALL create a dated backup of the previous binary before replacing `~/bin/omp`. | Demonstration | High | Rollback requirement. |
| REQ-RECON-10 | Classification | Operator SHALL classify Rust workspace crates as `PRODUCTION_CODE` (`crates/**/*.rs`) and in-file test modules as `TEST_CODE` in the CCABDD taxonomy. | Inspection | Medium | Ketema approval 2026-11-10. |
| REQ-RECON-11 | Mirror | Claude SHALL fast-forward `origin/upstream` to `v18.18.7` (`e325ffc73a`). | Inspection | Medium | Task statement; approved 2026-11-10. |
| REQ-RECON-12 | Registry upkeep | Claude SHALL update changing registry rows in the same pull request. | Inspection | High | Task statement (registry rule 4). |
| REQ-RECON-13 | History | Claude SHALL preserve the detailed commit history of the reconcile on `main` by a merge commit. | Inspection | Medium | Ketema instruction 2026-11-11. |

## 4.5 Quality Attributes (Nonfunctional)

| ID | Category | Requirement | Verification | Priority |
|:---|:---------|:------------|:-------------|:---------|
| NFR-RECON-01 | Auditability | WHEN Claude commits a conflict resolution, Claude SHALL cite its decision rationale in the git commit message. | Inspection | High |
| NFR-RECON-02 | Reproducibility | WHEN Claude builds the adopted tree, Claude SHALL produce the binary without network access during compilation. | Demonstration | High |
| NFR-RECON-03 | Rollback | WHEN Operator executes the rollback command, Launcher SHALL launch the restored previous binary. | Demonstration | High |

## 5. High-Entropy Zones (Adjudicated)

| Zone | Question | Resolution | Decided By |
|------|----------|------------|------------|
| Z1 | Per-call model: upstream's or the fork's? | Upstream's; fork's functionality merged into it later (#72) | User (CL4) |
| Z2 | Does the Rust taxonomy need `crates/**`? | Yes: `crates/**/*.rs` PRODUCTION_CODE, tests TEST_CODE | User (CL4) |
| Z3 | Upstream's own #15586 fix (OFD locks, Linux only): keep ours? | Keep the Raw-I/O Helper; upstream's fix coexists | User (CL4), task statement default |
| Z4 | Push the backup tag, refresh `origin/upstream`, tree-adoption method | Yes, yes, yes | User (CL4) |
| Z5 | Independent audit before merge? | Deferred until after deploy | User (CL4) |

## 5.5 Rejected Alternatives

| Decision | Alternative Considered | Why Rejected |
|----------|------------------------|--------------|
| Explicit v18.13.0 base | Git's default merge base | 2,234 meaningless conflicts |
| Tree adoption, one signed commit | Patch-series replay (skill `fork-reconcile`) | The 2026-10-26 reconcile used tree adoption; `required_signatures` rejects upstream's unsigned ancestry |
| Take upstream's per-call model | Keep the fork's open passthrough | Upstream's version is gated and approved by the operator; ours is a standing 17-path conflict surface |

## 6. Tool/API Interface Summary

| Interface | Purpose | Mutates State? | Called By | Triggered When |
|-----------|---------|----------------|-----------|----------------|
| `pi_vfs::helper::routes_opens` | Gate: route opens through the helper only in the omp addon process | NO | pi-walker, pi-shell | Every native regular-file open |
| `helper_open`, `RawIoHelperFailure` | Out-of-process open and its failure value | NO | pi-walker grep, pi-shell pumps and natives shell | A routed open or stream failure |
| `task.perCallModel` | Gate a per-call model on the operator's approved set | NO | task, eval agent, workpool | A task item names a model |

## 6.5 Blocking Dependencies

| Unresolved Zone | Blocks |
|-----------------|--------|
| none | nothing |

## 7. Failure Mode Specification

| Requirement | Failure Condition | Behavior | Notification |
|:------------|:------------------|:---------|:-------------|
| REQ-RECON-07 | The Raw-I/O Helper cannot open a file or its pump dies | The grep search, shell command or walk fails; it does not skip the file and report a clean result. | The error names the operation and path. |
| REQ-RECON-04 | A registry row's verify step fails | Claude SHALL NOT deploy the build. | Claude reports the failing row and output. |
| REQ-RECON-08 | A test fails that is not in the Baseline set or the fork-main set | Claude treats the failure as a regression of the merge. | Claude reports the test names. |
| REQ-RECON-15 | The deployed binary fails the signature or smoke check | Claude restores the previous binary from the dated backup. | Claude records the rollback command. |

## 8. Completion Promise (Ralph Loop Exit)

> `origin/main` has the Adopted Tree and the detailed history; the deployed `~/bin/omp` is built from it, signed, and passes `verify-fork-customizations.sh --binary ~/bin/omp --wrapper ~/bin/myomp --tests --live` (19 of 19 against the live config) with rows 10 to 14 run by hand; the full TypeScript failing set equals the Baseline plus the failures already on fork `main`; the Rust lib tests equal the Baseline; an independent audit of the Fork-Owned Delta has reported its findings; and Ketema accepts the result.

## 9. Contract Authority

**Authoritative Sources**: `contracts/raw_io_helper.contract.ts` and `contracts/raw_io_helper.contract.py` (REQ-RECON-07, not amended by this work), `contracts/omp_ssh_askpass_restoration.contract.ts` (row 4 conflict resolution). Reconcile-level obligations have no contract clauses and are verified by inspection or demonstration. `contracts/spawn-model.contract.ts` is superseded by REQ-RECON-06 and remains on `main` pending Ketema's decision.

requirements/REQUIREMENT_MANIFEST_RECONCILE_V18_18_7.md (this file)
        ↓
plans/reconcile-v18.18.7.plan.yml
        ↓
contracts/*.contract.ts
        ↓
tests
        ↓
source

## 10. Revision History

| Date | Author | Change |
|------|--------|--------|
| 2026-11-11 | Claude, for Ketema Harris | Created retroactively from session history; pending Ketema's approval |
