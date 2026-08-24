# REQ-RLM-2026-002: Kernel Execute Wall-Clock Timer

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
|-------|------------|
| Kernel manager | Kernel manager |
| RLM transport | RLM transport |
| Model | Model |
| User | User |
| TypeScript host | TypeScript host |

## 1. Intent Traceability

- **Source Prose**:
  > "let's keep scope to just the timer for now. create a bug issue on ketema/omp do not ccabdd-bind to it because projection will fail right now. proceed with the refactor ensuring ccabdd provenance is maintained. This is a new requirement so start with the requirements manifest."
  > Prior diagnosis (verbatim): "no we have to put a limit on the kernel or you will just do it again."
  > Hang evidence: `ipython call_1102100` pending; process exited; session compacted 3 times.

- **Our Understanding**: Kernel manager execute waits without a wall-clock cap. Start and dispose already use 5000 ms caps. Output already uses a 65536-character cap. Time has no cap, so one unbounded cell deadlocks later ipython calls under serialized execution. This requirement adds one timer: interrupt the cell at 30000 ms and settle execute as error. No new tool-schema timeout field. No %%bash expansion.

- **Ambiguity Score**: 1

## 2. The Actor Matrix

| Actor | Permission Level | Prohibited Actions |
|:------|:-----------------|:-------------------|
| Kernel manager | arms execute timer; interrupts on cap; settles execute | Kernel manager SHALL NOT wait without bound for transport execute |
| RLM transport | delivers interrupt to the runner | RLM transport SHALL NOT own the execute timer |
| Model | submits cells through ipython | Model SHALL NOT raise or disable the cap |
| TypeScript host | mounts the kernel manager | TypeScript host SHALL NOT add an ipython schema timeout field in this slice |
| User | confirms real-world effect | User SHALL NOT bypass the cap |

## 3. The State Transition

- **Initial State ($S_0$)**: Kernel manager execute waits until transport execute returns. Ready, ports, and dispose timers exist. Execute has no timer.
- **Transformation**: Kernel manager arms a 30000 ms execute timer before transport execute. At expiry Kernel manager interrupts the cell and settles execute as error.
- **Terminal State ($S_1$)**: Every ordinary execute settles as ok, error, or aborted at or before 30000 ms. A later execute still runs.

## 3.5 Integration Specification

### Dependency Graph

Kernel manager DEPENDS ON RLM transport for execute and interrupt.
RLM transport DEPENDS ON the kernel runner process for SIGINT delivery.

### Control Flow Requirements (Sequencing Specs)

| ID | Caller | Must Invoke | Temporal Constraint | Breaks If Missing |
|----|--------|-------------|---------------------|-------------------|
| SEQ-1 | Kernel manager executeInternal | execute timer arm | BEFORE transport execute | cell runs without a cap |
| SEQ-2 | Kernel manager execute timer expiry | RLM transport interrupt | DURING in-flight execute | timer fires and cell still runs |
| SEQ-3 | Kernel manager after interrupt | settle execute as error | AFTER interrupt path | host tool call stays pending |

### Integration Points Checklist

| ID | Source | Target | Handoff Data | Contract Clause |
|----|--------|--------|-------------|-----------------|
| IP-1 | Kernel manager executeInternal | RLM transport execute | cell id, code | SEQ-KM-6 |
| IP-2 | Kernel manager execute timer | RLM transport interrupt | in-flight cell | SEQ-KM-7 |
| IP-3 | Kernel manager settle | ipython tool result | status error, durationMs | POST-KM-4 |

### Lifecycle Paths

| Component | INIT (created/started by) | CLEANUP (stopped/released by) |
|-----------|--------------------------|-------------------------------|
| Execute timer | Kernel manager executeInternal, each ordinary execute | Kernel manager on settle (ok, error, aborted) or dispose |
| Kernel process | unchanged from REQ-RLM-0003 | unchanged from REQ-RLM-0003 |

## 4. Hard Invariants (The "Never" List)

| ID | Category | Invariant |
|----|----------|-----------|
| INV-01 | Bound | Kernel manager SHALL NOT wait without bound for transport execute. |
| INV-02 | Scope | TypeScript host SHALL NOT add an ipython schema timeout field in this slice. |
| INV-03 | Isolation | RLM plugin SHALL NOT modify omp eval kernel semantics. |

## 5. High-Entropy Zones (Adjudicated)

| Zone | Question | Resolution | Decided By |
|------|----------|------------|------------|
| Cap value | 15 s, 30 s, 60 s, or named | 30000 ms | Coordinator recommendation; User: proceed, timer only |
| On expiry | interrupt only, kill, or interrupt then kill | interrupt then settle error | User: keep scope to just the timer |
| Schema param | none, or optional shorter cap | none | User: keep scope to just the timer |

## 5.5 Rejected Alternatives

| Decision | Alternative Considered | Why Rejected |
|----------|----------------------|--------------|
| Host-enforced 30000 ms timer | Model-visible timeout parameter | Model omits it; same hang |
| Interrupt then settle | Kill and restart kernel | Drops namespace; out of timer-only scope |
| New execute timer | Prompt-only instruction | Advisory text failed; hang recurred |

## 6. Tool/API Interface Summary

| Interface | Purpose | Mutates State? | Called By | Triggered When |
|-----------|---------|----------------|----------|---------------|
| Kernel manager execute | run one cell | YES | ipython tool | Model submits code |
| RLM transport interrupt | abort in-flight cell | YES | Kernel manager | execute timer expires |
| ipython tool result | report status and durationMs | NO | TypeScript host | execute settles |

## 6.5 Blocking Dependencies

| Unresolved Zone | Blocks |
|-----------------|--------|
| none | none |

## 7. Failure Mode Specification (CL15)

| Requirement | Failure Condition | Behavior | Notification |
|------------|-------------------|----------|-------------|
| REQ-RLM-0023 | Cell still running at 30000 ms | FAIL FAST — interrupt then settle error | Tool result status error; durationMs at or above 30000 |
| REQ-RLM-0024 | Interrupt does not stop the cell before abort grace | FAIL FAST — settle error; later execute still accepted | Tool result status error citing ERRORS-KM-4 |
| REQ-N-7 | Timer omitted | FAIL FAST — tests fail POST-KM-4 | RED tests; no silent hang |

## 8. Completion Promise (Ralph Loop Exit)

> A cell that would run past 30000 ms settles as error with durationMs at or above 30000. A following cell in the same manager runs. Ready, dispose, and output caps stay unchanged. No ipython schema timeout field.

## 9. Contract Authority

**Authoritative Source**: `requirements/contracts/rlm-kernel.contract.ts`

requirements/REQ-2026-RLM-EXECUTE-TIMEOUT.md (this file)
        ↓
plans/rlm-execute-timeout.plan.json
        ↓
requirements/contracts/rlm-kernel.contract.ts
        ↓
packages/rlm/tests/kernel.spec.ts
        ↓
packages/rlm/src/kernel.ts

Parent capability manifest: `requirements/REQUIREMENT_MANIFEST.md` (REQ-RLM-2026-001). This file is the singular authority for the execute timer.

## 10. Revision History

| Date | Author | Change |
|------|--------|--------|
| 2026-08-20 | K. Harris | Initial manifest from hang of ipython call_1102100; GitHub issue #4; timer only |
