# REQ-RLM-2026-001: Native RLM State-Offload Capability for omp

## CCABDD Governance

Human owns: intent (front) + reality judgment (back).
AI owns: enforcement (middle).
Neither crosses the boundary.

Human MUST confirm real-world effect matches intent.
AI MAY NOT infer success from metrics.

**INV-3**: No discretion. No judgment. Only state.
No contract executes unless ALL predicates evaluate to TRUE.

---

## 1. Intent Traceability

- **Source Prose** (verbatim):
  > "i want the full MIT paper REPL capability. in fact I want you to enumerate each feature of the prime-agent iPython implementation. search its documentation. i want a document we can refer to, to ensure feature for feature capability."
  > "convert this document into our ieee compliant format using req-elicit. The document IS the requirements."
  > Earlier directives, retained as decisions: "keep all venv extras" · "I want full OS capability. the computer is the sandbox" · "the way in which omp uses its current kernel should not change. the rlm kernel should be additional. a tool. an addition." · "I am not looking to change up how omp operates other than providing the harness with a native way to allow the model to offload state." · "the core context is still the same because that is what is sent to the model and what is appended to each turn. that cannot be changed."

- **Our Understanding**: The RLM plugin shall add to omp a prime-agent-faithful RLM state-offload capability: a persistent Python kernel surface the Model uses as an additional tool, with the offload discipline (prompt contract, harness ledger, snapshot/revival, compaction notice, recursion) — such that main context stays append-only and unchanged, and state the Model must keep survives compaction and session resume by pointer instead of by transcript. Requirements material = the feature enumeration recorded in `requirements/rlm-feature-reference.md` (behavioral source), IEEE-specified in §4 below.

- **Ambiguity Score**: 3 (three genuine open zones, §5; nothing else may block contracts).

## Actors

- **Model**
- **TypeScript host**
- **Kernel manager**
- **Python runtime**
- **RLM plugin**
- **Subagent child**
- **omp frontend**
- **User**

## 2. The Actor Matrix

| Actor | Permission Level | Prohibited Actions |
|:------|:-----------------|:-------------------|
| Model | invokes the RLM tool surface as documented; reads/writes kernel namespace via cells; spawns bounded children | shall not alter main-context composition rules; shall not bypass depth/model validators |
| TypeScript host | owns process lifecycle, provider calls, persistence, credential resolution, policy validation | shall not expose credential material to the Python process beyond the reference's bounded set |
| Python runtime (kernel + rlm shim) | executes model cells; bridges typed host requests; maintains the harness ledger | shall not implement an agent loop; shall not resolve provider credentials |
| Subagent child | runs its own session; replies via parent messaging only | shall not exceed inherited depth; shall not return its answer as an `rlm()` return value |
| omp frontend (TUI/ACP/print) | renders tool results | shall not own execution state |
| User | configures budgets, gates, model/depth limits; approves plan-level changes | shall not bypass enforcement layers |

## 3. The State Transition

- **Initial State ($S_0$)**: omp running with its current eval kernel and transcript flow, unchanged; no RLM capability mounted.
- **Transformation**: Mount the RLM capability as an addition (tool + provider machinery) on omp extension surfaces; kernel becomes the persistent state container; ledger + snapshot + notices provide durability; recursion spawns subagent children through omp's subagent machinery.
- **Terminal State ($S_1$)**: The RLM plugin SHALL map every feature ID from the reference document to an omp home, implement each mandated ID, and attach an observing test to each; omp's existing eval kernel, transcript composition, and per-turn context semantics SHALL remain byte-equivalent to pre-port behavior.

## 3.5 Integration Specification

### Dependency Graph

- RLM tool DEPENDS ON kernel manager for cell execution.
- Kernel manager DEPENDS ON the RLM transport for process admission and wire I/O.
- RLM transport DEPENDS ON kernel environment bootstrap (REQ-RLM-0012) for interpreter selection and the spawn env.
- rlm shim DEPENDS ON host bridge for typed `host.request` dispatch.
- `rlm.run` recursion DEPENDS ON subagent spawn (omp structured subagent / agent-bridge) for child session creation.
- Harness ledger DEPENDS ON session artifacts directory for durability.
- Snapshot/revival DEPENDS ON session resume + dispose lifecycle hooks.
- Compaction notice DEPENDS ON omp compaction completion event.
- Prompt contract DEPENDS ON omp tool-prompt composition.
- Config surface DEPENDS ON omp settings schema (vals) or plugin manifest schema.

