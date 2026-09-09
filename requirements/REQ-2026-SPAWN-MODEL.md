# REQ-2026-SPAWN-MODEL: Restore Per-Invocation Subagent Model

**Status**: Approved
**Scope**: Restore optional `model` on `task` spawn and `eval agent()`. Omit uses on-disk configuration. No settings gate.

## CCABDD Governance

Human owns: intent (front) + reality judgment (back).
AI owns: enforcement (middle).
Neither crosses the boundary.

Human MUST confirm real-world effect matches intent.
AI MAY NOT infer success from metrics.

## Actors

| Actor | Identifier |
|---|---|
| Operator | Human who names an explicit model or omits it |
| Task tool | `packages/coding-agent/src/task/index.ts` TaskTool |
| Task wire schema | `packages/coding-agent/src/task/types.ts` |
| Eval agent helper | `eval` `agent()` across JS/Python/Ruby/Julia preludes |
| Eval agent bridge | `packages/coding-agent/src/eval/agent-bridge.ts` |
| Structured subagent host | `packages/coding-agent/src/task/structured-subagent.ts` `runStructuredSubagent` |
| Model resolver | `packages/coding-agent/src/config/model-resolver.ts` `resolveAgentModelSelection` |
| On-disk configuration | Agent frontmatter, `task.agentModelOverrides`, model-role table including `default` |

## 1. Intent Traceability

- **Source Prose**:
  > "see if you can use git to restore the per model invocation of sub agents"
  > "if provided, attempt that provider/model; if omitted, on-disk config decides"
  > "yes I accept that. KISS. plan approved. execute"
  > (acceptance of: no `task.enableModel` gate; `"default"` is the on-disk default role, not the parent session model)

- **Our Understanding**: Task and eval `agent()` expose optional non-empty model selector or fallback chain. Supply means the host attempts that selector. Omit means on-disk configuration. No settings switch hides the field. Obligations live in §4.

- **Ambiguity Score**: 0

## 2. The Actor Matrix

| Actor | Permission Level | Prohibited Actions |
|:------|:-----------------|:-------------------|
| Operator | Supplies or omits `model` on a spawn | Operator SHALL NOT be required to flip a settings switch to name a model. |
| Task wire schema | Declares optional `model` on the live wire | Task wire schema SHALL NOT drop a supplied `model` as an unknown key. |
| Task tool | Forwards spawn arguments to the host | Task tool SHALL NOT swallow a valid supplied `model`. |
| Eval agent helper | Accepts optional `model` on `agent()` | Eval agent helper SHALL NOT reject a valid supplied `model` as a removed keyword. |
| Eval agent bridge | Forwards parsed `model` to the host | Eval agent bridge SHALL NOT strip a valid supplied `model`. |
| Structured subagent host | Passes `request.model` as `requestModel` | Structured subagent host SHALL NOT ignore a present `request.model`. |
| Model resolver | Resolves `requestModel` first | Model resolver SHALL NOT treat selector `default` as the parent session model. |
| On-disk configuration | Supplies the omit path | On-disk configuration SHALL NOT be bypassed when `model` is omitted. |

## 3. The State Transition

- **Initial State ($S_0$)**: Task and eval wire schemas delete unknown keys. `model` is absent. Julia `agent()` rejects leftover `model`. The host already honors `request.model` when present.
- **Transformation**: Schemas declare optional `model`. Task tool and eval bridge forward it. Helpers accept it. Resolver treats `default` as the on-disk default role.
- **Terminal State ($S_1$)**: A supplied selector reaches `resolveAgentModelSelection` as `requestModel`. An omitted selector leaves `request.model` unset and uses on-disk configuration.

## 3.5 Integration Specification

### Dependency Graph

Task tool DEPENDS ON Task wire schema for declared `model`.
Eval agent helper DEPENDS ON Eval agent bridge for declared `model`.
Task tool DEPENDS ON Structured subagent host for `request.model`.
Eval agent bridge DEPENDS ON Structured subagent host for `request.model`.
Structured subagent host DEPENDS ON Model resolver for `requestModel` priority.

### Control Flow Requirements (Sequencing Specs)

| ID | Caller | Must Invoke | Temporal Constraint | Breaks If Missing |
|----|--------|-------------|---------------------|-------------------|
| SEQ-1 | TaskTool `#runSpawn` | `runStructuredSubagent` with `model` when present | BEFORE child start | Child ignores the Operator selector. |
| SEQ-2 | `runEvalAgent` | `runStructuredSubagent` with `model` when present | BEFORE child start | Eval child ignores the Operator selector. |
| SEQ-3 | `runStructuredSubagent` | `resolveAgentModelSelection` with `requestModel: request.model` | BEFORE subprocess start | Host never attempts the supplied selector. |

### Integration Points Checklist

| ID | Source | Target | Handoff Data | Contract Clause |
|----|--------|--------|-------------|-----------------|
| IP-1 | TaskTool `#runSpawn` | `runStructuredSubagent` | optional `model` | SEQ-1 |
| IP-2 | `runEvalAgent` | `runStructuredSubagent` | optional `model` | SEQ-2 |
| IP-3 | `runStructuredSubagent` | `resolveAgentModelSelection` | `requestModel` | SEQ-3 |

### Lifecycle Paths

| Component | INIT (created/started by) | CLEANUP (stopped/released by) |
|-----------|--------------------------|-------------------------------|
| Task spawn | Operator or parent agent calls `task` | Child session ends with the spawn |
| Eval `agent()` | Eval cell calls `agent()` | Child session ends with the helper |
| Model resolution | Host preflight | Resolution is per spawn; no persistent handle |

