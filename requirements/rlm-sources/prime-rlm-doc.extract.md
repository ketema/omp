# RLM Doc — Structured Extraction (Prime Agent `packages/coding-agent/docs/rlm.md`)

Source: `https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent/main/packages/coding-agent/docs/rlm.md`. 145 lines, 6993 bytes, fetched via open-search_fetch-page (has_more=false), verified byte-identical to the remote via curl (SHA-256 `7e88409a3f3ce0ef6b8f470ab7bc63906e4301930b63f52f5c127997819b1fce`).

## Model-facing contract

- [ ] One built-in model tool: `ipython` (a persistent IPython kernel). File read/edit, project commands, result transforms, skills, and delegation all start from the kernel — no separate built-in tool per capability.
- [ ] Python state survives tool calls AND compaction: variables, imports, functions, parsed results, task handles persist across turns.
- [ ] Project commands run in-cell via `%%bash` (e.g. `npm run check`).
- [ ] Each `%%bash` cell = temporary subshell; Python state and `%cd` changes persist.
- [ ] Extensions MAY add custom tools, but built-in RLM does not require them.
- [ ] Model = "parent model" working inside the kernel; TypeScript host owns provider calls, session persistence, child lifecycles, scheduling, safety policy.
- [ ] IPython is the model-facing programming surface (control environment, not a sandbox).

## RLM loop (mermaid diagram facts)

- [ ] task → parent → "IPython call" → kernel.
- [ ] kernel ↔ data (inspect/search/transform); kernel ↔ skills (call functions); kernel → child agents (spawn focused work); children → parent (agent messages · files); kernel → parent (admission handle); parent → answer.
- [ ] Parent context stays focused; Python holds working state; children receive only subtask-needed context.

## Core invariant 1 — execution is programmatic

- [ ] All capabilities begin from the persistent kernel, not separate tool calls.
- [ ] `%cd` persists in kernel (bash cells do not).

## Core invariant 2 — subagents are native RLM calls

- [ ] Preloaded callable `rlm` object; spawn: `handle = await rlm("task", name="...")`.
- [ ] Returns immediately after task admission with a child handle; never waits for nor returns the answer.
- [ ] TS host creates a normal child `AgentSession` (independent context + session dir).
- [ ] Child inherits parent's model, provider config, skills, tools, retry policy, resource loader — unless another configured model is requested.
- [ ] Spawn multiple children in separate calls; end turn instead of awaiting completion.
- [ ] Results arrive ONLY via explicit `agent_message` replies or files, never as `rlm()` return value.
- [ ] Child→parent: `await agent_message.send(message, receiver_role="parent")`.
- [ ] Parent→retained child: `await agent_message.send(text, receiver_role="child", receiver_name=<child name>)`.
- [ ] Child handle/licycle:
  - [ ] Admission handle exposes `rlm_child_id`, `name`, `session_dir`, `model`.
  - [ ] Child usage attributed to parent session; distinguishable in context-tree reporting.
  - [ ] Parent-scoped child registry survives compaction, kernel restart, parent restoration: `await rlm.list_subagents()` → per-child `session_name`, `status`, `active_session_id`.
  - [ ] Completed daemon-backed children stay addressable while parent session open; delete via `await rlm.delete_subagent(child)` when context unneeded.
  - [ ] Default recursion depth: root may create children; raising configured depth lets descendants recurse further.

## Core invariant 3 — skills add programmatic capability

- [ ] Supports Agent Skills markdown format + Python-backed skills extension.
- [ ] Both use `SKILL.md` for discovery, routing, instructions.
- [ ] Python-backed skill = SKILL.md + Python package installed into kernel env, exposed by import name. e.g. `report = await release_audit(repository=".", target_version="0.4.0")`.
- [ ] Python-backed skills are a superset: guidance, scripts, references, dependencies, typed callables, optional shell commands; may themselves call `rlm(...)` for recursive delegation.
- [ ] Startup prompt gets only skill METADATA; full SKILL.md loaded on task match, then documented Python API is inspected/called.
- [ ] See skills.md for discovery/packaging/skill-creation workflow.

## Core invariant 4 — state outlives one turn

- [ ] Automatic compaction summarizes older context; preserves recent messages + kernel state.
- [ ] Daemon-backed workers keep active sessions running after clients detach.
- [ ] Child registries + session artifacts make subagents recoverable.
- [ ] Heartbeats + scheduled prompts re-enter a session later.
- [ ] Persistent goals continue until objective complete or user changes their state.
- [ ] Autonomous mode adds bounded continuations + optional quality gates.
- [ ] Details: long-running-agents.md.

## Host Bridge

- [ ] Python skills use typed host requests for capabilities whose authoritative state lives outside the kernel.
- [ ] `goal`, `agent_message`, `rlm_heartbeat`, `compact` skills call `rlm.host_request(...)`.
- [ ] TS host validates request and owns the state transition.
- [ ] Keeps out of Python: credentials, provider execution, transcript writes, worker routing, scheduling — while retaining programmatic model interface.

## Trust Model / safety

- [ ] Kernel runs model-generated Python + project commands with the worker's OS permissions.
- [ ] It is a durable control environment, NOT a security sandbox.
- [ ] Review third-party Python skills; use an external sandbox/restricted environment for untrusted repositories and instructions.
- [ ] Implementation details: rlm-runtime.md.

## Env / config surface mentioned

- [ ] No environment variables documented in this file.
- [ ] Config-ish knobs referenced: recursion depth (configurable), configured alternate models per `rlm()` call, provider configuration inheritance, retry policy, resource loader.
- [ ] APIs surfaced: `rlm(...)`, `rlm.list_subagents()`, `rlm.delete_subagent()`, `rlm.host_request(...)`, `agent_message.send(...)`, skill import-name callables.

## Remote-vs-local differences

- **IDENTICAL.** Remote (raw.githubusercontent.com / main) and local `/Users/kharri04/projects/prime-agent/packages/coding-agent/docs/rlm.md` diff clean (exit 0) and share SHA-256 `7e88409a…`. No content drift.

## Fetch mechanics notes

- [ ] open-search_fetch-page: first fetch returned `has_more=false`, `total_size=6864`; single chunk, no `===CHUNK-BOUNDARY===` markers needed.
- [ ] Actual served file is 6993 bytes (curl-verified); `total_size` metadata is the fetch layer's own count and disagrees with the true byte count — the fetched CONTENT matched the document; canonical bytes were re-fetched via curl for the .full.txt archive.