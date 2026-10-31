# REQ-2026-15586: Prevent in-process SQLite lock loss and converge both hosts on one fork build

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
| Trigger Path | One of the observed in-process paths that opens and closes host files inside the omp process: native grep content reads (including walker ignore-file reads), the read tool's and write tool's raw access to host files (including the SQLite classification reads and sidecar probes), `InternalUrlFilesystem.readPrefix` used by the find text scan, and embedded-shell redirect and builtin host-file opens. |
| Lock Loss | The POSIX rule on Linux and macOS that closing any descriptor for a file releases every advisory lock the process holds on that file. |
| SQLite-Family File | A host file whose resolved real path ends in `-wal`, `-shm` or `-journal`, or whose first 16 bytes are `SQLite format 3\0`. Every file omp holds POSIX locks on is SQLite-Family (verified live on the oMACarchy Host, 2026-10-31: 14 locks, all SQLite databases and their `-shm`; omp's other locks use `flock`, which a separate close does not release). |
| omp SQLite File | Any omp-owned SQLite database or its `-wal`, `-shm` or `-journal` sidecar under the omp config root and the active agent directory as omp resolves them (default `~/.omp` and `~/.omp/agent`; `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR` and `--profile` change them), matched by resolved real path so symlink and alias spellings match too (for example `agent.db`, `history.db`, `models.db`, `stats.db`, `cache/*.db`). |
| Raw-I/O Helper | A separate operating-system process with its own process id, started from the same omp executable, that opens, reads and closes host files and returns only bytes and metadata to omp. A thread or Bun Worker inside the omp process is not a Raw-I/O Helper, because POSIX record locks belong to the process. |
| Shared Commit | The single ketema/omp commit that both hosts build and run at the end of this work. |
| Baseline Failing Set | The set of failing test names produced by ketema/omp 0f9809c643 on a host. |
| Required Set | Skill Adherence Hook, destructive command blocker, rtk-rewrite, `herdr-omp-agent-state`, `moshi-hooks`, and the Search Guard Hook introduced by this work. |
| Unbounded Root | `/`, the user's home directory, or `.` while the working directory is `/` or the home directory. |
| Mac | Ketema's MacBook (macOS, Developer ID signed Mach-O builds). |
| oMACarchy Host | The Linux host whose resident agent is oMACarchy (ELF builds). |

## Assumptions

- ketema/omp main 0f9809c643 contains the upstream v18.13.0 merge (0848fc02bd).
- The Mac currently runs the recorded 18.13.0 build (sha256 97132ba2c11fbbcef214f49a98264f774a401c8caca388f08898695499cd8c8e, branch reconcile/upstream-2026-10-26 at 12d276e689).
- oMACarchy currently runs local candidate 7fcbfea (18.11 base), which is not merged and will not be merged beyond the conditional CLI flag fix.
- omp already starts helper processes from its own executable through hidden `__omp_worker_*` argv selectors (`packages/coding-agent/src/cli.ts:189-196`, `cli/worker-selectors.ts`).
- omp wraps every registered tool so that `tool_call` handlers run before execution (`packages/coding-agent/src/sdk.ts:3674-3678`).
- The State Server already runs on Linux (oMACarchy transcript 2026-10-27; memory finding-ccabdd-state-machine-works-on-linux-2026-10-30).

## Actors

| Actor | Identifier |
|:------|:-----------|
| Ketema | `ketema` |
| Claude | `claude` |
| oMACarchy | `omacarchy` |
| Host | `host` |
| omp | `omp` |
| Raw-I/O Helper | `raw_io_helper` |
| Search Guard Hook | `search_guard_hook` |
| Skill Adherence Hook | `skill_adherence_hook` |
| State Server | `state_server` |
| Session Bridge Hook | `session_bridge_hook` |
| Launcher | `launcher` |

## 1. Intent Traceability

- **Source Prose**:
  > "#4 is future theater (research this) we do not guard against situations that would only occur if we sabotage ourselves. Discard it. We are not going to re-introduce the advisor layer. It is now time to enter CCABDD. All context is to be used. My intent: Implement the minimum neccessary changes to our omp fork to prevent the failure mode that caused the sqlite db corruption on omacarchy. My overzealous statement before that it can NEVER happen again is not currently realistic. Utilize all the research we have done to have both the macbook and omacarchy running the same omp version from my fork source code. the do not have to have ALL the same hooks and plugins as their roles are different, but they must have the skill adherence, destructive command blocker, herdr-omp-agent-state, moshi-hooks, rtk-rewrite at minimum. Invoke req-elicit. omacarchy will be responsible for building and executing changes on his host, you will execute changes on your host. you both must prove to each other and to me that you meet my intent. I will interact here and you will act as a relay to omacarchy. All skills must be read in full every byte by both agents. Begin"
  >
  > Key adjudicating exchanges (verbatim):
  > - "reflection is accurate. Building a new binary from my fork is not prohibited and will not lose my customizations."
  > - "Buildign from source is literally how those tools are kept. ground on this we have built from source before and so has omacarchy. you just can't advance from the package manager or upstream. we merge in upstream while maintaining our fork features."
  > - "We will NOT drop or get stuck on a lower version. for this work 18.13 is the higher version so his work must be proven compatible and of sufficient value. Scope assertion above is correct. ... Z3 - A + C. As discussed in this convo: if our search hiearchy skill is enforced we likely never have this corruption in the first place. Z4 -> A Z5 -> A is preferred, but OS compatability issues must be guarded against. omacarchy by design has more sovereignity on his host as it is His actual identity. the myomp wrapper is not required to be exactly the same, but both must launch my omp fork only."
  > - "the session resolution portion needs to be verified on his machine." / "OS differences."
  > - "1-Agreed. 2-defer. make an issue for it"
  > - "z6 - a i agree. assess need for b after , z7- a. it is a bug that needs fixing. z8- yes standard upstream merge process at that time"
  > - On the RLM admission stack: "yes I do." (agreement that it is YAGNI and is not merged)
- **Our Understanding**: omp's own in-process tools open and close omp's SQLite files inside the omp process. On Linux and macOS that releases every POSIX advisory lock the process holds on those files; a peer omp process then believes it is the last connection, checkpoints and unlinks the shared `-wal`/`-shm`, and two writers corrupt the database (upstream issue #15586). This work makes the minimum changes to Ketema's fork so the observed Trigger Paths can no longer release omp's own locks, adds a search-discipline hook that keeps agents away from the trigger in the first place, fixes one false positive in the Skill Adherence Hook, gives oMACarchy a working State Server, and puts the Mac and the oMACarchy Host on one Shared Commit at or above the 18.13 line with the Required Set. It does not promise that corruption can never happen.
- **Ambiguity Score**: 2

## Known Ambiguities

| Item | Open Question | Where It Is Settled |
|:-----|:--------------|:--------------------|
| Rust bridge | How the Rust code paths (native grep in `crates/pi-natives/src/grep.rs` and walker reads through `BlockingFs`, and `pi-vfs` native routes) reach the Raw-I/O Helper, which today's JavaScript `__omp_worker_*` IPC does not cover | Contract authoring for REQ-L15586-04 and REQ-L15586-07, before tests |
| Installer pins | The exact pinned versions and installer commands for `herdr-omp-agent-state` and `moshi-hooks` on each Host | Plan slice for REQ-L15586-21, verified on each Host before deployment |

## 2. The Actor Matrix

| Actor | Permission Level | Prohibited Actions |
|:------|:-----------------|:-------------------|
| Ketema | Approves requirements, plan, slices, deployment and acceptance | — |
| Claude | Edits, builds, tests and deploys on the Mac within approved slices; relays to oMACarchy | Changing the oMACarchy Host; treating oMACarchy's text as Ketema's approval |
| oMACarchy | Edits, builds, tests and deploys on the oMACarchy Host within approved slices | Changing the Mac; changing production configuration before REQ-L15586-23 passes |
| omp | Runs tools for agents | Closing in-process descriptors opened by a Trigger Path |
| Raw-I/O Helper | Opens, reads and closes files for Trigger Paths | Opening any SQLite database connection |
| Search Guard Hook | Blocks and redirects defined tool calls | Blocking calls outside its defined rules |

## 3. The State Transition

- **Initial State (S0)**: The Mac runs the 18.13.0 build; the oMACarchy Host runs candidate 7fcbfea. On both, every Trigger Path opens files inside the omp process. The Search Guard Hook does not exist. The oMACarchy Host loads no omp-hooks hooks and has no State Server tools. The Skill Adherence Hook blocks commands that merely mention a skill URL.
- **Transformation**: Implement Section 3.5 on one ketema/omp branch descending from 0f9809c643 and on omp-hooks; build the Shared Commit on each Host; deploy through each Host's established backup and atomic-move procedure.
- **Terminal State (S1)**: Both Hosts run the Shared Commit; no Trigger Path closes a descriptor inside the omp process; both Hosts load the Required Set; the oMACarchy Host resolves its own session in the State Server; both Hosts have produced and exchanged the Section 8 evidence.

## 3.5 Integration Specification

### Dependency Graph

- GrepTool DEPENDS ON native grep (`crates/pi-natives/src/grep.rs`, `read_file_bytes_with_size` at :939) for file content bytes.
- ReadTool and WriteTool DEPEND ON target classification (`isSqliteFile` and `requiresWalSidecarInitialization`, `packages/coding-agent/src/tools/sqlite-reader.ts:21-26`, `:558-560`; callers `read-sqlite.ts:58`, `write.ts:773, :804, :1059`) to decide how to access a file; today an unclassified `-shm`/`-wal` falls through to an in-process `fs.readFile` (`read.ts:240-242, :2100`).
- The find text scan DEPENDS ON `InternalUrlFilesystem.readPrefix` (`packages/coding-agent/src/internal-urls/url-filesystem.ts:312`, called from `tools/jfind/text.ts:90`).
- Embedded-shell redirects and file arguments DEPEND ON brush `Shell::open_file` (`crates/vendor/brush-core/src/shell/fs.rs:204`; callers `interp.rs:2123`, `interp.rs:2306`, `shell/execution.rs:92`), which reaches `pi-vfs` `native_open` (`crates/pi-vfs/src/fs.rs:158`, via `Route::Native` at :533 and :1159).
- Shell builtins DEPEND ON `pi-vfs` native routes for host-file reads.
- The Raw-I/O Helper DEPENDS ON omp to start it from the same omp executable as a separate OS process, reachable from both the TypeScript tools and the Rust natives (`grep.rs`, `pi-vfs`) through a bridge defined in the contracts; the hidden worker-selector mechanism (`packages/coding-agent/src/cli.ts:189-196`) is the precedent for the TypeScript side.
- The Search Guard Hook DEPENDS ON omp's `tool_call` event.
- The State Server DEPENDS ON the Session Bridge Hook for implicit session resolution.

### Control Flow Requirements (Sequencing Specs)

| ID | Caller | Must Invoke | Temporal Constraint | Breaks If Missing |
|----|--------|-------------|---------------------|-------------------|
| SEQ-1 | native grep content read path | Raw-I/O Helper open/read/close of each searched file | BEFORE grep returns matches | grep closes descriptors on omp-held inodes |
| SEQ-2 | ReadTool and WriteTool target access | Raw-I/O Helper classification of the target; for a SQLite-Family target, access through the Raw-I/O Helper or a SQLite connection | BEFORE ReadTool or WriteTool opens the target | the classification or the fall-through read closes descriptors on omp-held inodes |
| SEQ-3 | `InternalUrlFilesystem.readPrefix` for host files | Raw-I/O Helper prefix read | BEFORE the find text scan evaluates content | the find scan closes descriptors on omp-held inodes |
| SEQ-4 | brush `Shell::open_file` and `pi-vfs` `native_open` for host paths | an open performed outside the omp process | BEFORE the redirect or builtin consumes the file | redirects and builtins close descriptors on omp-held inodes |
| SEQ-5 | omp on first Trigger Path request | start the Raw-I/O Helper from the same executable | BEFORE serving that request | no out-of-process executor exists |
| SEQ-6 | omp at exit | terminate the Raw-I/O Helper | AFTER the last request | orphan helper processes |
| SEQ-7 | omp `tool_call` dispatch | Search Guard Hook | BEFORE the tool executes | disallowed searches run |
| SEQ-8 | Session Bridge Hook at session start | publish the omp session identity | BEFORE the first State Server call | implicit `get_state` fails closed |

### Integration Points Checklist

| ID | Source | Target | Handoff Data | Contract Clause |
|----|--------|--------|--------------|-----------------|
| IP-1 | native grep | Raw-I/O Helper | path, byte limit → bytes or error | assigned in contracts |
| IP-2 | ReadTool and WriteTool target access | Raw-I/O Helper | path → classification (SQLite-Family or not); for SQLite-Family targets, bytes or error | assigned in contracts |
| IP-3 | `readPrefix` | Raw-I/O Helper | path, maxBytes → bytes or error | assigned in contracts |
| IP-4 | brush `open_file` / `pi-vfs` `native_open` | child process that opens, consumes and closes the file | path, open options → command output or error; no descriptor returns to omp | assigned in contracts |
| IP-5 | omp `tool_call` | Search Guard Hook | tool name, input → allow, or block with a reason naming the alternative tool | assigned in contracts |
| IP-6 | Session Bridge Hook | State Server | session id, pid, process start time | existing bridge contract |

### Lifecycle Paths

| Component | INIT (created/started by) | CLEANUP (stopped/released by) |
|-----------|---------------------------|-------------------------------|
| Raw-I/O Helper | omp, from the same executable via a hidden worker selector, on first request | omp at exit; the helper exits when its parent's pipe closes |
| Search Guard Hook | omp extension loading from `<agentDir>/hooks/pre/` | process exit |
| Session Bridge Hook | omp extension loading at session start | removes its bridge file at session shutdown |
| State Server | omp MCP startup from the user MCP configuration | MCP shutdown at omp exit |

## 4. Hard Invariants (The "Never" List)

| ID | Category | Invariant | Verification | Priority | Rationale |
|----|----------|-----------|--------------|----------|-----------|
| INV-L15586-01 | Lock safety | omp SHALL NOT close, inside the omp process, a file descriptor opened by a Trigger Path. | Test | High | Closing such a descriptor causes Lock Loss on Linux and macOS. |
| INV-L15586-02 | Helper isolation | Raw-I/O Helper SHALL NOT open a SQLite database connection. | Test | High | A helper holding SQLite connections would reproduce Lock Loss in itself. |
| INV-L15586-12 | No descriptor transfer | omp SHALL NOT receive from another process a file descriptor for a file opened by a Trigger Path. | Test | High | Closing a received descriptor in omp still releases omp's locks (POSIX locks belong to the process). |
| INV-L15586-13 | Process boundary | omp SHALL NOT run the Raw-I/O Helper as a thread or Worker inside the omp process. | Test | High | A thread shares the process lock table. |
| INV-L15586-03 | No fallback | omp SHALL NOT fall back to an in-process open when the Raw-I/O Helper is unavailable. | Test | High | A silent fallback restores the failure mode (CL9). |
| INV-L15586-04 | Scope | omp SHALL NOT change how it stores its own state in SQLite as part of this work. | Inspection | High | SQLite removal is out of scope. |
| INV-L15586-05 | Version floor | Host SHALL NOT run an omp build whose source does not descend from ketema/omp 0f9809c643. | Inspection | High | Ketema: no downgrade below 18.13. |
| INV-L15586-06 | Launcher | Launcher SHALL start only executables that Claude or oMACarchy built from ketema/omp source. | Inspection | High | Ketema: both launchers start only the fork. |
| INV-L15586-07 | Preservation | Host SHALL NOT deploy a build that drops a `requirements/FORK_CUSTOMIZATIONS.md` row from the build, the runtime or its pinning tests. | Test | High | Fork customizations survive every rebuild. |
| INV-L15586-08 | Mac sovereignty | oMACarchy SHALL NOT change the Mac. | Inspection | High | Each agent executes only on its own host. |
| INV-L15586-09 | oMACarchy sovereignty | Claude SHALL NOT change the oMACarchy Host. | Inspection | High | Each agent executes only on its own host. |
| INV-L15586-10 | Production safety | oMACarchy SHALL NOT change his production MCP configuration, launcher default or incumbent session before REQ-L15586-23 passes. | Inspection | High | Proof precedes production change. |
| INV-L15586-11 | Excluded scope | Host SHALL NOT receive the native snapshot admission and re-attestation stack, an advisor layer, guards against deliberately disabling our own hooks, or a Linux AGILITY adapter (ketema/HomeDirectory#730) from this work. | Inspection | High | Ketema decisions 2026-10-30 and 2026-10-31. |
| REQ-L15586-01 | Shared build | Host SHALL run omp built from the Shared Commit, which descends from ketema/omp 0f9809c643. | Inspection | High | macOS: Developer ID signed Mach-O. Linux: ELF. |
| REQ-L15586-02 | Preservation | Host SHALL pass the `requirements/FORK_CUSTOMIZATIONS.md` preservation checks for the Shared Commit. | Test | High | Present in build, reachable at runtime, pinned by test. |
| REQ-L15586-03 | Regression baseline | Host SHALL produce a failing-test name set for the Shared Commit equal to its Baseline Failing Set, excluding tests added by this work. | Test | High | Names, not counts, per the fork reconcile procedure; per-OS baselines differ. |
| REQ-L15586-04 | Grep reads | omp SHALL perform native grep content reads, including walker ignore-file reads, in the Raw-I/O Helper, reached from the Rust code paths. | Test | High | Trigger Path 1 (#15586): `crates/pi-natives/src/grep.rs:939`, walker reads through `BlockingFs`. |
| REQ-L15586-05 | Tool classification | omp SHALL obtain from the Raw-I/O Helper the classification of each read-tool and write-tool host-file target before omp opens that target. | Test | High | Trigger Path 2 (#15586, #17478). The read tool otherwise falls through to an in-process `fs.readFile` for `-shm`/`-wal` (`read-sqlite.ts:58`, `read.ts:240-242, :2100`); the write tool has the same exposure (`write.ts:773, :804, :1059`). |
| REQ-L15586-31 | SQLite-Family access | omp SHALL access a target that the Raw-I/O Helper classifies as SQLite-Family only through the Raw-I/O Helper or a SQLite connection. | Test | High | Decision R = C. Ordinary files keep today's in-process path; performance cost accepted. |
| REQ-L15586-06 | Find prefix | omp SHALL perform `InternalUrlFilesystem.readPrefix` reads of host files in the Raw-I/O Helper. | Test | High | Trigger Path 3. |
| REQ-L15586-07 | Shell opens | omp SHALL run each embedded-shell redirect and builtin host-file open in a child process that opens, consumes and closes the file. | Test | High | Trigger Path 4 (#15968). |
| REQ-L15586-08 | Helper failure | When the Raw-I/O Helper cannot start or fails, omp SHALL return an error that names the failed operation and path. | Test | High | CL9 observable failure. |
| REQ-L15586-09 | Builtins switch | Host SHALL set `PI_DISABLE_UUTILS_BUILTINS` in its omp shell configuration. | Inspection | Medium | Defense in depth (Ketema). macOS: BSD utilities from PATH. Linux: GNU utilities from PATH. |
| REQ-L15586-10 | Unbounded search | Search Guard Hook SHALL block a grep, find, glob or ast_grep tool call, or a bash `grep -r`, `rg` or `find` command, whose search root is an Unbounded Root. | Test | High | Constitutional search-boundary rule. macOS home `/Users/<user>`; Linux home `/home/<user>`. |
| REQ-L15586-11 | omp data | Search Guard Hook SHALL block a tool call or bash command whose target is an omp SQLite File or whose directory walk starts at or above a directory that contains one. | Test | High | Keeps agents away from the trigger. |
| REQ-L15586-12 | Git scope | Search Guard Hook SHALL block a grep or find tool call, or a bash `grep -r`, `rg` or `find` command, whose root lies inside a git working tree unless the agent ran `git grep` or `git ls-files` in that working tree earlier in the session. | Test | High | Search hierarchy: git first, then a bounded broader search (decision B). |
| REQ-L15586-13 | Redirect reason | When Search Guard Hook blocks a call, Search Guard Hook SHALL name the bounded alternative tool (`lsp`, `git grep`, `git ls-files`, or a convo tool) in the block reason. | Test | High | Block-and-redirect (Z6). |
| REQ-L15586-14 | Transcripts | Search Guard Hook SHALL block an unbounded raw search of a transcript store. | Test | Medium | Use omp-convos for transcript search. |
| REQ-L15586-15 | Point retrieval | Search Guard Hook SHALL allow retrieval of one exact message from an identified session file. | Test | Medium | Located-episode retrieval stays available. |
| REQ-L15586-16 | LSP discovery | Search Guard Hook SHALL allow `lsp` status and discovery calls. | Test | Medium | Symbol search is the preferred route. |
| REQ-L15586-17 | LSP target | Search Guard Hook SHALL block an `lsp` call whose target file is an omp SQLite File. | Test | Medium | `lsp` may open its target document in-process. |
| REQ-L15586-18 | State independence | Search Guard Hook SHALL apply its rules whether or not a CCABDD state exists. | Test | High | Host administration on oMACarchy runs outside CCABDD. |
| REQ-L15586-19 | URL mention | Skill Adherence Hook SHALL allow a bash, ipython or eval call whose text mentions a skill URL or a `SKILL.md` path. | Test | High | Z7: the current block is a false positive. |
| REQ-L15586-20 | Canonical credit | Skill Adherence Hook SHALL credit a skill as read only after a successful canonical read-tool delivery of that skill. | Test | High | Alternate shell or REPL reads earn no credit. |
| REQ-L15586-21 | Required Set | Host SHALL load every member of the Required Set, taking the Skill Adherence Hook, destructive command blocker and rtk-rewrite from one pinned omp-hooks commit and `herdr-omp-agent-state` and `moshi-hooks` from each tool's installer at a pinned version. | Test | High | Z5. Mac and Linux install paths differ. |
| REQ-L15586-29 | Role extensions | Host SHALL keep loading its existing role extensions alongside the Required Set. | Demonstration | High | oMACarchy Host: `omacarchy-covenant.ts`, `matrix.ts`. Mac: `session.ts`. Roles differ by design. |
| REQ-L15586-22 | OS portability | Host SHALL NOT load Required Set code that hard-codes a path, binary or kernel interface present on only one of macOS and Linux without a defined equivalent for the other. | Inspection | High | macOS `/dev/fd`, `ps`; Linux `/proc/self/fd`, `/proc`. |
| REQ-L15586-23 | State Server proof | oMACarchy SHALL prove, in a development session that uses an isolated agent directory and configuration, that an implicit `get_state` resolves that session's own id, that a CONVERSATION to REQUIREMENTS transition reads back, and that the State Server refuses an unauthorized GREEN transition with state unchanged. | Demonstration | High | Ketema: verify session resolution on his machine. Production `mcp.json` and extensions stay untouched until this passes. |
| REQ-L15586-24 | State Server deploy | WHEN REQ-L15586-23 has passed, oMACarchy SHALL configure the oMACarchy Host's omp to declare the State Server and load the Session Bridge Hook. | Demonstration | High | Z1. The Mac already has both. |
| REQ-L15586-25 | Behaviour proof | Host SHALL demonstrate one defined observable behaviour for each Required Set member in the deployed omp. | Demonstration | High | Z4. The Search Guard Hook is a Required Set member. |
| REQ-L15586-30 | Bridge proof | WHEN REQ-L15586-24 has passed, oMACarchy SHALL demonstrate that the deployed omp on the oMACarchy Host resolves its own session through the Session Bridge Hook. | Demonstration | High | The Session Bridge Hook joins the oMACarchy Host's proven set after REQ-L15586-23. |
| REQ-L15586-26 | CLI flag fix | When a test reproducing rejection of the RLM isolation startup flags fails on the Shared Commit, Claude SHALL include the fix for that rejection in the Shared Commit. | Test | Medium | Only RLM change carried (decision 2026-10-31). |
| REQ-L15586-27 | Candidate selection | Launcher SHALL select a candidate build through the Host's existing selector without changing the default build. | Demonstration | Medium | macOS `OMP_BIN`; Linux `--omp-revision <40hex> --`. |
| REQ-L15586-28 | Reproduction | Host SHALL demonstrate, with throwaway databases, that the pre-change build loses its locks under each Trigger Path and the Shared Commit build does not. | Demonstration | High | Completion Promise. |

## 5. High-Entropy Zones (Adjudicated)

| Zone | Question | Resolution | Decided By |
|------|----------|------------|------------|
| Z1 | Can oMACarchy use the State Server? | Yes, after an isolated live proof | User (CL4) |
| Z2 | Which source becomes the shared version? | ketema/omp main 0f9809c643 or later; no downgrade | User (CL4) |
| Z3 | How wide is the fix? | Out-of-process raw I/O for the Trigger Paths, plus the builtins switch and a blocking search hook | User (CL4) |
| Z4 | How is hook loading proven? | One observable behaviour per hook per Host | User (CL4) |
| Z5 | Where do hooks come from? | Shared pinned sources, guarded against OS differences | User (CL4) |
| Z6 | How much search enforcement? | Block-and-redirect hook only; reassess the read-before-search gate afterwards | User (CL4) |
| Z7 | Skill-adherence URL false positive? | A bug; fixed in this work | User (CL4) |
| Z8 | Upstream's own #15586 fix? | Adopted through the standard upstream merge process when it ships | User (CL4) |
| AGILITY | Linux AGILITY via the Feitian key? | Deferred to ketema/HomeDirectory#730 | User (CL4) |
| RLM | Merge the native snapshot admission stack? | No; only the CLI flag fix if its test fails | User (CL4) |
| Z9 | Git-scope rule for grep/find inside repositories | Tool calls and bash recursive commands blocked until `git grep` or `git ls-files` has run in that repository this session | User (CL4) |
| R | How to cover the read and write tools' raw access | Helper classifies each target out of process by real-path suffix or SQLite header; SQLite-Family targets go through the helper or a SQLite connection; other files read in-process | User (CL4) |
| Builtins | Keep `PI_DISABLE_UUTILS_BUILTINS` given BSD utilities on macOS | Keep (defense in depth) | User (CL4) |
| Performance | Bound the cost of out-of-process reads? | No bound; cost accepted | User (CL4) |

## 5.5 Rejected Alternatives

| Decision | Alternative Considered | Why Rejected |
|----------|------------------------|--------------|
| Out-of-process raw I/O | In-process inode guard (upstream PR #15591) | Lifetime race, unguarded writes and descriptor leaks found in upstream review |
| Out-of-process raw I/O | Configuration-only stopgap | Reduces exposure but leaves the mechanism |
| Block-and-redirect hook | Read-skill-before-search gate | Larger; reassessed after this work |
| Behavioural hook proof | New loaded-extension inventory endpoint | Not needed to meet the intent |
| 18.13 main as floor | Move the Mac onto the 18.11 candidate | Ketema: no downgrade |
| Classify by suffix or header (R-C) | Route every raw read through the helper (R-A) | Every file read would pay a process round trip without protecting any additional locked file |
| Classify by suffix or header (R-C) | Refuse only omp's own database paths (R-B) | Misses other SQLite files such as mnemopi banks and profile directories |
| Suffix and header checks only | WAL, journal and WAL-index magic checks for renamed hardlinks | Only a deliberately created renamed hardlink would need them; no guarding against self-created scenarios |

## 6. Tool/API Interface Summary

| Interface | Purpose | Mutates State? | Called By | Triggered When |
|-----------|---------|----------------|-----------|----------------|
| Raw-I/O Helper requests | Open, read and close host files out of process | NO | native grep, ReadTool, `readPrefix`, embedded shell | A Trigger Path touches a host file |
| Search Guard Hook | Block and redirect defined searches | NO | omp `tool_call` | Every tool call |
| State Server `get_state` / `set_state` | Read and change workflow state | YES (`set_state`) | agents | Workflow transitions |

## 6.5 Blocking Dependencies

| Unresolved Zone | Blocks |
|-----------------|--------|
| none | nothing |

## 7. Failure Mode Specification

| Requirement | Failure Condition | Behavior | Notification |
|:------------|:------------------|:---------|:-------------|
| REQ-L15586-08 | Raw-I/O Helper cannot start, crashes or times out | omp SHALL return the tool call as an error without an in-process open. | omp SHALL name the failed operation and path in the error. |
| REQ-L15586-10 | A call has an Unbounded Root | Search Guard Hook SHALL block the call before execution. | Search Guard Hook SHALL name the bounded alternative tool in the reason. |
| REQ-L15586-11 | A call targets an omp SQLite File | Search Guard Hook SHALL block the call before execution. | Search Guard Hook SHALL name the bounded alternative tool in the reason. |
| REQ-L15586-19 | A command mentions a skill URL | Skill Adherence Hook SHALL allow the call. | Skill Adherence Hook SHALL emit no block. |
| REQ-L15586-21 | A Required Set member fails to load | Host SHALL keep its current default build. | Host SHALL report the missing behaviour in the REQ-L15586-25 proof. |
| REQ-L15586-23 | Implicit `get_state` does not resolve the development session | oMACarchy SHALL leave production configuration unchanged. | oMACarchy SHALL report the observed resolution to Claude and Ketema. |
| REQ-L15586-01 | A Host cannot build the Shared Commit | Host SHALL keep its current default build. | Host SHALL report the build error to Claude and Ketema. |
| REQ-L15586-03 | The failing-test name set differs from the Baseline Failing Set | Host SHALL keep its current default build. | Host SHALL report the differing test names. |

## 8. Completion Promise (Ralph Loop Exit)

> On each Host, with throwaway databases only: a process holding a WAL connection keeps its POSIX locks across a grep, a read, a find and an embedded-shell redirect of its database and `-shm`; a peer process attempting `BEGIN IMMEDIATE` stays blocked; the `-wal` is not unlinked; and `PRAGMA integrity_check` returns `ok`. The same reproduction against the pre-change build shows the lock loss. Both Hosts report the same Shared Commit, their own binary hashes, passing `FORK_CUSTOMIZATIONS.md` checks, failing-test name sets equal to their baselines, one observed behaviour for each Required Set member, and (oMACarchy Host) the isolated State Server proof. Claude and oMACarchy exchange this evidence, and Ketema accepts it.

## 9. Contract Authority

**Authoritative Sources**: `contracts/raw_io_helper.contract.ts` (ketema/omp) and `contracts/omp_search_guard.contract.ts` (omp-hooks), authored per slice.

requirements/REQUIREMENT_MANIFEST_15586_LOCK_LOSS.md (this file)
        ↓
plans/15586-lock-loss.plan.yml
        ↓
contracts/*.contract.ts
        ↓
tests
        ↓
source

## 10. Revision History

| Date | Author | Change |
|------|--------|--------|
| 2026-10-31 | Ketema Harris | Initial manifest from requirements elicitation |