### Control Flow Requirements (Sequencing Specs)

| ID | Caller | Must Invoke | Temporal Constraint | Breaks If Missing |
|----|--------|-------------|---------------------|-------------------|
| SEQ-1 | session start (first RLM tool use) | kernel manager `start` | BEFORE any cell execution | tool unusable |
| SEQ-2 | kernel manager `start` | snapshot `restore` | AFTER process spawn, BEFORE prelude/shims are (re)injected | revived state clobbered by bootstrap |
| SEQ-3 | cell execution completion | snapshot debounce write | AFTER execute settles (1500 ms debounce) | restart loses namespace |
| SEQ-4 | session dispose | kernel shutdown with snapshot flush | BEFORE process teardown completes | state loss on exit |
| SEQ-5 | compaction completion | inventory notice injection | AFTER compaction item written | model unaware its state survived |
| SEQ-6 | `rlm.run` request | depth gate + model resolve | BEFORE child admission | policy bypass |
| SEQ-7 | child completion | REPLY to parent or terminal notice | BEFORE parent turn accounting closes | silent child loss |
| SEQ-8 | child run end | usage attribution into parent assistant turn | BEFORE transcript/statistics finalize | billable/context math wrong |
| SEQ-9 | ledger mutation | save-to-disk | AFTER each CRUD | memory loss |
| SEQ-10 | host `/refine` write | ledger mtime re-sync | BEFORE next kernel-side access | split-brain ledger |
| SEQ-11 | config provider | config delivery to RLM runtime (interpreter path, caps, depth) | BEFORE kernel start | defaults silently applied inside run() |
| SEQ-12 | first RLM execute (via kernel manager) | transport spawn + readiness gate | runner spawned with the bootstrap env, readiness BEFORE the first op | first cell hangs or dies on an unready runner |
| SEQ-13 | RLM extension registration | tool + kernel manager + transport construction from resolved config | wired BEFORE the first model invocation; no component may ship unattached | tool registered but kernel unreachable (isolated component) |

### Integration Points Checklist

| ID | Source | Target | Handoff Data | Covered By |
|----|--------|--------|--------------|------------|
| IP-1 | RLM tool call | kernel manager | cell source, timeout, reset flag | SEQ-1..3, F-004/F-006 |
| IP-2 | kernel | host bridge | typed host_request payloads | F-071/F-072/F-073 |
| IP-3 | rlm shim `run` | subagent machinery | prompt, name, model selector | SEQ-6, F-110..F-128 |
| IP-4 | child session | parent session | reply messages / terminal notices | SEQ-7, F-053/F-129 |
| IP-5 | kernel manager | session artifacts | dill snapshot + manifest | SEQ-3/SEQ-4, F-170..F-183 |
| IP-6 | compaction pipeline | RLM capability | compaction-complete signal | SEQ-5, F-179 |
| IP-7 | ledger | harness state file | JSON entries | SEQ-9/SEQ-10, F-090..F-108 |
| IP-8 | config provider | RLM runtime | interpreter path, caps, depth | F-250..F-258 |
| IP-9 | RLM transport | kernel runner process | JSON-lines ops/frames (execute, interrupt, snapshot names/write/restore, bootstrap, shutdown) | SEQ-12, F-001..F-018 |

### Lifecycle Paths

| Component | INIT (created/started by) | CLEANUP (stopped/released by) |
|-----------|--------------------------|-------------------------------|
| Kernel process | kernel manager, lazily on first tool call | kernel manager on session dispose; SIGINT→TERM→KILL escalation |
| Ledger | runtime module on import/access | none (append/update durable file) |
| Child session | host on `rlm.run` admission | host on completion/cancel; parent teardown cascades |
| Snapshot timer | kernel manager after execute | unref'd on dispose |
| Bridge comm | runtime on first host_request | closed on settle / kernel shutdown |

## 4. Requirements (material = `rlm-feature-reference.md`; each ID below IS its row)

