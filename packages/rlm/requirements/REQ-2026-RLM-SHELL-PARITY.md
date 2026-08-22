# REQ-2026-RLM-SHELL-PARITY: Shell Environment Parity for RLM Kernel

## CCABDD Governance

Human owns: intent (front) + reality judgment (back).
AI owns: enforcement (middle).
Neither crosses the boundary.

Human MUST confirm real-world effect matches intent.
AI MAY NOT infer success from metrics.

**INV-3**: No discretion. No judgment. Only state.
CONTRACT SHALL NOT execute unless ALL predicates evaluate to TRUE.

---

## Actors
| Actor | Identifier |
|:------|:-----------|
| `RLMHost` | ACT-1 |
| `KernelTransport` | ACT-2 |
| `PythonKernel` | ACT-3 |

## 1. Intent Traceability
- **Source Prose**:
  > "i want to also add to this issues scope: the ipython reply needs to have the same path as my normal shell. just like when you spawn a bash or zsh shell from the harness. can that be done ?"
- **Our Understanding**:
  The RLM IPython kernel runner process in `omp` inherits the safe shell environment (`PATH`, `HOME`, `SHELL`, `USER`, `LOGNAME`, `TMPDIR`, `LANG`, `LC_ALL`, `TERM`), with `RLM_*` internal variables taking strict precedence, ensuring complete shell binary parity without secret leakage.
- **Ambiguity Score**: 0

## 2. The Actor Matrix
| Actor | Permission Level | Prohibited Actions |
|:------|:-----------------|:-------------------|
| `RLMHost` | Spawns transport runner with safe environment parity | RLMHost shall not drop safe shell environment variables |
| `KernelTransport` | Executes Python kernel runner | KernelTransport shall not omit inherited PATH or HOME |
| `PythonKernel` | Resolves system binaries via inherited PATH | PythonKernel shall not execute without valid PATH or HOME |

## 3. The State Transition
- **Initial State ($S_0$)**: `buildKernelEnv` produces only 8 internal `RLM_*` variables; `PATH` and `HOME` are absent.
- **Transformation**: `buildKernelEnv` merges safe host shell variables with internal `RLM_*` variables.
- **Terminal State ($S_1$)**: `PythonKernel` executes CLI tools from inherited PATH.

## 3.5 Integration Specification

### Dependency Graph
`KernelTransport` DEPENDS ON `buildKernelEnv` for spawn environment dictionary.
`buildKernelEnv` DEPENDS ON `process.env` for safe shell variable values.

### Control Flow Requirements (Sequencing Specs)
| ID | Caller | Must Invoke | Temporal Constraint | Breaks If Missing |
|----|--------|-------------|---------------------|-------------------|
| SEQ-1 | `RlmHost.start()` | `buildKernelEnv(session, caps, hostEnv)` | BEFORE `createTransport()` | Kernel spawned without PATH |
| SEQ-2 | `createTransport()` | `spawnFn(interpreter, args, { env })` | DURING `transport.start()` | Subprocess drops PATH |

### Integration Points Checklist
| ID | Source | Target | Handoff Data | Contract Clause |
|----|--------|--------|--------------|-----------------|
| IP-1 | `process.env` | `buildKernelEnv` | `PATH`, `HOME`, `SHELL`, `USER` | `POST-ENV-01` |
| IP-2 | `buildKernelEnv` | `KernelTransport.spawn` | Merged env dict | `POST-ENV-03` |

### Lifecycle Paths
| Component | INIT (created/started by) | CLEANUP (stopped/released by) |
|-----------|--------------------------|-------------------------------|
| `KernelEnv` | Initialized by `RlmHost` at transport start | Released by `RlmHost` when transport disposes |

## 4. Hard Invariants (The "Never" List)
| ID | Category | Invariant |
|----|----------|-----------|
| INV-ENV-01 | Isolation | `RLMHost` shall not drop `PATH` or `HOME` from the kernel environment. |
| INV-ENV-02 | Precedence | `RLMHost` shall preserve internal `RLM_*` variables over colliding host environment keys. |

## 5. High-Entropy Zones (Adjudicated)
| Zone | Question | Resolution | Decided By |
|------|----------|------------|------------|
| Environment Scope | Inherit entire `process.env` or safe allowlist? | Safe Shell Allowlist (`PATH`, `HOME`, `SHELL`, `USER`, `LOGNAME`, `TMPDIR`, `LANG`, `LC_ALL`, `TERM`) with `RLM_*` overrides | User (CL4) |
| Missing Host PATH | What if `process.env.PATH` is undefined? | Fall back to standard POSIX default `/usr/bin:/bin:/usr/sbin:/sbin` | User (CL4) |

## 5.5 Rejected Alternatives
| Decision | Alternative Considered | Why Rejected |
|----------|----------------------|--------------|
| Safe Shell Allowlist | Unfiltered `process.env` inheritance | Exposes raw API keys and cloud tokens to model-generated code in `os.environ` |
| Merge at spawn | Mutating global `process.env` | Pollutes harness host process state |

## 6. Tool/API Interface Summary
| Interface | Purpose | Mutates State? | Called By | Triggered When |
|-----------|---------|----------------|----------|---------------|
| `buildKernelEnv` | Combines safe host environment with session bounds | NO | `RlmHost` | During kernel transport creation |

## 6.5 Blocking Dependencies
| Unresolved Zone | Blocks |
|-----------------|--------|
| None | Ready for contracts |

## 7. Failure Mode Specification (CL9)
| Requirement | Failure Condition | Behavior | Notification |
|------------|-------------------|----------|-------------|
| REQ-ENV-01 | Host environment has no PATH | FALLBACK to POSIX default | Diagnostic log |

## 8. Completion Promise (Ralph Loop Exit)
> "The IPython tool in RLM kernel can resolve and execute native system binaries (`which`, `git`, `python`) without FileNotFoundError."

## 9. Contract Authority
**Authoritative Source**: `packages/rlm/contracts/rlm_env_parity.contract.ts`

## 10. Revision History
| Date | Author | Change |
|------|--------|--------|
| 2026-08-22 | Ketema Harris | Initial IEEE 29148 requirement manifest |
| 2026-08-22 | Ketema Harris | Reconciled Safe Shell Allowlist per peer panel consensus |
