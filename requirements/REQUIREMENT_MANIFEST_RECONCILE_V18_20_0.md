# REQ-RECON-V18-20-0: Upstream v18.20.0 Fork Reconciliation & Subagent Runtimes

## CCABDD Governance
- **Workflow State**: `REQUIREMENTS`
- **Methodology**: CCABDD (Constitutional Contract Adversarial Behavior-Driven Development)
- **Status**: ACTIVE

## Definitions
| Term | Meaning |
|---|---|
| Fork | `ketema/omp` |
| Upstream | `can1357/oh-my-pi` |
| Explicit Base | Tag `v18.18.7` (`e325ffc73a`), the base tree for 3-way adoption |
| Adopted Tree | The merged tree: upstream `v18.20.0` plus fork customized paths |
| Registry | `requirements/FORK_CUSTOMIZATIONS.md`, rows 1 to 14 |
| Raw-IO Helper | In-process file routing component preventing SQLite lock loss |
| task.perCallModel | Upstream subagent model configuration gate (PR #12229) |
| Runtime Admission | Unconditional admission of `createRlmExtension()` to all subagents |

## Assumptions
| ID | Assumption |
|---|---|
| ASM-01 | Base commit `v18.18.7` is tagged and verified in the repository |
| ASM-02 | Upstream `v18.20.0` is fetched from `upstream` remote |
| ASM-03 | Apple Developer ID Application certificate is available on host |

## Actors
| Actor | Identifier | Description |
|---|---|---|
| Reconciler | `reconciler` | Git tree-adoption process merging upstream changes into the fork |
| SubagentSession | `subagent` | Running agent or child subagent executing tasks or audits |
| PerCallModelResolver | `resolver` | Module validating and resolving per-call model strings and aliases |
| RawIoHelper | `raw_io_helper` | In-process file routing component preventing SQLite lock loss |

## 1. Intent Traceability
| Requirement ID | Intent Source | Acceptance Observable |
|---|---|---|
| REQ-PCM-0001 | ketema/omp#72 | `task.perCallModel` enabled gate admits valid model requests |
| REQ-PCM-0002 | ketema/omp#72 | Role aliases (`@smol`, `@default`, configured roles) resolve deterministically |
| REQ-PCM-0003 | ketema/omp#72 | Explicit provider/model strings admitted without rejection |
| REQ-PCM-0004 | ketema/omp#72 | Candidate arrays resolve to first available approved model |
| REQ-PCM-0005 | ketema/omp#72 | Operator allowlists and trust boundaries remain binding |
| REQ-PCM-0006 | ketema/omp#72 | Actionable error diagnostics when feature is disabled or candidate is invalid |
| REQ-RLM-0002 | User directive 2026-11-13 | `ipython` tool available to all subagents regardless of write permission |
| REQ-RECON-01 | requirements/FORK_CUSTOMIZATIONS.md | All 14 customization rows survive upstream `v18.20.0` reconcile |
| REQ-RECON-02 | ketema/omp#78 | 3-way merge conflict in `find-cli.ts` resolved cleanly |

## Known Ambiguities
| Ambiguity ID | Description | Resolution | Decided By |
|---|---|---|---|
| AMB-01 | `@default` alias semantics | Resolves to parent session active model, or configured default role | User |
| AMB-02 | Subagent `ipython` write bypass | `ipython` admitted for context reduction; role prevents file edits | User |

## 2. Actor Matrix
| Actor | Permission Level | Prohibited Actions |
|---|---|---|
| Reconciler | Adopts upstream commits and resolves merge conflicts | Drop fork customizations |
| SubagentSession | Runs tools declared in frontmatter | Edit files when caller omits write tool |
| PerCallModelResolver | Validates and resolves model patterns | Widen allowlist from project settings |
| RawIoHelper | Routes SQLite file descriptors | Modify unrouted non-database files |

## 3. State Transition
| From State | Trigger | To State | Output Observable |
|---|---|---|---|
| CONVERSATION | User approval of manifest & plan | CONTRACTS | Contracts authored on disk |
| CONTRACTS | Contract enforceable verification | RED | Tests fail for missing behavior |
| RED | Test failure verified | GREEN | Minimal code change passes tests |
| GREEN | All tests pass | AUDIT | 9-gate audit verification |

## 3.5 Integration Specification
| Component | Integration Target | Interface |
|---|---|---|
| PerCallModelResolver | `config/model-resolver.ts` | `resolveModelOverride` |
| SubagentSession | `sdk.ts` | `createAgentSessionScoped` |
| RawIoHelper | `cli/find-cli.ts` | `stopRawIoHelper` |

## 4. Hard Invariants (The "Never" List)
| ID | Category | Invariant | Verification |
|---|---|---|---|
| INV-PCM-01 | Security | The PerCallModelResolver SHALL NOT permit project settings to widen `task.perCallModelAllow`. | test |
| INV-RLM-01 | Context | The SubagentSession SHALL receive `createRlmExtension()` unconditionally even when caller omits `write`. | test |
| INV-RECON-01 | Baseline | The Reconciler SHALL compute 3-way merge against explicit base `v18.18.7`. | test |
| INV-RECON-02 | Integrity | The Reconciler SHALL preserve all 14 rows of `requirements/FORK_CUSTOMIZATIONS.md`. | test |
| REQ-PCM-0001 | Gate | The PerCallModelResolver SHALL gate per-call model requests on `task.perCallModel`. | test |
| REQ-PCM-0002 | Alias | The PerCallModelResolver SHALL resolve `@smol` and `@default` to concrete model identifiers. | test |
| REQ-PCM-0003 | Explicit | The PerCallModelResolver SHALL admit explicit provider/model-id strings. | test |
| REQ-PCM-0004 | Array | The PerCallModelResolver SHALL evaluate candidate arrays in sequence until first match. | test |
| REQ-PCM-0005 | Allowlist | The PerCallModelResolver SHALL enforce operator allowlist constraints. | test |
| REQ-PCM-0006 | Diagnostics | The PerCallModelResolver SHALL reject invalid candidate arrays with index and selector text. | test |
| REQ-RLM-0002 | Runtime | The SubagentSession SHALL surface `ipython` in `getActiveToolNames()`. | test |
| REQ-RECON-01 | Preservation | The Reconciler SHALL pass all 19 verification checks in `scripts/verify-fork-customizations.sh`. | test |
| REQ-RECON-02 | Cleanup | The Reconciler SHALL stop RawIoHelper in `find-cli.ts` `finally` block. | test |

## 4.5 Quality Attributes (Nonfunctional)
| ID | Category | Requirement | Verification |
|---|---|---|---|
| NFR-RECON-01 | Performance | The Reconciler SHALL execute verification script within 180 seconds | execution |
| NFR-RECON-02 | Integrity | The Reconciler SHALL produce candidate binary with valid Developer ID signature | execution |

## 5. High-Entropy Zones (Adjudicated)
| Question | Zone | Resolution | Decided By |
|---|---|---|---|
| Per-call model aliases | Z1 | Re-enable aliases inside `task.perCallModel` | User |
| Subagent ipython | Z2 | Unconditionally admit for all subagents | User |

## 5.5 Rejected Alternatives
| Decision | Alternative Considered | Why Rejected |
|---|---|---|
| Re-enable aliases | Banning aliases | Operator requires `@smol` and `@default` ergonomics |
| Unconditionally admit | Withholding ipython | Direct mandate: ipython critical for context reduction |

## 6. Tool/API Interface Summary
| Interface | Purpose | Mutates State? | Called By | Triggered When |
|---|---|---|---|---|
| `invalidModelSelectorReason` | Validates strings, aliases, arrays | NO | Subagent preflight | Model selector parsed |
| `preflightPerCallModel` | Evaluates approvals and grants | NO | Subagent preflight | Dispatch initiated |
| `assertIpythonAdmittedForReadOnly` | Throws error if ipython missing | NO | Test suite | Verification run |

## 6.5 Blocking Dependencies
| Blocks | Unresolved Zone | Dependency |
|---|---|---|
| None | None | None |

## 7. Failure Mode Specification
| Requirement | Failure Condition | Behavior | Notification |
|---|---|---|---|
| REQ-PCM-0001 | Feature disabled | Reject dispatch | Error names disabled setting |
| REQ-PCM-0006 | Malformed array | Reject dispatch | Error names offending index and value |
| REQ-PCM-0005 | Model unapproved | Reject dispatch | Error names missing approval |
| REQ-RLM-0002 | ipython omitted | Throw contract error | `RlmNativeToolContractError` |

## 8. Completion Promise (Ralph Loop Exit)
- The Reconciler SHALL exit remediation only when re-audit returns `<promise>ZERO VIOLATIONS</promise>`.

## 9. Contract Authority
| Domain | Contract File | Authority Scope |
|---|---|---|
| Per-Call Model | `contracts/per_call_model.contract.ts` | Governs `REQ-PCM-*` clauses |
| Subagent RLM | `contracts/rlm-native-tool.contract.ts` | Governs `REQ-RLM-0002` clauses |
| Fork Reconcile | `requirements/FORK_CUSTOMIZATIONS.md` | Governs `REQ-RECON-*` clauses |

## 10. Revision History
| Date | Author | Change |
|---|---|---|
| 2026-11-13 | Ketema Harris | Initial IEEE 29148 compliant manifest for v18.20.0 reconcile |