| REQ | Statement (IEEE-29148) | Failure Mode |
|-----|-------------------------|--------------|
| REQ-RLM-0001 | omp frontend SHALL observe that omp's existing eval kernel, prompts, and per-turn context semantics remain exactly as pre-port behavior. | FAIL FAST — port diff gate; any behavior drift fails CI |
| REQ-RLM-0002 | RLM plugin SHALL provide the model an additional RLM tool with schema and description per F-020/F-021/F-022. | F-237 |
| REQ-RLM-0003 | Kernel manager SHALL implement kernel lifecycle per F-001..F-018 with the exact constants listed (5000 ms readiness/ports, 65536-char cap, 1000 ms abort grace, 5000 ms busy budget, 200 ms shutdown grace, 1024-char stderr tail). | F-223/F-224 |
| REQ-RLM-0004 | Kernel manager SHALL enforce the msg_id execution rule (F-005) and serialized execution (F-004). | F-221 |
| REQ-RLM-0005 | TypeScript host SHALL apply the model-facing prompt contract F-040..F-062 through the tool prompt/description surface. | F-166 |
| REQ-RLM-0006 | Python runtime SHALL expose the rlm API per F-070..F-082 (frozen dataclasses, control-channel comm, call_soon_threadsafe futures, callable module, 19-name __all__). | F-226 |
| REQ-RLM-0007 | Python runtime SHALL implement the harness ledger per F-090..F-108 (4 kinds, CRUD, save-on-mutate, mtime re-sync, overview truncation, corrupt-file tolerance). | F-108 |
| REQ-RLM-0008 | TypeScript host SHALL implement rlm.run recursion per F-110..F-133 (depth gate, kwargs whitelist, name validation, exact-selector model resolution or fail-loud, sub-8hex dirs, admission handles, parent-inbox replies, terminal notices, usage attribution). | F-228/F-229 |
| REQ-RLM-0009 | TypeScript host SHALL implement the subagent registry per F-140..F-147 (status enum, delete outcomes, tombstone, persistence across restart/compaction). | F-233/F-234 |
| REQ-RLM-0010 | TypeScript host SHALL register all conditional host handlers per F-150..F-166 with real backing machinery; TypeScript host SHALL port the four engines omp lacks (refine loop, heartbeat scheduler, agent_message routing bus, agent_observe reader) from prime-agent's implementations, and TypeScript host SHALL answer with the exact string of F-166/F-220 only when the User disables a capability through configuration. | F-220 |
| REQ-RLM-0011 | Kernel manager SHALL implement state snapshot/revival per F-170..F-183 (dill+json, atomic, 256MiB cap, skip-set, manifest v1, restore-before-bootstrap, revival/compaction notices). | F-174 |
| REQ-RLM-0012 | TypeScript host SHALL bootstrap the kernel environment per F-190..F-208 including the FULL extras set F-192 (requests, httpx, pyyaml, tomli, python-dotenv, pandas, numpy, scipy, beautifulsoup4, lxml, pydantic, tyro) and the credential boundary F-207. | F-198/F-239 |
| REQ-RLM-0013 | Python runtime, Kernel manager, and TypeScript host SHALL each enforce the failure taxonomy F-220..F-240 with exact strings at the layer the reference assigns. | default CL15-A fail fast |
| REQ-RLM-0014 | TypeScript host SHALL expose the config surface F-250..F-258 (depth defaults 0/1, model-search limits 8/20, name ≤64) as omp settings/plugin-schema fields. | F-228 |
| REQ-RLM-0015 | RLM plugin SHALL hold paradigm features P-001..P-013 where the reference implementation realizes them; sub-LLM token accounting P-005 SHALL map to child usage attribution (F-131) at the omp transcript level. | F-131 |
| REQ-RLM-0016 | RLM plugin SHALL realize Continual-Harness features CH-001..CH-018 only where they are requirements of THIS port (the RLM capability); the RLM plugin SHALL record CH features outside RLM scope (co-learning training loops, emulator benchmarks) as out-of-scope instead of silently dropping them. | F-220 semantics |
| REQ-RLM-0017 | Python runtime SHALL respect component ownership A-001..A-014, including the trust boundary per A-012. | F-208 |
| REQ-RLM-0018 | Python runtime SHALL NOT run an agent loop. | F-208 / A-008 |
| REQ-RLM-0019 | RLM plugin SHALL spawn the real kernel runner process with the bootstrap interpreter (REQ-RLM-0012) and speak JSON-lines-over-stdio with it (execute, interrupt, snapshot names/write/restore, bootstrap, shutdown ops; readiness within 5000 ms; SIGTERM then SIGKILL teardown), and RLM plugin SHALL ship that runner as dedicated Python inside packages/rlm/. | F-223/F-224 |
| REQ-RLM-0020 | Python runtime SHALL wrap each installed Python skill imported into the kernel as a callable module whose `__call__` awaits the skill's `run` and copies its `__signature__`, cached in `sys.modules` (F-026). | installed skill not callable in kernel |
| REQ-RLM-0021 | Python runtime SHALL represent a skill that failed to import with a shim whose repr identifies it as unavailable and whose `run` raises carrying the import error (F-027). | unavailable skill silently missing |
| REQ-RLM-0022 | Python runtime SHALL provide an in-kernel MCP integration that discovers and invokes MCP tools by routing all requests, including credential resolution, through the host bridge (`host_request`), keeping credential and auth-store material host-side (F-080, F-164). | F-220 / credential leak (REQ-N-3) |

