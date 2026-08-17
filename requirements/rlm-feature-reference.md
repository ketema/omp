# RLM-REPL Capability — Feature-for-Feature Fidelity Reference

Purpose: the single checklist the omp port must satisfy feature-for-feature. Every ID below is a requirement; the port plan must map each ID to an omp home (native-eval / plugin tool / new package / out-of-scope-with-notice) and every implemented ID to a test that observes it. No ID may be silently dropped — dropped IDs are recorded as adjudicated decisions.

Consumed byte-complete via RLM relays (each source read to EOF; raw copies + merged extracts archived under `requirements/rlm-sources/`):

| Source | Content | Annexes |
|---|---|---|
| https://arxiv.org/html/2605.09998v1 (also abs page) | **Continual Harness** paper — agents editing their own harness state (prompt, sub-agents, skills, memory) via a Refiner, reset-free co-learning, Pokémon. NOT the REPL/RLM paper. | `arxiv-2605.09998.raw.txt` (72,231 B), chunk files, `arxiv-2605.09998.extract.md` (merged, 195 typed lines) |
| https://www.primeintellect.ai/blog/rlm (+ /prime-agent) | RLM paradigm (context-as-variable, REPL + sub-LLMs) and Prime Agent product semantics | `pi-blog-rlm.full.txt` (70,612 B), `pi-blog-rlm.extract.md` |
| …/prime-agent/packages/coding-agent/docs/rlm.md (remote=local, byte-identical) | Model-facing RLM contract + design invariants | `prime-rlm-doc.full.txt`, `prime-rlm-doc.extract.md` |
| …/prime-agent/packages/coding-agent/docs/architecture.md + docs/rlm-runtime.md (remote=local, byte-identical) | Component ownership, kernel lifecycle, delegation flow, artifact layout | `architecture.remote.md`, `rlm-runtime.remote.md`, `prime-architecture.extract.md` |

