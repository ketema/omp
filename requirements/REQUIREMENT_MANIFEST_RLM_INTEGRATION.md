# REQ-RLM-2026-002: RLM Biomimetic Integration and Context-Hygiene Architecture

## CCABDD Governance

Human owns: intent (front) + reality judgment (back).
AI owns: enforcement (middle).
Neither crosses the boundary.

Human MUST confirm real-world effect matches intent.
AI MAY NOT infer success from metrics.

**INV-3**: No discretion. No judgment. Only state.
No contract executes unless ALL predicates evaluate to TRUE.

---

## Actors

| Actor | Identifier |
|:------|:-----------|
| Model | Model |
| TypeScript host | TypeScript host |
| Kernel manager | Kernel manager |
| Python runtime | Python runtime |
| RLM extension | RLM extension |
| Bash gate | Bash gate |
| Session maintenance | Session maintenance |
| User | User |

## 1. Intent Traceability

- **Source Prose** (verbatim):
  > "combine all suggestions into an action plan. execute req-elicit and lets use CCABDD so that we integrate it properly. we must address this finding:
  > Unwired Host Bridge: packages/rlm/src/extension.ts builds transport and KernelManager, but transport.onHostRequest is not hooked up to RlmRecursionEngine / RlmBridgeRouter in the live extension factory.
  > not wiring is a classic llm failure mode. despite all my effort this still happened.
  > We have to be careful with jsut offloading everything. For example I would not want memories offloaded. I want memories recalled IN FULL fidelity. it is bad enough that the model natively doesn't full read skills and memories. those are things I DO NOT want truncated. but mechanical operations that can return unknown content lengths like unbounded greps or finds those should always go into rlm. tmux-offload is great but you do not use it correctly. you will execute a build that spits out 1000 lines but then you read 500 when the results are the last one or two. better than 1000 I guess, but not efficient. when using the rlm ipython repl my expectation is if I were you or if I had this capability to offload cognitive processes I would use it like a programmable computer: everytime I wanted to write python code to do something I would write that as a program in the repl and name it. then whenever I needed to do that task again I would just call the function name. I would never duplicate system tools. they are already optimized. however when I needed to create NIX tool chains I would offload that to the repl and make it a function and then never create that tool chain again. for anything that produced output that I had to read i would create a standing repl function that counted characters/tokens/lines whatever and use that as a wrapper over any function i called to give me small integer that told me the size of the output so that i would know if it was safe to read in full or if I needed to chunk it. my main context would still fill, so I would be smart with compaction: as my context grew I would maintain a timeline and graph in the repl. anything that is generateable and already durable in other mediums i would not duplicate only store a pointer to HOW to reproduce it. the most recent 1/2 or 1/4 of context is the most important. after compaction i would retrieve that amount in full with a link to the full fidelity in the repl. I would basically follow the rules I have designed in my biomimetic memory system (read the IKG)
  > another resource is headroom. as a compression engine with a recall tool, full fidelity is always available. the same concept can apply. if a rlm.view exceeds tehe budget it does not just return an error. it returns the content up to the budget AND a ViewBudgetExceeded NOTICE with the ability to get more. Not just the REST, but MORE. and if needed can eventually get Full Fidelity. and Full Fidelity is always available for comparison or later retrieval"

- **Our Understanding**: The RLM integration connects the live extension host bridge (`transport.onHostRequest`) to a unified host dispatcher combining `RlmRecursionEngine` and `RlmBridgeRouter`, binding subagent spawning to real detached task sessions. Furthermore, the harness establishes a mechanical context-hygiene layer that gates `bash` against raw data slurps while preserving 100% full-fidelity recall for memory tools (`mcp__memory__*`) and skills, turning the REPL into a persistent toolchain engine with Headroom-style paged views and compaction timeline recovery.

- **Ambiguity Score**: 0 (all high-entropy zones, boundaries, and failure modes adjudicated).

## 2. The Actor Matrix

