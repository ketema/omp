# REQ-2026-RLM-TIMEOUT-DESYNC: Kernel Transport Execution Synchronization Across Timeouts and Interrupts

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
| RLM runner | RLM runner |
| Model | Model |
| User | User |

## 1. Intent Traceability

- **Source Prose**:
  > Issue ketema/omp#12: `bug(rlm-kernel): subagent ipython failure modes: state amnesia, 30s timeout, and bootstrap lock contention`
  > Telemetry audit across session archives demonstrates kernel desynchronization where execution timeouts cause subsequent `transport.execute()` calls to deadlock indefinitely or drop return frames due to unhandled active pending state in transport.

- **Our Understanding**: When Kernel manager times out at 30.0 s (`POST-KM-4`) or aborts execution, it invokes safeInterrupt() and immediately settles the caller promise. In RLM transport, the in-flight execution promise was not settled or cleared. If a subsequent execute call was dispatched, activeExecPending was overwritten without resolution, and stale frames from the prior execution caused frame ID mismatches, permanently deadlocking the transport. This requirement mandates deterministic cancellation and settling of any in-flight execution promise upon subsequent dispatch or interrupt.

- **Ambiguity Score**: 1

## 2. The Actor Matrix

| Actor | Permission Level | Prohibited Actions |
|:------|:-----------------|:-------------------|
| Kernel manager | orchestrates kernel lifecycle; initiates executions and interrupts | Kernel manager SHALL NOT wait without bound for transport execute |
| RLM transport | manages runner process, executes cells, streams IO, handles wire frames | RLM transport SHALL NOT overwrite activeExecPending without settling previous execution |
| RLM runner | executes Python cells and emits JSON lines protocol frames | RLM runner SHALL NOT emit done frames with unregistered execution IDs |
| Model | submits cells through ipython | Model SHALL NOT access raw transport stdio streams directly |
| User | confirms real-world effect | User SHALL NOT bypass the timeout or contract bounds |

## 3. The State Transition

- **Initial State ($S_0$)**: RLM transport execute assigns activeExecPending directly. If a prior execution timed out or aborted, its pending promise remains dangling. Subsequent calls overwrite the pending reference, leading to dropped frames or hung promises.
- **Transformation**: RLM transport execute inspects activeExecPending. If activeExecPending is present, RLM transport settles the prior execution with an InterruptedError before assigning the new execution ID and dispatching the new wire frame.
- **Terminal State ($S_1$)**: Every RLM transport execute call settles deterministically. No execution promise hangs indefinitely, and subsequent executions succeed cleanly even after timeouts or interrupts.

## 3.5 Integration Specification

### Dependency Graph

Kernel manager DEPENDS ON RLM transport for execute and interrupt.
RLM transport DEPENDS ON RLM runner for stdio JSON-lines protocol exchange.
Model DEPENDS ON Kernel manager for cell evaluation.

### Control Flow Requirements (Sequencing Specs)

| ID | Caller | Must Invoke | Temporal Constraint | Breaks If Missing |
|----|--------|-------------|---------------------|-------------------|
| SEQ-1 | Kernel manager executeInternal | RLM transport execute | BEFORE timer expiry | cell execution never starts |
| SEQ-2 | Kernel manager execute timer | RLM transport interrupt | AT 30000ms ceiling | runner process executes without boundary |
| SEQ-3 | RLM transport execute (new) | Settle prior activeExecPending | BEFORE assigning new activeExecId | previous execution hangs; transport desyncs |
| SEQ-4 | RLM transport handleLine | Route done frame to activeExecPending | AFTER frame receipt | caller promise never settles |

### Integration Points Checklist

| ID | Source | Target | Handoff Data | Contract Clause |
|----|--------|--------|-------------|-----------------|
| IP-1 | Kernel manager executeInternal | RLM transport execute | cell id, code | SEQ-KM-6 |
| IP-2 | Kernel manager execute timer | RLM transport interrupt | in-flight cell | SEQ-KM-7 |
| IP-3 | RLM transport sendOp | RLM runner stdin | JSON op line | POST-TRANS-2 |
| IP-4 | RLM runner stdout | RLM transport handleLine | JSON done frame | POST-TRANS-3 |