### Negative-space (IEEE "shall not")

| REQ | Statement |
|-----|-----------|
| REQ-N-1 | RLM plugin SHALL NOT modify or re-parent omp's existing `eval` tool, its kernel registry, or its runner process semantics. |
| REQ-N-2 | RLM plugin SHALL NOT change what is appended to the main context per turn (no new mandatory main-context sections beyond the tool's own description, which adjoins the existing tool inventory). |
| REQ-N-3 | TypeScript host SHALL NOT expose credentials, auth stores, or non-bounded catalog data to the Python process (F-207). |
| REQ-N-4 | RLM plugin SHALL NOT present the kernel as a security sandbox (F-208); destructive-command blocking belongs to the planned blocker hook, which is out of scope for this port and SHALL NOT be stubbed. |
| REQ-N-5 | TypeScript host SHALL NOT return a child's answer as the `rlm()`/spawn return value (F-049). |
| REQ-N-6 | RLM plugin SHALL NOT ship placeholder, TODO, or stub implementations for any requirement in this manifest. |

## 5. High-Entropy Zones (adjudicated)

| Zone | Question | Resolution | Decided By |
|------|----------|------------|------------|
| Z-1 paper answer-variable | The paper paradigm (P-003/measure P-006) requires the answer via an environment variable and sub-LLM-only tools; prime-agent's implementation flows results through ordinary tool output and exposes full tools in-kernel (F-049). Which is authoritative for this port? | RESOLVED: prime-agent semantics govern; paper answer-variable and tool-demotion recorded as ancestry only. Deferred (future refactor): tight per-call output cap with artifact:// overflow spill. | User: "we stick with prime-agent semantics for z-1" |
| Z-2 conditional-handler scope | F-150..F-166 handlers whose backing capability is missing in omp (refine loop, interval heartbeats, agent_observe, intra-session agent_message): build the missing omp capabilities first, or port the registered-but-unavailable semantics (F-166 string) as the reference itself does when a capability is absent? | Decision (a-full): TypeScript host SHALL implement ALL conditional handlers with real backing machinery; TypeScript host SHALL port the four engines omp lacks (refine loop, heartbeat scheduler, agent_message routing bus, agent_observe reader) from prime-agent's implementations; the F-166/F-220 unavailable-string applies only when the User disables a capability through configuration. | User: "A full. use prime-agent code for capabilities omp does not have. I want ALL capabilities" |
| Z-3 placement | The capability lands as: (A) external CustomTool plugin package (zero core change; ~/.omp/plugins), (B) in-repo `packages/rlm` sibling + memory-backend integration, or (C) second kernel via eval-kernel kind parameterization? All three satisfy REQ-N-1/REQ-RLM-0001. | Decision (B): RLM plugin SHALL live as an in-repo `packages/rlm` sibling package (mnemopi pattern), wired in through omp's own registration surfaces; the RLM plugin SHALL keep all its code inside `packages/rlm/` plus minimal registration touchpoints, with zero edits inside `src/eval/` or core agent files. | User: "Z-3 -> B" |
| Z-4 primitives carried forward | Full OS capability, computer-as-sandbox, keep-all-venv-extras, addition-not-mutation. | Decided | User (verbatim directives quoted in §1) |

## 5.5 Rejected Alternatives

| Decision | Alternative Considered | Why Rejected |
|----------|----------------------|--------------|
| Addition, never mutation | Retrofit offload discipline into omp's existing eval kernel | User directive, verbatim in §1 |
| Host execution, no sandbox | Mount kernel under a sandbox backend | User directive, verbatim in §1 |
| Full extras set | Trimmed dependency set | User directive, verbatim in §1 |
| Main context stays append-only | Replacing main-context composition with kernel pointers | User directive, verbatim in §1 |
| Faithful F-166 absence semantics (Z-2 alt) | (pending adjudication) | — |

## 6. Tool/API Interface Summary

| Interface | Purpose | Mutates State? | Called By | Triggered When |
|-----------|---------|----------------|----------|---------------|
| RLM tool (ipython-equivalent) | one cell of code execution in the persistent kernel | YES (kernel namespace) | model | tool invocation |
| host_request comm | typed host operations from Python | YES (host-side) | runtime shim | bridge calls |
| rlm.run | spawn child session, admit, return handle | YES | model (in-kernel) | delegation |
| ledger CRUD | harness state entries | YES | model via shim | memory ops |
| heartbeat | scheduled session re-entry | NO | host scheduler | interval |
| refine | smallest CRUD edit improving harness | YES | host on schedule/request | turn end |
| snapshot/revive | kernel namespace durability | YES | kernel manager | debounce/dispose/resume |
| goal bridge | persistent objective + budget | YES | host | model request |

## 6.5 Blocking Dependencies

| Unresolved Zone | Blocks |
|-----------------|--------|
| None — all zones adjudicated (Z-1 prime-agent semantics; Z-2 a-full engine ports; Z-3 in-repo sibling) | Contracts phase unblocked |
| IEEE lint hook availability | lint gate — hook at ~/.claude/hooks/ieee29148_manifest_linter.py passing (exit 0, no findings); manifest additionally enforces one-polarity-per-line (no requirement line mixes obligation and prohibition) |

## 7. Failure Mode Specification

Default for every unmet REQ: fail fast with the reference's exact error where the reference defines one (F-220..F-240); otherwise a CL15-A actionable error naming the violated REQ id. Fallbacks exist only where the reference contracts them (F-144 delete-outcome skip, F-095 ValueErrors, F-108 corrupt-file tolerance, F-166 unavailable-type string).

## 8. Completion Promise (Ralph Loop Exit)

> Every REQ above maps to feature IDs implemented with an observing test; the full port is exercised in an assembled real run where the model stores state in the kernel across a compaction and a session resume, and the stored state round-trips with a revival notice in the transcript — with omp's pre-port eval/tool behavior verified byte-equivalent.

## 9. Contract Authority

**Authoritative Source**: `requirements/rlm-feature-reference.md` (behavioral), this manifest (IEEE layer), `contracts/` files produced downstream (CL12 clauses with PRE/POST/INV/ERRORS + SEQ citing IP/SEQ ids from §3.5).

## 10. Revision History

| Date | Author | Change |
|------|--------|--------|
| 2026-08-15 | K. Harris (AI-executed) | Initial manifest from feature reference; Z-1..Z-3 pending user adjudication |
| 2026-08-15 | K. Harris (AI-executed) | Z-1 resolved: prime-agent semantics; output-cap deferred to future refactor. Z-2 resolved (a-full): port all four missing engines from prime-agent. IEEE lint: 0 findings. Z-3 pending |
| 2026-08-15 | K. Harris (AI-executed) | Z-3 resolved (B): in-repo packages/rlm sibling. REQ-RLM-0017 split into 0017/0018 per one-polarity-per-line rule (no requirement line mixes obligation and prohibition). All zones adjudicated; contracts unblocked |
| 2026-08-16 | K. Harris (AI-executed) | Constitutional-refactor re-assessment (slice-4 transport gap): REQ-RLM-0019 added — real kernel spawn + JSON-lines transport + dedicated runner owned by SLICE-4; §3.5 dependency line corrected (bootstrap, not eval resolution); SEQ-12 + IP-9 added. User decision verbatim: "A. ... add the appropriate language to designate this slice for explicitly spawn the real python kernel" |
| 2026-08-17 | K. Harris (AI-executed) | Constitutional-refactor Phase 1 (MCP + in-kernel skills disconnect matrix): REQ-RLM-0020 (skill wrapping F-026), REQ-RLM-0021 (unavailable-skill shim F-027), REQ-RLM-0022 (in-kernel MCP integration, credentials host-side per REQ-N-3, F-080/F-164) added. host_request wire (NDJSON) stays under REQ-RLM-0006 with contract-level semantics. User directive verbatim: "the mcp work must be incorporated into the plan... same for the skills" |