| Actor | Permission Level | Prohibited Actions |
|:------|:-----------------|:-------------------|
| Model | Model SHALL execute cells in persistent REPL, register named toolchains, and browse paged slices | Model SHALL NOT ingest raw unbounded slurps into chat context or bypass sizing gates |
| TypeScript host | TypeScript host SHALL own process lifecycle, unified host dispatch, compaction active-slice manifests, and credential boundaries | TypeScript host SHALL NOT expose plaintext credentials or uncontracted tool dispatch handlers |
| Kernel manager | Kernel manager SHALL orchestrate process transport and Dill state snapshots | Kernel manager SHALL NOT allow busy cell execution to starve shutdown or snapshot flushes |
| Python runtime | Python runtime SHALL execute `rlm_runtime.py`, manage `rlm.tools`, and spool raw ingestion streams | Python runtime SHALL NOT pollute model user_ns with internal helper variables |
| RLM extension | RLM extension SHALL wire `transport.onHostRequest` to unified host dispatcher and subagent task spawner | RLM extension SHALL NOT ship unwired host request handlers |
| Bash gate | Bash gate SHALL intercept `bash` tool calls exceeding size thresholds and enforce memory tool allowlists | Bash gate SHALL NOT gate or truncate memory tools or skill definitions |
| Session maintenance | Session maintenance SHALL write active-slice manifest and inject `<rlm_state>` recovery notices | Session maintenance SHALL NOT allow kernel consolidation failures to abort session compaction |
| User | User SHALL set budgets, configure gate modes (observe/rewrite/block), and arbitrate real-world effect | User SHALL NOT bypass enforcement layers mid-flow |

## 3. The State Transition
- **Initial State ($S_0$)**: TypeScript host executes `packages/rlm/` capability library complete across 8 slices, but leaves `transport.onHostRequest` unwired in `extension.ts`; Model slurps raw data via `bash` without persistent toolchain caching or paged views.
- **Transformation**: RLM extension SHALL wire `transport.onHostRequest` to unified host dispatcher; RLM extension SHALL bind `childRunner` to OMP subagent task spawning; Bash gate SHALL deploy `rlm-gate` PreToolUse hook; Python runtime SHALL implement `rlm.tools` source recipe journal; Python runtime SHALL implement `rlm.measure/ingest/view` Headroom-style paging engine; Session maintenance SHALL implement active-slice compaction bridge.

## 3.5 Integration Specification

### Dependency Graph

- RLM extension DEPENDS ON unified host dispatcher for `host.request` routing.
- Unified host dispatcher DEPENDS ON `RlmRecursionEngine` for `rlm.run` and model discovery.
- Unified host dispatcher DEPENDS ON `RlmBridgeRouter` for `refine`, `heartbeat`, `message`, and `observe` handlers.
- `RlmRecursionEngine` child runner DEPENDS ON OMP task runner for spawning real subagent sessions.
- `rlm-gate` extension DEPENDS ON memory allowlist for bypassing memory tools and skills.
- `rlm.tools` registry DEPENDS ON `toolchain.json` for source recipe persistence.
- `rlm.view` DEPENDS ON spool storage for retrieving raw slice bytes.
- `SessionMaintenance` DEPENDS ON active-slice manifest for recording recent working context before compaction.

### Control Flow Requirements (Sequencing Specs)

| ID | Caller | Must Invoke | Temporal Constraint | Breaks If Missing |
|:---|:-------|:------------|:--------------------|:------------------|
| SEQ-INT-1 | RLM extension | `transport.onHostRequest` | BEFORE first cell execution | Cell calling `await rlm()` hangs or drops request |
| SEQ-INT-2 | Unified host dispatcher | `RlmBridgeRouter.dispatch` | UPON receiving `refine.*`, `heartbeat.*`, `message.*`, `observe.*`, `model.info` | Bridge handlers answer unavailable |
| SEQ-INT-3 | Unified host dispatcher | `RlmRecursionEngine.spawn` | UPON receiving `rlm.run` frame | Subagent admission fails |
| SEQ-INT-4 | `RlmRecursionEngine` | OMP subagent task spawner | BEFORE returning admission handle | Subagent created on paper but never runs |
| SEQ-INT-5 | `rlm-gate` hook | Memory allowlist check | BEFORE command risk classification | Memory tools inadvertently truncated |
| SEQ-INT-6 | `rlm.ingest` | Raw output spooling to disk | BEFORE registering engram in `ledger.ndjson` | Spool file missing on `rlm.view` |
| SEQ-INT-7 | `SessionMaintenance` | Active-slice manifest write | BEFORE executing compaction summarization | Recent working set lost at compaction |
| SEQ-INT-8 | `SessionMaintenance` | Kernel `_consolidate` cell | BEFORE Dill state snapshotting | Timeline journal unflushed before snapshot |
| SEQ-INT-9 | `SessionMaintenance` | `<rlm_state>` notice injection | AFTER compaction item written | Model unaware of survived state |
| SEQ-INT-10 | Kernel manager | Dill state restoration | BEFORE prelude and RLM bootstrap | Restored variables clobbered by bootstrap |