### Lifecycle Paths

| Component | INIT (created/started by) | CLEANUP (stopped/released by) |
|-----------|--------------------------|-------------------------------|
| Execution promise | RLM transport execute on new op | RLM transport handleLine done frame or next execute |
| Kernel runner process | RLM transport start | RLM transport dispose or SIGKILL escalation |

## 4. Hard Invariants (The "Never" List)

| ID | Category | Invariant |
|----|----------|-----------|
| INV-01 | Lifecycle | RLM transport SHALL NOT leave any execute promise unresolved upon subsequent operation dispatch. |
| INV-02 | Wire | RLM transport SHALL align every done and error frame with the active execution ID before settling. |
| INV-03 | Liveness | RLM transport SHALL guarantee sequential execution liveness following any timeout or interrupt. |
| FORBIDDEN-01 | State | RLM transport SHALL NOT overwrite activeExecPending without settling the existing promise. |
| FORBIDDEN-02 | Routing | RLM transport SHALL NOT deliver stream frames from a prior execution ID to a new execution callback. |

## 5. High-Entropy Zones (Adjudicated)

| Zone | Question | Resolution | Decided By |
|------|----------|------------|------------|
| Superseded settle mode | Reject promise with Error or resolve with error structure | Resolve with code 1 and errorEname InterruptedError | Coordinator recommendation; User: proceed |
| Interrupt handling | Settle inside interrupt() or settle on next execute() | Settle in next execute() or on process death | Coordinator recommendation; User: proceed |

## 5.5 Rejected Alternatives

| Decision | Alternative Considered | Why Rejected |
|----------|----------------------|--------------|
| Resolve with error structure | Reject with Error exception | Rejection creates unhandled promise rejection warnings in async event loops |
| In-transport settle on next op | Full kernel kill and restart on timeout | Dropping process drops kernel memory and is too slow for subagent workflows |
| Safe interrupt settle | Silent overwrite of activeExecPending | Overwrite causes indefinite hang on subsequent tool calls |

## 6. Tool/API Interface Summary

| Interface | Purpose | Mutates State? | Called By | Triggered When |
|-----------|---------|----------------|----------|---------------|
| RLM transport execute | run cell and await done frame | YES | Kernel manager | cell execution requested |
| RLM transport interrupt | deliver SIGINT to runner | YES | Kernel manager | execute timer expires |
| RLM transport handleLine | parse and route wire frames | YES | RLM runner stdout | runner emits JSON line |

## 6.5 Blocking Dependencies

| Unresolved Zone | Blocks |
|-----------------|--------|
| none | none |

## 7. Failure Mode Specification (CL15)

| Requirement | Failure Condition | Behavior | Notification |
|------------|-------------------|----------|-------------|
| REQ-RLM-0025 | Runner process exits during active execution | FAIL FAST — reject activeExecPending with TransportProtocolError | Error notification to caller |
| REQ-RLM-0026 | Done frame arrives for inactive execution ID | FAIL FAST — discard frame silently without corrupting active state | Diagnostic log event |
| REQ-RLM-0027 | Runner emits malformed JSON frame | FAIL FAST — raise TransportProtocolError immediately | Tool result status error |

## 8. Completion Promise (Ralph Loop Exit)

> A cell that times out at 30000 ms settles with an error, and any following execute call in the same transport resolves cleanly without hanging or frame corruption.

## 9. Contract Authority

**Authoritative Source**: `requirements/contracts/rlm-timeout-desync.contract.ts`

requirements/REQ-2026-RLM-TIMEOUT-DESYNC.md (this file)
        ↓
plans/rlm-timeout-desync.plan.json
        ↓
requirements/contracts/rlm-timeout-desync.contract.ts
        ↓
packages/rlm/tests/kernel.spec.ts
        ↓
packages/rlm/src/transport.ts

Parent capability manifest: `requirements/REQUIREMENT_MANIFEST.md` (REQ-RLM-2026-001). This file is the singular authority for transport execution timeout synchronization.

## 10. Revision History

| Date | Author | Change |
|------|--------|--------|
| 2026-08-22 | K. Harris | Initial manifest for issue #12 kernel timeout desync fix |