Line-level citations in PART I come from the prime-agent source clone at `/Users/kharri04/projects/prime-agent` (packages/coding-agent/src/core/*, prime-agent-runtime/src/rlm/*). The MIT RLM paper (arXiv 2512.24601) is referenced by the blog; its mechanics are captured in PART II via the blog's account — consume it byte-complete as a follow-up annex if the port wants its exact system prompt.

---

## PART I — Prime Agent RLM/IPython implementation checklist

Source shorthand: AS=agent-session.ts, KI=kernel/index.ts, IP=tools/ipython.ts, PR=prompts/rlm.ts, RR=rlm-runtime.ts, BT=kernel/bootstrap.ts, FS=kernel/fork-server.ts, SS=kernel/state-snapshot.ts, MM=mcp/mcp-manager.ts, RI=rlm/__init__.py, RH=rlm/harness.py, PT=prime-agent-runtime/pyproject.toml, RD=docs/rlm.md, RT=docs/rlm-runtime.md.

### 1. Kernel runtime core

| ID | Feature | Detail | Source |
|---|---|---|---|
| F-001 | Lazy kernel start | Created on first IPython call; provisioner memoizes in-flight startup, clears memo on failure | IP:331–449 |
| F-002 | Prewarm | Background `prewarm()`; failures swallowed, surfaced next `ensure()`; only rlmDepth 0 agents prewarm | IP:357–359; AS:480 |
| F-003 | Readiness probe | `kernel_info_request` with msg_id match, READY_TIMEOUT_MS=5000; ports resolve within 5000 | KI:27–28,767–801 |
| F-004 | Serialized execution | `execute()` queue serializes cells; kernel single-threaded; tool executionMode "sequential" | KI:803–843; IP:631–632 |
| F-005 | msg_id rule | IOPub output accepted only when parent_header.msg_id == active execution; comm messages bypass filter | KI:979–988 |
| F-006 | Output caps | 65536 chars per stdout/stderr/result, truncation marker `[... output truncated at N chars ...]` | KI:31,1000–1071 |
| F-007 | Snapshot cell cap | Internal snapshot/restore/list cells use 1,000,000-char cap | KI:37,1410 |
| F-008 | Abort grace | interrupt on control, then force-resolve "aborted" after 1000 ms | KI:41,891–940 |
| F-009 | Busy reuse | Wait ≤5000 ms, re-interrupt every 500 ms, else KernelBusyAfterInterruptError | KI:42–43,1168–1187 |
| F-010 | Busy error text | "IPython kernel is still running the previously interrupted cell. Wait and try again, or kill the IPython kernel to start fresh." | KI:45–46 |
| F-011 | Shutdown grace | shutdown_request {restart:false} + 200 ms, then process kill fallback | KI:1362–1375 |
| F-012 | Dispose | 5000 ms wait for in-flight host requests, close sockets, kill, rm temp | KI:32,1500–1516 |
| F-013 | Dead-kernel replacement | `restart()` = shutdown → idle → start; forked kernels polled 1000 ms | KI:35,718–743,1377–1393 |
| F-014 | Failed-start retry | Failed startup clears memo so next ensure retries fresh; boot permit covers spawn/ports only | IP:436–444; KI:545 |
| F-015 | Signal-safe teardown | beforeExit/SIGINT(130)/SIGTERM(143) flush snapshot; exit uses disposeSync | KI:483–507 |
| F-016 | Unused-slot pruning | dispose aborts queued boot; startup failure cleans ZMQ + temp dir | IP:373–391,527–529 |
| F-017 | Stderr tail | Bounded 1024-char kernel stderr tail in resolve/ready errors | KI:749,761 |
| F-018 | Connection file | Temp dir, loopback TCP, HMAC-SHA256, key 0600; removed teardown | KI:451–468 |

### 2. Model-facing tool surface

| ID | Feature | Detail | Source |
|---|---|---|---|
| F-020 | Tool name/schema | `ipython`; single param `code: string`; description states persistent kernel + project env | IP:143–148,626–630 |
| F-021 | Execution mode | "sequential" | IP:631–632 |
| F-022 | promptSnippet | "ipython - persistent agent notebook for Python scratchpad code and %%bash orchestration" | IP:630 |
| F-023 | NO_COLOR bootstrap | `NO_COLOR=1`, `get_ipython().colors="nocolor"` | IP:24–29 |
| F-024 | nest_asyncio guard | `nest_asyncio.apply()` in try/except | IP:31–35 |
| F-025 | rlm import shim | Import failure installs `_PrimeAgentMissingRlm`; every call raises RuntimeError with kernel-venv/PRIME_AGENT_KERNEL_PYTHON guidance | IP:37–67 |
| F-026 | Skill wrapping | Imported skills wrapped as callable modules (`__call__` awaits `run`, copies `__signature__`); cached in sys.modules | IP:84–139 |
| F-027 | Unavailable-skill shim | `<unavailable Python skill ...>` repr; `run` raises with import error | IP:91–107 |
| F-028 | Busy-kernel UI | Non-UI = auto-cancel; choices exactly "Wait and preserve state" / "Kill kernel and restart" with state-loss warning | IP:150–156,547–564 |
| F-029 | Restart notice | `[ipython_kernel_reset]…variables…no longer available…[/ipython_kernel_reset]` only after interrupt→kill→restart | IP:157–161,673–675 |
| F-030 | Working messages | "Starting IPython kernel...", "Restoring IPython state...", "Preparing IPython runtime..." | IP:494–518,634–701 |
| F-031 | Result shaping | stdout⊕stderr⊕result⊕traceback; details: durationMs/status/errorEname/diffs/attachments/sentAgentMessages/kernelRestarted | IP:667–696 |
| F-032 | isError | true iff status "error" or "aborted" | IP:695 |

### 3. Model-facing prompt contract (prompts/rlm.ts)

| ID | Feature | Detail | Source |
|---|---|---|---|
| F-040 | Notebook framing | "long-lived notebook: persistent control environment for reasoning, context management, state, tool orchestration"; keep state across turns/compaction | PR:15 |
| F-041 | External-runtime rule | Never assume IPython is the investigated system's native runtime | PR:17 |
| F-042 | %%bash rule | `%%bash` must be first cell line; avoid `!cmd` escapes | PR:19 |
| F-043 | No-kernel-install rule | Don't install into kernel for a project; use project commands, `uv run` | PR:21,146 |
| F-044 | Named-variables rule | Always assign read/search results to named variables | PR:23,146 |
| F-045 | Bash-throwaway warning | %%bash state (cd/export/source/vars) does NOT carry; use `%cd`, `os.environ[...]`, `%env` | PR:25 |
| F-046 | Persistence enumeration | "named variables, helper functions, classes, imports, notes, parsed outputs, and helper data structures" persist | PR:27 |
| F-047 | Harness API text | Full 14-method CRUD list + record_refinement/overview; `global_=True` wording | PR:29 |
| F-048 | Terminology | Harness = persisted prompt/memory/skill/subagent layer; RLM = runtime/kernel/call interface | PR:31 |
| F-049 | RLM call contract | Skills pre-imported; no `call_skill()`/`run_subagent()` wrappers; replies never returned as rlm() value | PR:33 |
| F-050 | rlm() call | `await rlm('sub-task')` returns admission handle {rlm_child_id,name,session_dir,model}; never waits | PR:129 |
| F-051 | Child naming | `name` unique among siblings; omitted → host-generated readable name | PR:130 |
| F-052 | Model selection | Child inherits parent model; `find_models()` + exact selector otherwise; unavailable model fails spawn | PR:131 |
| F-053 | agent_message replies | `agent_message.send(receiver_role='parent')`; follow-ups role 'child' + receiver_name; `list_agents()` | PR:134–136 |
| F-054 | list_subagents fallback | `await rlm.list_subagents()` recovers handles after restart/compaction | PR:139,187 |
| F-055 | agent_observe | Observe child rollouts; restricted to parent/siblings/direct children; relay via intermediate child | PR:117–123,141–147 |
| F-056 | Spawn-and-end-turn | Spawn independent children in separate calls, end turn; `delete_subagent(child)` to delete direct child | PR:148–150 |
| F-057 | refine.run doctrine | Evidence-backed small update; returns immediately; runs at turn end | PR:155–159 |
| F-058 | Child doctrine | depth>0: "You are a child agent spawned by <parent>"; tasks labeled `[task from parent]`; reply only when needed | PR:43–58 |
| F-059 | Budget block | Working dir / conversation log path / recursion depth / pre-installed package labels / uv pip note | PR:71–80 |
| F-060 | Skill introspection | `help(<skill>)`, `dir(<skill>)`, `inspect.signature(...)`; skills as shell commands `<skill> --help` | PR:94–104 |
| F-061 | edit-skill snippet | Exact old/new string replace example when edit skill present | PR:106–110 |
| F-062 | Delegation guidance | When→Why→menu subagent guidance; parallel context-heavy/independent work, inline for single lookup | PR:174–198 |

### 4. Python-side rlm module API

| ID | Feature | Detail | Source |
|---|---|---|---|
| F-070 | Dataclasses | frozen `RLMSpawnHandle`(rlm_child_id,name,session_dir,model), `RLMModel`(provider,id,name,selector), `RLMSubagent`(rlm_child_id,active_session_id,session_id,session_name,session_dir,status); session_dir as Path | RI:27–51 |
| F-071 | host_request | Comm target `"host.request"`; type injected last so payload cannot reroute; bad types → TypeError | RI:84–140 |
| F-072 | Comm on control channel | control_handlers "comm_msg"/"comm_close" | RI:53–64 |
| F-073 | Future resolution | `loop.call_soon_threadsafe()` resolves ok/error/unexpected; comm closed on settle | RI:104–135 |
| F-074 | run(prompt,**kwargs) | non-str prompt → TypeError; sends rlm.run {prompt,kwargs} | RI:143–151 |
| F-075 | find_models(query="",limit=8) | str/int type checks; host may override limit | RI:166–176 |
| F-076 | list/delete_subagents | delete accepts str or RLMSubagent; empty target ValueError | RI:179–230 |
| F-077 | Handle validation | bad spawn handle → RuntimeError "rlm.run returned an invalid spawn handle" | RI:67–81 |
| F-078 | Callable module + object | module class swapped to `_CallableModule`; `rlm` instance exposes run/find_models/list_subagents/delete_subagent | RI:284–313 |
| F-079 | Harness proxy | Per-access env resolution (forkserver-safe); resolution never raises | RI:233–281 |
| F-080 | Lazy MCP exports | McpIntegration/McpToolError/NotEnabled via `__getattr__` | RI:336–346 |
| F-081 | __all__ | 19 exports (HarnessEntry, HarnessScope, HarnessState, McpIntegration, McpToolError, NotEnabled, RLMModel, RLMSpawnHandle, RLMSubagent, RefinementEvent, delete_subagent, find_models, get_harness_state, harness, host_request, list_subagents, rlm, run) | RI:315–334 |
| F-082 | Package deps | ipykernel, nest-asyncio, tyro; python >=3.10 | PT:5–10 |

### 5. Harness ledger

| ID | Feature | Detail | Source |
|---|---|---|---|
| F-090 | Kinds | prompt / memory / skill / subagent | RH:18 |
| F-091 | Scope | local / global; local default | RH:19 |
| F-092 | HarnessEntry fields | id, kind, title, content, path="general", scope, reference, arguments, metadata, source="agent", created_at, updated_at, version=1 | RH:93–109 |
| F-093 | RefinementEvent | id, trigger, changes, evidence, outcome, created_at | RH:112–121 |
| F-094 | CRUD per kind | create/update/delete_memory|_skill|_subagent|_prompt_note | RH:530–674 |
| F-095 | Create-if-absent rules | duplicate id on create → ValueError "already exists"; missing on update/delete → ValueError; unknown kind → ValueError | RH:361–363,467–471,514–518 |
| F-096 | Save-on-mutate | Every upsert/delete/refinement saves immediately | RH:399,423,701 |
| F-097 | ID slugs | slugified title, alnum/underscore, ≤80 chars | RH:31–34,364 |
| F-098 | mtime re-sync | Reload when on-disk st_mtime_ns ≠ loaded stamp (host /refine safe) | RH:178–196 |
| F-099 | Update preservation | Omitted path/reference/arguments/metadata preserved; version+=1, updated_at bumped | RH:366–384 |
| F-100 | File locations | local: RLM_HARNESS_STATE_DIR or RLM_SESSION_DIR/"harness", else raise; global: RLM_GLOBAL_HARNESS_STATE_DIR or ~/.prime/agent/harness/harness_state.json | RH:77–90 |
| F-101 | Agent dir | PRIME_AGENT_CODING_AGENT_DIR › PI_CODING_AGENT_DIR › ~/.prime/agent | RH:37–43 |
| F-102 | global routing | `global:` kwarg + `[local:id]`/`[global:id]` prefixes | RH:46–67 |
| F-103 | Skill reference contract | repo:"$tmp" reference: type "python" + import + callable/call_pattern required | RH:128–139 |
| F-104 | overview() | 20 entries/kind max, +N more marker, 120-char truncation, `[scope:id] title (path, vN)` lines, last 5 refinements | RH:721–768 |
| F-105 | record_refinement | id `refine_0001…`; plan_refinement prompt-renderable | RH:676–719 |
| F-106 | snapshot() | Dict view for host /refine rollback | RH:770–782 |
| F-107 | Schema/globals | File schema 1; `global_=True` kwarg (global is reserved) | RH:290; PR:29 |
| F-108 | Corrupt-file tolerance | Unreadable/non-dict JSON → empty state; next save rewrites cleanly | RH:203–213 |

### 6. Recursion / rlm.run

| ID | Feature | Detail | Source |
|---|---|---|---|
| F-110 | Depth gate | `RLM_DEPTH >= RLM_MAX_DEPTH` → "RLM recursion depth limit reached (RLM_DEPTH=N, RLM_MAX_DEPTH=N)" | AS:9617–9621 |
| F-111 | Kwargs whitelist | Only name/model; else "Unsupported rlm.run kwargs: <sorted>" | AS:9609–9613 |
| F-112 | prompt must be string | "rlm.run prompt must be a string" | RR:154–155 |
| F-113 | Name validation | string/trim/non-empty/≤64; "rlm.run name must be…" | RR:62–77 |
| F-114 | Default name | `subagent-<prompt-slug>-<8-hex>`; NFKD ascii lowercase; fallback "worker" | RR:95–112 |
| F-115 | Reserved names | Pending set + catalog assert; formatAgentSessionNameUnavailable | AS:9622–9630 |
| F-116 | Parent model default | no model kwarg → inherit parent; identity match short-circuits | AS:9577–9589 |
| F-117 | Exact selector | case-insensitive provider/id vs active, non-expired credentials | AS:9564–9595 |
| F-118 | Model unavailable | "Requested subagent model "X" is unavailable, unauthenticated, or expired" | AS:9594 |
| F-119 | Auth preflight | "…failed authentication preflight" | AS:9597–9600 |
| F-120 | find_models validation | query string; limit default 8, int 1..20 | RR:169–179 |
| F-121 | Query ranking | exact(0) › prefix(3+i) › substring(6+i) over provider/id,name; localeCompare tiebreak | RR:122–148 |
| F-122 | Sub-dir naming | `sub-` + 8 hex; unique via mkdir; childNodeId = basename | AS:8881–8896 |
| F-123 | Admission | Await task admission, return handle immediately, never the answer | RT:30; AS:9947–9952 |
| F-124 | Handle integrity | Missing string field → Python RuntimeError | RI:67–81 |
| F-125 | Child seeding | SpawnMessage `spawn:<id>`, content `[task from parent]\n\n<prompt>` | AS:9808–9825 |
| F-126 | Child context | Inherits scopedModels, tools, retry, resourceLoader, modelRegistry, service tier | AS:8937–8958,8968–9035 |
| F-127 | RLM env inheritance | RLM_DEPTH(+1), RLM_MAX_DEPTH, RLM_SESSION_DIR (child dir), RLM_GLOBAL_HARNESS_STATE_DIR, RLM_HARNESS_STATE_DIR in kernel env | AS:8819–8837 |
| F-128 | Async detached | Runtime startup + task run detached; spawn resolves at admission only | AS:9730–9733 |
| F-129 | Terminal notices | completed_without_reply / cancelled / failure → agent replies / prompt-injected | AS:9709–9728,9838–9886 |
| F-130 | Reply tracking | child `_parentReplyCount` diff; reply sets parent flags | AS:8751–8754,9827,9838 |
| F-131 | Usage attribution | Child assistant usage folded into parent assistant turn; persisted | RT:195–204; AS:9757–9781 |
| F-132 | Attribution reapply | On reload aggregate reapplied; context-tree subtracts attributed child usage | RT:205 |
| F-133 | Child disposal | Cancelled parent teardown cancels descendants | RT:264–265; AS:7174,9037–9056 |

### 7. Subagent registry surface

| ID | Feature | Detail | Source |
|---|---|---|---|
| F-140 | list_subagents | Runs + retained + daemon children; hides deleting/detached/cancelled; fields rlm_child_id, active_session_id?, session_id?, session_name, session_dir, status | AS:9084–9164 |
| F-141 | Status enum | running / completed / error; Python rejects others | RR:21; RI:198 |
| F-142 | Attribute semantics | Fold from _activeRlmChildRuns + daemon roster | AS:9105–9162 |
| F-143 | delete selectors | child id / active-session id / session id / name; ambiguous → "RLM subagent selector "X" is ambiguous…" | RR:193–197; AS:9230–9251 |
| F-144 | Delete outcomes | running → {outcome:"skipped_running"}; else tombstone, removed from messaging; transcripts/artifacts kept | RR:36–39; AS:9220–9226 |
| F-145 | Unknown target | "No direct RLM subagent matches "X" in the current parent session" | AS:9179 |
| F-146 | Registry persistence | Daemon-backed children rehydrated from artifact registry across kernel restart/compaction/restore | RT:185–193 |
| F-147 | Stable ids | Child id, active-session id (daemon), session id, dir | RT:187 |

### 8. Conditional host handlers

| ID | Feature | Detail | Condition | Source |
|---|---|---|---|---|
| F-150 | goal.get | Serialized snake_case goal state | `_includeGoals` | AS:2824–2825,8695 |
| F-151 | goal.create | objective string; token_budget integer when provided; active/paused/budget_limited guards | `_includeGoals` | AS:2826–2833,3124–3141 |
| F-152 | goal.complete | "cannot complete goal because this thread has no goal"; sets complete | `_includeGoals` | AS:2835–2836,3144–3159 |
| F-153 | compact.status | tokens/context_window/percent/scheduled | `_includeCompactSkill` | AS:2852–2860 |
| F-154 | compact.run | Schedules only; note "Compaction runs when the current turn ends; you resume automatically afterwards. Continue working normally."; rejections: no active turn / already compacted / session too short | `_includeCompactSkill` | AS:2861–2889 |
| F-155 | refine.status | pending / in_flight | `_autoRefineAllowedForSession()` | AS:2904–2912 |
| F-156 | refine.run | Schedules; note "Refinement runs when the current turn ends; the harness rebuilds the system prompt and resumes you automatically…"; global must be boolean | refine allowed | AS:2913–2956 |
| F-157 | rlm_heartbeat.list | include_inactive bool; heartbeats array | `_rlmHeartbeatController` | AS:2973–2980 |
| F-158 | rlm_heartbeat.create | instruction required string; interval/label optional strings | heartbeat | AS:2981–3002 |
| F-159 | rlm_heartbeat.update | id required; status "pause"/"resume" only; ≥1 field | heartbeat | AS:3003–3041 |
| F-160 | rlm_heartbeat.delete | id required; returns deleted or null | heartbeat | AS:3042–3050 |
| F-161 | agent_message.list_agents | Family = parent/siblings/direct children only | msg controller + visible skill | AS:3067–3070,8725 |
| F-162 | agent_message.send | target/message required strings; receipt {id,message,deliveryStatus,target} | ditto | AS:3071–3082 |
| F-163 | agent_observe list/get/recent | recent: {target, limit, max_chars}; bounded to family | `_agentObserveController` | AS:3088–3122 |
| F-164 | mcp.refresh / mcp.config | refresh throws on failure; config returns resolved url/headers honoring override | `_mcpManager` | MM:158–180 |
| F-165 | model.info | Always-on; {id, provider, input} of current model | always | AS:8689–8694 |
| F-166 | Unavailability | Any unregistered type → `host request type "X" is not available in this session` | — | KI:1262–1265 |

### 9. State snapshot & revival

| ID | Feature | Detail | Source |
|---|---|---|---|
| F-170 | Artifacts | kernel-state.dill + kernel-state.json in artifact dir | SS:14,38–45 |
| F-171 | Atomic write | `<path>.tmp` then os.replace | SS:102–107 |
| F-172 | Per-var dill | Each top-level name independently; single failure skipped+reported | SS:60–100 |
| F-173 | Skip-set | underscore/hidden names + {rlm, asyncio, In, Out, get_ipython, exit, quit, open} | SS:78,87 |
| F-174 | 256MiB cap | DEFAULT_SNAPSHOT_MAX_BYTES=256MiB; over-cap vars reported; drop-on-save not allowed | SS:10–11,96–100 |
| F-175 | Per-var reasons | `TypeName: <exc>` truncated 200 chars in skipped/failed lists | SS:94,185 |
| F-176 | Manifest v1 | {version:1, savedNames, skipped, bytes, pythonVersion, timestamp UTC ISO} | SS:118–125 |
| F-177 | Restore ordering | After start, BEFORE rlm/skill bootstrap overwrite | IP:490–519 |
| F-178 | Revival notice | `<ipython_state_restored>…names available again / starting fresh / could-not-restore…</ipython_state_restored>` | AS:6942–6968 |
| F-179 | Compaction notice | `<ipython_state>Your IPython kernel persisted through compaction…</ipython_state>` (display:false) | AS:6911–6922 |
| F-180 | Debounce | 1500 ms default, unref'd timer | KI:33,1464–1475 |
| F-181 | Dispose flush | shutdown({snapshot:true}) bounded 5000 ms | KI:40,1484–1497 |
| F-182 | Crash flush | beforeExit/SIGINT/SIGTERM → snapshot:true | KI:483–506 |
| F-183 | Names listing | listNamespaceNames for "These names are still defined" detail | KI:1444–1462; AS:6909 |

### 10. Bootstrap & environment

| ID | Feature | Detail | Source |
|---|---|---|---|
| F-190 | Bootstrap schema | version marker 8 in `.bootstrap-version` | BT:14,56 |
| F-191 | Python 3.11 | Required; uv installs first | BT:15,733–734 |
| F-192 | Package list | ipykernel, prime-agent-runtime, dill + extras: requests, httpx, pyyaml, tomli, python-dotenv, pandas, numpy, scipy, beautifulsoup4, lxml, pydantic, tyro | BT:16–35,735–744 |
| F-193 | RUNTIME_READY_CHECK | rlm callable + harness CRUD methods + HarnessEntry fields + no `background` attr | BT:54 |
| F-194 | Runtime identity | SHA-256 of rlm/*.py + pyproject invalidates venv on change | BT:695–719 |
| F-195 | Bootstrap lock | `.bootstrap.lock` dir; stale 30 s without pid; only lockholder rebuilds | BT:56–58,477–498 |
| F-196 | uv install | PATH → ~/.local/bin/uv → TTY confirm; PRIME_AGENT_INSTALL_UV=1/0; `curl -LsSf https://astral.sh/uv/install.sh | sh` | BT:514–543 |
| F-197 | Venv location | PRIME_AGENT_KERNEL_VENV → ~/.prime/agent/kernel-venv → XDG fallback | BT:339–350 |
| F-198 | Bootstrap failure msg | First-time install needs internet; env override skips bootstrap | BT:847–853 |
| F-199 | Python skills install | Topo-sorted editable installs; failure → "Python skill <name> failed to install and will be unavailable" | BT:777–824 |
| F-200 | Forkserver scope | Linux only (unsafe macOS); PRIME_AGENT_KERNEL_FORKSERVER=0 disables | FS:42–47 |
| F-201 | Fork template | One forkserver per interpreter; preimports template; per-kernel env child-side | FS:2–5,331–357 |
| F-202 | Startup-env degrade | PYTHON*/VIRTUAL_ENV/CONDA_PREFIX/__PYVENV_LAUNCHER__ override → ForkServerUnavailable → direct spawn | FS:21–33,347–349 |
| F-203 | Orphan handling | Late pid replies for abandoned sproce requests → SIGTERM orphan | FS:207–218 |
| F-204 | Fork timeouts | READY 30000 ms, SPAWN 10000 ms | FS:17–18 |
| F-205 | Kernel python resolution | PRIME_AGENT_KERNEL_PYTHON (must import ipykernel+runtime+extras) else managed venv | BT:855–886 |
| F-206 | Env injections | RLM_DEPTH, RLM_MAX_DEPTH, RLM_GLOBAL_HARNESS_STATE_DIR, RLM_SESSION_DIR, RLM_HARNESS_STATE_DIR, PRIME_AGENT_CODING_AGENT_DIR | AS:8819–8843 |
| F-207 | Credential boundary | SERPER_API_KEY only when websearch skill loaded; auth store never crosses; bounded model catalog metadata only | AS:8844–8858; RT:253 |
| F-208 | NOT-sandbox statement | Kernel/worker are NOT a security sandbox; external sandbox for untrusted code | README:65–66; RD:141–143 |

### 11. Failure taxonomy (exact strings)

| ID | Error | Trigger | Source |
|---|---|---|---|
| F-220 | `host request type "X" is not available in this session` | unregistered handler | KI:1262–1265 |
| F-221 | "IPython kernel is still running the previously interrupted cell…" | busy after interrupt | KI:45–53 |
| F-222 | "IPython execution aborted" | abort race | IP:163–165 |
| F-223 | "Kernel did not respond to kernel_info_request within 5000ms. stderr tail:…" | readiness timeout | KI:798–801 |
| F-224 | "Kernel did not resolve connection ports within 5000ms. stderr tail:…" | port timeout | KI:761–765 |
| F-225 | "attachment dropped: exceeds 10000000 base64 chars" | oversized attachment; cell forced error | KI:124,1025–1028 |
| F-226 | "rlm.run returned an invalid spawn handle" | bad handle | RI:69 |
| F-227 | "Unsupported rlm.run kwargs: <csv>" | unknown kwargs | AS:9612 |
| F-228 | "RLM recursion depth limit reached (RLM_DEPTH=N, RLM_MAX_DEPTH=N)" | depth | AS:9619 |
| F-229 | "Requested subagent model "X" is unavailable, unauthenticated, or expired" | model | AS:9594 |
| F-230 | "Requested subagent model "X" failed authentication preflight" | auth | AS:9599 |
| F-231 | "Cannot spawn a subagent after its parent was disposed" | disposed parent | AS:9635 |
| F-232 | "RLM child cancelled" | cancellation | AS:9661 |
| F-233 | "No direct RLM subagent matches "X" in the current parent session" | unknown target | AS:9179 |
| F-234 | "RLM subagent selector "X" is ambiguous…" | ambiguous selector | AS:9182,9250 |
| F-235 | "goals are disabled in this session" | goals off | AS:2821 |
| F-236 | "the compact skill is disabled in this session" | compact off | AS:2849 |
| F-237 | "prime-agent-runtime is not installed in this IPython kernel…" | runtime missing | IP:43–50 |
| F-238 | "Python skill <n> is unavailable in this IPython kernel. Import error: …" | skill import fail | IP:97–104 |
| F-239 | "uv is required to set up the Python kernel…" | no uv | BT:524–527 |
| F-240 | Shell-channel deadlock rule | Control channel used for comm replies; shell is serial | RT:114–123 |

### 12. Config surface

| ID | Key | Default | Source |
|---|---|---|---|
| F-250 | RLM_DEPTH | 0 | AS:1310 |
| F-251 | RLM_MAX_DEPTH | 1 | AS:1590 |
| F-252 | PRIME_AGENT_KERNEL_PYTHON | unset (skip bootstrap; must import ipykernel + runtime + defaults) | BT:855–886 |
| F-253 | PRIME_AGENT_KERNEL_FORKSERVER | enabled; "0" disables | FS:42–47 |
| F-254 | PRIME_AGENT_CODING_AGENT_DIR + XDG | harness root | RH:37–43; BT:345–350 |
| F-255 | PRIME_AGENT_KERNEL_VENV | custom venv path | BT:340–342 |
| F-256 | model search limits | DEFAULT 8, MAX 20 | RR:58–59 |
| F-257 | name max length | 64 chars | RR:57,73–74 |
| F-258 | /rlm-max-depth command | validates non-negative integer | AS:10560–10579 |

### 13. Docs-only additions

| ID | Feature | Source |
|---|---|---|
| F-260 | Python skills = superset of SKILL.md-only skills | RD:110–118 |
| F-261 | Only skill metadata in startup prompt; SKILL.md loaded on match | RD:118–120 |
| F-262 | Daemon continuity: sessions, kernels, schedules, subagents survive detach | README:85 |
| F-263 | Heartbeats (/heartbeat, rlm_heartbeat, schedule) re-enter sessions | README:86 |
| F-264 | Autonomous mode: bounded turn/token/time budgets + user gates | README:88 |
| F-265 | /refine never edits immutable base system prompt; snapshots support rollback | README:40 |
| F-266 | Child inherits parent tools + provider retry settings | RT:166–167 |
| F-267 | Only bounded model catalog metadata crosses into Python | RT:253 |
| F-268 | Component ownership: ipython.ts owns bootstrap; agent-session owns policy/usage | RT:62–73 |

---

## PART II — RLM paradigm per the Prime Intellect blog (the REPL semantics)

| ID | Feature | Detail |
|---|---|---|
| P-001 | Definition | RLM lets an LLM use a persistent Python REPL to inspect/transform its input and call sub-LLMs from within the REPL; it never summarizes context — it delegates to Python scripts and sub-LLMs |
| P-002 | Context rot | Motivation: LLM capability degrades as context grows; context folding = keep window short while the rollout grows |
| P-003 | Two load-bearing changes | (1) tools beyond the REPL usable only by sub-LLMs; (2) final answer only via an environment variable |
| P-004 | llm_batch | REPL function to process a batch of prompts in parallel via sub-LLMs |
| P-005 | Sub-LLM-only tools | Environment tools emit too many tokens; main RLM never sees them (token accounting: sub-LLM tokens don't count against main model) |
| P-006 | answer variable | `answer = {"content": "", "ready": False}` initialized per sandbox; content writable/editable across turns; `ready: True` ends the rollout and extracts the answer — "answer via diffusion over the reasoning chain" |
| P-007 | Input split | Prompt enters context directly; extra data programmatic only (visible by printing in REPL) |
| P-008 | REPL output cap | 8192 chars per turn, user-adjustable |
| P-009 | Per-call timeout | 120 s default |
| P-010 | Environments | Isolated sandboxes; pip-anything installable; model told what's installed; stdlib always available |
| P-011 | Recursion depth | Paper's RLM has depth exactly 1 at publication; arbitrary depth listed as future work (prime-agent implements configurable depth, default max 1) |
| P-012 | Prime-agent mapping | Persistent IPython kernel as the RLM REPL; harness state (prompt, sub-agents, skills, memory) as CRUD-able state; heartbeats, goals, refine as the continual layer |
| P-013 | Benchmarks (prime-agent) | ARC-AGI 3: 95.5% RHAE Best@1 (human expert 95.4%); long-context suite + Factorio/Emulator/PMPP-Hard results in annex `pi-blog-rlm.extract.md` |

---

## PART III — Continual Harness paper (arXiv 2605.09998v1) checklist

Full merged extract (195 typed lines) in `rlm-sources/arxiv-2605.09998.extract.md`. Curated spine:

| ID | Feature | Detail |
|---|---|---|
| CH-001 | Harness definition | H = scaffolding between foundation model and environment: system prompt p, sub-agents G, skills K, memory M — editable in place via meta-tools (define_agent, run_code, process_memory) |
| CH-002 | Continual Harness loop | Refiner reads trajectory window for failure signatures every F steps (after warmup W) and applies per-component edits Δ=(Δp, ΔG, ΔK, ΔM); H ← H+Δ mid-episode, never reset |
| CH-003 | Failure signatures | navigation loops, tool-call failures, stalled objectives, missed exploration opportunities |
| CH-004 | Four refinement passes | (1) rewrite prompt p; (2) sub-agents: create for repeated multi-step patterns, edit on failures, delete unproductive; (3) skills: codify successes, repair exceptions; (4) memory: fill gaps, update stale, demote past |
| CH-005 | Monotonic accumulation | Failure signatures persist across passes; refinement quality compounds with episode length (reset-based methods restart accumulation) |
| CH-006 | Late-failure reachability | Targets failures unreachable by reset-based optimization (deep-episode failures) |
| CH-007 | Agent/Refiner share one model | Same M, different invocation context; both edit via the same meta-tool API |
| CH-008 | Co-learning loop | K=256-step rollouts in live-refining harness; pairwise process reward model; low-reward windows relabeled by frontier teacher; soft SFT update; reset-free state carryover between iterations |
| CH-009 | PRM weights | trajectory progress 0.4 + action correctness 0.3 + reasoning quality 0.2 + format compliance 0.1 (online loop); offline GRPO composite action correctness 0.6 / format 0.4 |
| CH-010 | Reset-free claim | Persistent state at end of iteration k loaded as start of k+1; emulator never reset |
| CH-011 | Environments | Pokémon Red/Crystal/Emerald via emulator; observation = frame o_t + ASCII text map m_t (from memory reader; no walkthrough/objectives/pathfinding); actions = 8 buttons {UP,DOWN,LEFT,RIGHT,A,B,START,SELECT}; 120 frames per step |
| CH-012 | Harness conditions | H_min (no components), H_expert (hand-built PokeAgent), H_CH (from-scratch / bootstrap-frozen / bootstrap-updating) |
| CH-013 | Metrics | Milestone progression (PokeAgent Challenge schedule; 31 Emerald milestones) + cumulative button presses as primary cost |
| CH-014 | Results | Emerald from-scratch: 100% milestones at $130 median vs H_min 98% at $215 (~40% cost cut); bootstrap variants 96–100% at $110–$140; Flash-Lite below capability floor (3–13%) |
| CH-015 | Completion record | First AI system to complete multiple Pokémon RPGs (Blue, Yellow Legacy hard mode, Crystal — no lost battle) |
| CH-016 | Emergent behaviors | press_sequence primitive, "Operation Zombie Phoenix" battle plan, notepad truth-tables — authored unprompted via meta-tools |
| CH-017 | Limitations | Capability floor (weakest models can't bootstrap); residual gap in dialogue-heavy gyms/multi-turn battles; co-learning monotonicity not established; harness-as-transferable-unit holds only while agent keeps exercising inherited components; open-source models (≤31B) not yet capable as own teacher |
| CH-018 | Hyperparameters | LoRA r=256 alpha=256 bf16 8K ctx; LR 2e-5 warmup 3% cosine; GRPO G=4, LR 1e-6, β=0.04; online LR 5e-6, stride-8 PRM |

---

## PART IV — Architecture & component ownership (remote rlm.md + architecture.md + rlm-runtime.md)

| ID | Component / invariant | Owns |
|---|---|---|
| A-001 | TUI/headless clients | presentation and input only; never execution |
| A-002 | Daemon supervisor | discovery, routing, worker health, cross-agent message delivery |
| A-003 | Session worker | one per root session tree: AgentSessionRuntime + Scheduler + root kernel + all RLM child runtimes |
| A-004 | AgentSession (TS) | provider calls, queues, tools, compaction, goals, child lifecycles, transcript writes |
| A-005 | KernelManager | Jupyter sockets, framing (multipart `<IDS|MSG>`, HMAC-SHA256), execution serialization, comm dispatch, interrupt, shutdown |
| A-006 | ipython tool | lazy provisioning, namespace bootstrap, output shaping |
| A-007 | rlm-runtime.ts | typed request/spawn-handle validation, model discovery, list/delete |
| A-008 | prime-agent-runtime (Python) | shim only: handle types, callable rlm, harness state; never calls providers, never runs an agent loop |
| A-009 | Delegation sequence | model → ipython call → execute rlm() → kernel → host.request·rlm.run → depth check + model resolve → admit + registry → handle → create child runtime → child loop → agent_message reply → registry update + usage attribution |
| A-010 | Control channel rule | Shell is serial → admission replies go on the control channel; completion via loop.call_soon_threadsafe; child answers never use the comm path |
| A-011 | Artifact layout | ~/.prime/agent/sessions/<root>.jsonl; session-artifacts/<root>/{kernel-state.dill, kernel-state.json, scheduled-jobs.json, harness/harness_state.json, sub-xxxxxxxx/…}; artifacts created only when features used |
| A-012 | Trust boundary | kernel executes model-written Python with worker OS permissions; NOT a sandbox; credentials never cross; only bounded model-catalog metadata enters Python |
| A-013 | Usage attribution | child usage folded into parent assistant turn; `child_usage_attributed` persisted; context-tree subtracts child usage per node |
| A-014 | Registry persistence | Parent-scoped direct-child registry survives kernel restart/compaction/restore; deletion tombstones without erasing transcript/artifacts |

Full 60-line ownership/sequence extract: `rlm-sources/prime-architecture.extract.md`.

---

## PART V — Usage protocol

1. Every PART I/II/III/IV ID is a port requirement. The plan maps each ID to an omp home: `native` (omp already has it — cite omp file:line), `plugin` (built in the omp extension surface), `new` (new code), or `deferred` (explicit adjudicated drop with reason recorded here).
2. `native` IDs get an evidence row (omp source citation + behavior check).
3. `plugin`/`new` IDs get a test that observes the listed detail — specs come from this document, so tests can cite IDs directly (e.g. "F-110 depth gate").
4. Exact strings in PART I §11, constants in §1/§12, and PART II caps are the machine-checkable spine: a port that changes one must record the adjudication.
5. Annexes under `requirements/rlm-sources/` are evidence, not prose; this file is the checklist.

Gaps in archive coverage, declared honestly: arXiv 2512.24601 (RLM paper referenced by the blog) is not yet byte-consumed; consumed sources are the four URLs listed in the inventory.