## 4. Hard Invariants (The "Never" List)

| ID | Category | Invariant |
|----|----------|-----------|
| REQ-SM-001 | Forward | When a task spawn supplies a non-empty model selector or non-empty fallback chain, the Task tool SHALL forward that value to `runStructuredSubagent` as `model`. |
| REQ-SM-002 | Forward | When eval `agent()` supplies a non-empty model selector or non-empty fallback chain, the Eval agent bridge SHALL forward that value to `runStructuredSubagent` as `model`. |
| REQ-SM-003 | Omit | When the caller omits `model`, the Structured subagent host SHALL resolve through on-disk configuration. |
| REQ-SM-003A | Omit | When the caller omits `model`, the Structured subagent host SHALL NOT invent a parent-session override. |
| REQ-SM-004 | Surface | The Task tool SHALL expose optional `model` on the live wire schema. |
| REQ-SM-005 | Default role | When the supplied selector is `default`, the Model resolver SHALL resolve the on-disk `default` role. |
| REQ-SM-005A | Default role | When the supplied selector is `default`, the Model resolver SHALL NOT substitute the parent session model. |
| REQ-SM-006 | Validation | The Task tool SHALL reject an empty string or empty array as an invalid model. |
| REQ-SM-006A | Validation | The Eval agent bridge SHALL reject an empty string or empty array as an invalid model. |
| REQ-SM-007 | Schema | The Task wire schema SHALL declare `model`. |
| REQ-SM-007A | Schema | The Eval agent bridge schema SHALL declare `model`. |
| REQ-SM-007B | Schema | The Task wire schema SHALL NOT drop a supplied `model` via unknown-key deletion. |
| REQ-SM-007C | Schema | The Eval agent bridge schema SHALL NOT drop a supplied `model` via unknown-key deletion. |
| REQ-SM-008 | KISS | The Task wire schema SHALL NOT introduce a settings key that hides `model`. |
| REQ-SM-009 | Eval helpers | JS, Python, Ruby, and Julia `agent()` helpers SHALL accept optional `model`. |
| REQ-SM-009A | Eval helpers | JS, Python, Ruby, and Julia `agent()` helpers SHALL forward `model` when present. |

## 5. High-Entropy Zones (Adjudicated)

| Zone | Question | Resolution | Decided By |
|------|----------|------------|------------|
| Settings gate | Hide `model` behind `task.enableModel`? | No gate. KISS. | User |
| Bare `default` | Parent session or on-disk default role? | On-disk default role. | User |
| Omit path | What happens when `model` is absent? | On-disk configuration. | User |
| Restore method | Cherry-pick upstream or refactor? | Constitutional-refactor on this fork. | User |

## 5.5 Rejected Alternatives

| Decision | Alternative Considered | Why Rejected | Decided By |
|----------|----------------------|--------------|------------|
| Always-on `model` | `task.enableModel` default false (upstream PR #10901) | Second lock on an intended field. | User |
| `"default"` is the default role | `"default"` inherits the parent session (#6438 / PR #10901) | Silent parent hijack. | User |
| Fork refactor | Merge upstream PR #10901 wholesale | Task-only, gated, parent inherit. | User |
| Full revert of `9f8aa87dbf` | Reverse-apply the 2026-07-24 removal | Patch does not apply after 3434 commits. | User |

## 6. Tool/API Interface Summary

| Interface | Purpose | Mutates State? | Called By | Triggered When |
|-----------|---------|----------------|----------|----------------|
| `task` `model?` | Per-spawn selector | NO | Task tool | Operator or parent agent names a model |
| `agent(..., model=)` | Per-spawn selector | NO | Eval cell | Operator or parent agent names a model |
| `runStructuredSubagent({ model })` | Host request field | NO | Task tool, eval bridge | Spawn preflight |
| `resolveAgentModelSelection({ requestModel })` | Highest-priority resolve | NO | Structured subagent host | Spawn preflight |

## 6.5 Blocking Dependencies

| Unresolved Zone | Blocks |
|-----------------|--------|
| none | none |

## 7. Failure Mode Specification

| Requirement | Failure Condition | Behavior | Notification |
|------------|-------------------|----------|--------------|
| REQ-SM-006 | Empty string or empty array `model` | FAIL FAST | The tool or helper SHALL return an actionable invalid-`model` error. |
| REQ-SM-001 | Named selector has no matching authenticated model | FAIL FAST after exhausting the supplied chain | The host SHALL report resolution failure without silently switching to the parent session solely because the selector was `default`. |
| REQ-SM-009 | Julia leftover `model` kwarg after restore | The helper SHALL accept and forward `model`. It SHALL NOT reject it as a removed keyword. | N/A after restore |

## 8. Completion Promise (Ralph Loop Exit)

A live `task` spawn and a live eval `agent()` call that supply `model: "provider/id"` attempt that selector. The same calls with `model` omitted use on-disk configuration. `model: "default"` resolves the on-disk default role. No `task.enableModel` setting exists.

## 9. Contract Authority

Authoritative Source: `requirements/contracts/spawn-model.contract.ts`

## 10. Revision History

| Date | Author | Change |
|------|--------|--------|
| 2026-09-07 | K. Harris | Approved restore: always-on optional model, omit uses on-disk config, `default` is the default role. |