### Integration Points Checklist

| ID | Source | Target | Handoff Data | Contract Clause |
|:---|:-------|:-------|:-------------|:----------------|
| IP-1 | `transport.ts` | `RlmHostDispatcher` | NDJSON `host_request` frame | SEQ-INT-1 |
| IP-2 | `RlmHostDispatcher` | `RlmBridgeRouter` | Handler type and payload | SEQ-INT-2 |
| IP-3 | `RlmHostDispatcher` | `RlmRecursionEngine` | `rlm.run` kwargs and prompt | SEQ-INT-3 |
| IP-4 | `RlmRecursionEngine` | OMP task spawner | `[task from parent]` prompt and session dir | SEQ-INT-4 |
| IP-5 | `rlm-gate` hook | Memory allowlist | Tool name (`mcp__memory__*`, `skill://`) | SEQ-INT-5 |
| IP-6 | `rlm-gate` hook | Command risk classifier | Parsed bash command AST | SEQ-INT-5 |
| IP-7 | `rlm.ingest` | Spool storage | Raw stdout/stderr stream | SEQ-INT-6 |
| IP-8 | `rlm.tools` | `toolchain.json` | AST source and metadata | SEQ-INT-1 |
| IP-9 | `SessionMaintenance` | Active-slice file | Branch token window ($\le 64\text{k}$) | SEQ-INT-7 |
| IP-10 | `state-snapshot.ts` | `runner.py` control frame | `{"type":"snapshot"}` | SEQ-INT-8 |

### Lifecycle Paths

| Component | INIT (created/started by) | CLEANUP (stopped/released by) |
|:----------|:--------------------------|:------------------------------|
| `_RlmRuntime` singleton | `prelude.py` bootstrap on kernel spawn | kernel manager on session dispose |
| Toolchain registry | `rlm_runtime.py` rehydrating `toolchain.json` | journal flush on cell settle |
| `rlm-gate` hook | extension loader on session start | unregister on session close |
| Spool files | `rlm.ingest` on command execution | session artifact cleanup on dispose |
| Timeline journal | `rlm_runtime.py` on initialization | journal flush before compaction snapshot |

## 4. Hard Invariants (The "Never" List)

| ID | Category | Invariant |
|:---|:---------|:----------|
| INV-BIO-1 | Memory Fidelity | Bash gate SHALL NOT gate, truncate, or summarize memory tools matching `mcp__memory__*`, `mcp__recall__*`, or `skill://` reads. |
| INV-BIO-2 | Toolchain Durability | Python runtime SHALL NOT persist functions as pickled closures or Dill bytecode in `toolchain.json`. |
| INV-BIO-3 | Paging Completeness | Python runtime SHALL NOT silently drop or clip data in `rlm.view()` without returning structured continuation metadata. |
| INV-BIO-4 | Compaction Safety | Session maintenance SHALL NOT allow kernel consolidation failures to abort or block session compaction. |
| INV-BIO-5 | Security Boundary | Python runtime SHALL NOT store or persist plaintext credentials in RLM spooling or artifacts. |
| INV-BIO-6 | Namespace Isolation | Python runtime SHALL NOT pollute model `user_ns` with internal helper variables during toolchain rehydration. |
| INV-BIO-7 | Tool Gating Scope | Bash gate SHALL NOT intercept any tool other than `bash` in version 1. |

## 5. High-Entropy Zones (Adjudicated)

