# Disconnect Matrix — REQ-2026-SPAWN-MODEL

Observation of HEAD `576fed41a8` in worktree `restore-spawn-model`. Code reading is not observation; schema and spawn call sites were executed as `git show` / file reads of live HEAD. Live spawn RED/GREEN will re-observe.

| ID | Behavior | EXPECTED | OBSERVED | DELTA | Location |
|----|----------|----------|----------|-------|----------|
| B1 | Task optional `model` | Non-empty selector forwarded as `request.model` | Wire `"+": "delete"`; no `"model?"`; `#runSpawn` omits `model` | OVERRIDE | `src/task/types.ts`, `src/task/index.ts` |
| B2 | Eval `agent()` optional `model` | Same forward | `agentArgsSchema` deletes unknown keys; no `"model?"`; `runEvalAgent` omits `model` | OVERRIDE | `src/eval/agent-bridge.ts`, preludes |
| B3 | Omit `model` | On-disk: overrides → frontmatter → default role | Host already does this when `request.model` is absent | KEEP | `src/task/structured-subagent.ts` |
| B4 | Selector `default` | On-disk `default` role | `requestModel` path expands roles; agent-frontmatter `default` still means session inherit. Do not add request-path parent inherit. | OVERRIDE if request path inherits; else KEEP resolver request path | `src/config/model-resolver.ts` |
| B5 | Settings gate | None | Absent on this fork; PR #10901 would add `task.enableModel` default false | REMOVE (do not add) | N/A on this fork |
| B6 | Julia `model=` | Accept and forward | Rejects leftover `model` kwarg (`76f04c4c77` is upstream-only; verify this fork) | OVERRIDE if reject exists | `src/eval/jl/prelude.jl` |

IP-1, IP-2, IP-3 have falsifiable SEQ clauses (SEQ-1..3).