| Zone | Question | Resolution | Decided By |
|:-----|:---------|:-----------|:-----------|
| Z-1 Gating Target | Gate all tools or gate bash first? | Gate `bash` only in v1 where unbounded slurps occur; memory tools and skills are allowlisted for 100% full fidelity. | User: "agree. I would start simply and gate bash only." |
| Z-2 Toolchain Durability | Pickle functions via Dill or store as source recipes? | Store functions as raw Python source strings in `toolchain.json` and rehydrate via `exec` into `sys.modules["rlm_tools"]` at startup. | User: "write that as a program in the repl and name it" |
| Z-3 Budget Overrun Behavior | Throw hard error or return partial content + continuation notice? | Apply Headroom Paging Pattern: return content up to budget AND append `ViewBudgetExceeded` notice with `next` offset and `full_fidelity=True` handles. | User: "returns the content up to the budget AND a ViewBudgetExceeded NOTICE with the ability to get more" |
| Z-4 Compaction Working Band | Proportion of context kept for post-compaction vivid band? | Compute $\text{sliceTokens} = \max(0.25\cdot W, \min(64\text{k}, 0.5\cdot W))$, store active-slice manifest pointing to session JSONL, inject `<rlm_state>` recovery block. | User: "most recent 1/2 or 1/4 of context is the most important" |

## 5.5 Rejected Alternatives

| Decision | Alternative Considered | Why Rejected | Decided By |
|:---------|:-----------------------|:-------------|:-----------|
| Headroom paging notice | Hard blocking exception on view overrun | User directive: model receives data up to budget plus actionable handle to fetch more. | User |
| Soft compaction degradation | Aborting compaction on kernel error | Compaction is an emergency recovery path and must never fail closed. | User |
## 6. Tool/API Interface Summary

| Interface | Purpose | Mutates State? | Called By | Triggered When |
|:----------|:--------|:---------------|:----------|:---------------|
| `rlm.measure(src)` | Measures bytes, lines, estimated tokens, and data structure | YES | Model | model inspects data |
| `rlm.ingest(cmd)` | Executes command with stdout spooled to artifact; registers engram | YES | Model | model offloads stream |
| `rlm.view(target)` | Returns paged slice with `ViewBudgetExceeded` continuation notice | NO | Model | model reads offloaded slice |
| `rlm.tools.register` | Persists function source recipe to `toolchain.json` | YES | Model | model registers tool |
| `rlm.recover.slice()` | Returns index of active-slice manifest with session entry pointers | NO | Model | post-compaction recovery |
| `rlm.recover.rehydrate()` | Retrieves exact historical turn text from session JSONL via pointer | NO | Model | model rehydrates context |
| `rlm-gate` hook | Intercepts risky bash commands and outputs teaching error | NO | Bash gate | before bash command execution |

## 6.5 Blocking Dependencies

| Unresolved Zone | Blocks |
|:----------------|:-------|
| None | Contracts phase unblocked |
| IEEE 29148 linter verification | Verification gate |

## 7. Failure Mode Specification (CL15)

| Requirement | Failure Condition | Behavior | Notification |
|:------------|:------------------|:---------|:-------------|
| REQ-BIO-0001 | Unregistered `host.request` | TypeScript host SHALL reject unhandled frame | Error message logged |
| REQ-BIO-0004 | Output exceeds threshold | Bash gate SHALL block process fork | Teaching error returned |
| REQ-BIO-0006 | Memory tool invoked | Bash gate SHALL allow execution | Full fidelity content returned |
| REQ-BIO-0012 | View exceeds budget | Python runtime SHALL append continuation notice | `ViewBudgetExceeded` notice returned |
| REQ-BIO-0015 | Consolidation failure | Session maintenance SHALL continue compaction | Warning notice emitted |

## 8. Completion Promise (Ralph Loop Exit)

TypeScript host SHALL route all kernel `host_request` frames without unwired routes; Bash gate SHALL block and redirect `bash` slurps to `rlm.ingest()`; Bash gate SHALL pass memory tools and skills with 100% full fidelity; Python runtime SHALL execute reusable toolchain functions; Session maintenance SHALL rehydrate active-slice context post-compaction.

## 9. Contract Authority

**Authoritative Source**: `requirements/rlm-biomimetic-state-architecture.md` (architectural blueprint), this manifest (IEEE layer), and `contracts/` files produced downstream (`rlm-biomimetic.contract.ts`).

## 10. Revision History

| Date | Author | Change |
|:-----|:-------|:-------|
| 2026-08-19 | K. Harris | Initial requirement manifest for RLM Biomimetic Integration & Context-Hygiene Architecture |
