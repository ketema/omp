# REQ-2026-CTX27: Active In-Flight REPL Context Bridge and Context Efficiency Enforcement

## CCABDD Governance

Human owns: intent (front) + reality judgment (back).
AI owns: enforcement (middle).
Neither crosses the boundary.

Human confirms whether real-world effect matches intent.
AI never infers success from metrics.

Rule 3: No discretion. No judgment. Only state.
No contract executes unless all predicates evaluate to TRUE.

## Definitions

| Term | Meaning |
|:-----|:--------|
| Proxy Counter | `natives.countTokens(text, Encoding.O200kBase)` from `@oh-my-pi/pi-natives`. |
| UDT Descriptor | One JSON object of at most 400 Proxy Counter tokens carrying `class` (`json_array`, `json_object`, `tabular`, or `text`) and `name` (`artifact_<id>`), with key and column names cut at 31 characters, text keeping 5 head lines and 5 tail lines each cut at 40 characters, JSON array sample strings cut at 40 characters, and JSON object descriptors copying no values. |
| Catalog Card | One JSON object of at most 80 Proxy Counter tokens carrying `name` (at most 16 characters), `signature` (at most 24 characters), `summary` (at most 32 characters), and `snapshot` basename (at most 24 characters) with no function body. |
| Trusted Helper Snapshot | A regular, user-owned, non-symlink file with mode `0600` under `~/.omp/agent/repl-snapshots/` whose SHA-256 and byte size match `manifest.json`. |
| Compaction Snapshot | `~/.omp/agent/ipython-compact-<session_id>.pkl`, a non-empty xz stream whose decompressed bytes start with `0x80` and whose SHA-256 matches the Memory Record. |
| Memory Record | The single entry `auto-compact-memory-<session_id>-<seq>` holding `{narrative, descriptors, kernel_handles, snapshot_path, sha256, files_touched, open_items}` and no payload. |
| Fixture Transcript | The F-over UDT Descriptor plus three Catalog Cards plus the compaction status line, excluding user prompts, F-inline, F-turn, and F-session. |

## Assumptions

- `@oh-my-pi/pi-natives` provides `countTokens` and `Encoding.O200kBase` in `ketema/omp`.
- `ExtensionToolWrapper` dispatches `tool_result` handlers after tool execution.
- `SessionMaintenance` dispatches `session_before_compact` handlers and throws `CompactionCancelledError` when a handler returns `{ cancel: true }`.
- The managed Python environment provides `dill` and `lzma`.

## Actors

| Actor | Identifier |
|:------|:-----------|
| Ketema | `ketema` |
| omp | `omp` |
| Emission Gate | `emission_gate` |
| Catalog Gate | `catalog_gate` |
| Compaction Gate | `compaction_gate` |
| IPython Kernel | `ipython_kernel` |

## 1. Intent Traceability

- **Source Prose**:
  > "Build the enforcement in /Users/ketema/projects/omp for ketema/omp#27. The gate counts with natives.countTokens(text, Encoding.O200kBase) from @oh-my-pi/pi-natives. That counter is the proxy. A vendor tokenizer may differ by 10-20 percent. The gate does not retokenize per model. A result under 1,500 tokens is inline only while the turn still has room. A turn admits at most 1,500 tokens of inline tool text. Once the transcript already holds 6,000 tokens of inline tool text, later results are filed even if each is under 1,500. A result of 1,500 tokens or more is always filed. Issue 27's 1.5 KB line is not the threshold. A descriptor is one JSON object of at most 400 tokens. class and name are required. name is artifact_<id>. Key names and column names are cut at 31 characters. Text keeps 5 head lines and 5 tail lines, each cut at 40 characters. That maximum, counted as punctuation, is 308 tokens. A JSON sample string is cut at 40 characters. If the object still exceeds 400 tokens, drop the sample, then the distributions, until it fits. Do not drop class, name, or the cut schema names. A JSON object descriptor copies no values. A card is at most 80 tokens: name at most 16 characters, signature at most 24, summary at most 32, snapshot basename at most 24. That maximum, counted as punctuation, is 76 tokens. A card contains no function body. A trusted helper snapshot is a regular, user-owned, non-symlink file, mode 0600, whose real path stays under ~/.omp/agent/repl-snapshots/. Its SHA-256 and byte size match manifest.json. ~/.agents/skills/repl-snapshots/restore.py loads the declared names and types. A failed load leaves the previous bindings and returns an error. A verified compaction snapshot is ~/.omp/agent/ipython-compact-<session_id>.pkl: a non-empty xz stream whose decompressed bytes begin with pickle magic 0x80, with the SHA-256 stored in the one record. The one record is Memory MCP entry auto-compact-memory-<session_id>-<seq>. Its body is narrative, descriptors, kernel_handles, snapshot_path, sha256, files_touched, open_items. It contains no payload. If dill.dump_session fails because a name is unpicklable, drop those names, list them in open_items, snapshot the rest, and compact. Refuse only when the snapshot hash does not match the record, or the snapshot write fails. Refusal is { cancel: true } from session_before_compact, then CompactionCancelledError, an unchanged compaction-entry count, and the text Compaction cancelled. Search order and recovery are the search-hierarchy and compaction-recovery skills. The IPython kernel is for durable work of at most 30 seconds. eval is for a longer job that is not a build, test, lint, install, or deploy. tmux is only for those five. Done when tests 1-4 pass in CI. The 700-token cap applies only to F-over plus the three cards plus the compaction status line, excluding user prompts and excluding F-inline, F-turn, and F-session. That transcript is at most 700 tokens."
- **Our Understanding**: `omp` enforces context efficiency through three mechanical gates and prompt assembly: Emission Gate counts tokens with `Encoding.O200kBase`, enforces the 1,500 per-result/per-turn and 6,000 per-session inline budgets, replaces filed outputs with a ≤400-token UDT Descriptor, binds the full payload in IPython Kernel under `artifact_<id>`, and caps display output for that name at 60 lines and 2,048 bytes; Catalog Gate saves helpers to Trusted Helper Snapshots and injects ≤80-token Catalog Cards with zero function bodies on every prompt; Compaction Gate drops unpicklable names to `open_items`, verifies the xz/`0x80`/SHA-256 Compaction Snapshot and single Memory Record, and cancels compaction on hash mismatch or write failure.
- **Ambiguity Score**: 0

## 2. The Actor Matrix

| Actor | Permission Level | Prohibited Actions |
|:------|:-----------------|:-------------------|
| Ketema | Approves requirements, plan, and final acceptance | — |
| omp | Dispatches tool results, prompt assembly, and compaction hooks | Admitting a filed payload value slice of 32 bytes or more outside a cut sample or cut text line |
| Emission Gate | Counts tokens, admits inline results within budgets, files UDT Descriptors, and binds payloads in IPython Kernel | Retokenizing per model; dropping `class`, `name`, or cut schema names from a UDT Descriptor |
| Catalog Gate | Writes Trusted Helper Snapshots and injects Catalog Cards into prompts | Including a function body in a Catalog Card |
| Compaction Gate | Snapshots IPython Kernel, records `open_items`, writes the Memory Record, and cancels compaction on hash or write failure | Including raw payload bytes in the Memory Record |
| IPython Kernel | Stores bound `artifact_<id>` values and caps display output | Emitting more than 60 lines or 2,048 bytes when displaying a bound artifact |

## 3. The State Transition

- **Initial State (S0)**: `omp` has no mechanical UDT emission gate, no automatic per-turn helper catalog card injector, and no `session_before_compact` verification gate for `ketema/omp#27`.
- **Transformation**: Implement Emission Gate, Catalog Gate, Compaction Gate, and prompt-assembly verification in `packages/coding-agent` and `packages/rlm`, and verify Tests 1–4.
- **Terminal State (S1)**: Emission Gate, Catalog Gate, Compaction Gate, and prompt assembly pass Tests 1–4 in CI and keep the Fixture Transcript at most 700 Proxy Counter tokens.

## 3.5 Integration Specification

### Dependency Graph

- Emission Gate DEPENDS ON `@oh-my-pi/pi-natives` (`countTokens`, `Encoding.O200kBase`) for token counting.
- Emission Gate DEPENDS ON IPython Kernel for binding `artifact_<id>` and capping display output.
- Catalog Gate DEPENDS ON Trusted Helper Snapshot storage (`~/.omp/agent/repl-snapshots/manifest.json`) for building Catalog Cards.
- Compaction Gate DEPENDS ON IPython Kernel and `session_before_compact` for writing the Compaction Snapshot and Memory Record or returning `{ cancel: true }`.

### Control Flow Requirements (Sequencing Specs)

| ID | Caller | Must Invoke | Temporal Constraint | Breaks If Missing |
|----|--------|-------------|---------------------|-------------------|
| SEQ-1 | `omp` tool-result path | Emission Gate `admitToolResult` | BEFORE the tool result enters the transcript | Oversized or over-budget tool results enter the transcript raw |
| SEQ-2 | Emission Gate `admitToolResult` for a filed result | IPython Kernel binding of `artifact_<id>` | BEFORE returning the UDT Descriptor | The descriptor names an unbound kernel variable |
| SEQ-3 | `omp` prompt assembly | Catalog Gate `assemblePromptWithCatalogCards` | BEFORE sending the prompt to the model | Saved helper cards are absent from the prompt |
| SEQ-4 | `omp` `session_before_compact` dispatch | Compaction Gate `runBeforeCompactHook` | BEFORE committing a compaction entry | Unverified or corrupted snapshots compact silently |

### Integration Points Checklist

| ID | Source | Target | Handoff Data | Contract Clause |
|----|--------|--------|--------------|-----------------|
| IP-1 | `omp` tool-result dispatch | Emission Gate | toolCallId, result text → inline text or UDT Descriptor | assigned in contracts |
| IP-2 | Emission Gate | IPython Kernel | `artifact_<id>`, raw payload → SHA-256 parity and capped display | assigned in contracts |
| IP-3 | Catalog Gate | `omp` prompt assembly | `manifest.json` entries → Catalog Cards | assigned in contracts |
| IP-4 | `omp` `session_before_compact` | Compaction Gate | sessionId, kernel state → Memory Record or `{ cancel: true }` | assigned in contracts |

### Lifecycle Paths

| Component | INIT (created/started by) | CLEANUP (stopped/released by) |
|-----------|---------------------------|-------------------------------|
| Emission Gate | `ContextEfficiencyEnforcer` constructor at session init | Session disposal or `resetBudgets()` |
| Catalog Gate | `saveTrustedHelperSnapshot` / `assemblePromptWithCatalogCards` | Snapshot directory cleanup on test teardown |
| Compaction Gate | `ContextEfficiencyEnforcer` `session_before_compact` registration | Session shutdown |
| IPython Kernel | `ContextEfficiencyEnforcer` or RLM lifecycle on first artifact bind | Kernel disposal at session shutdown |

## 4. Hard Invariants (The "Never" List)

| ID | Category | Invariant | Verification | Priority | Rationale |
|----|----------|-----------|--------------|----------|-----------|
| INV-CTX27-01 | Tokenizer | Emission Gate SHALL NOT retokenize tool results, descriptors, or cards per model. | Test | High | Proxy Counter is the single deterministic gate counter. |
| INV-CTX27-02 | Descriptor schema | Emission Gate SHALL NOT drop `class`, `name`, or cut schema names when trimming a UDT Descriptor to 400 tokens. | Test | High | Required lookup keys must survive trimming. |
| INV-CTX27-03 | Object values | Emission Gate SHALL NOT copy any value from a `json_object` payload into a `json_object` UDT Descriptor. | Test | High | Singleton object samples provide zero compression. |
| INV-CTX27-04 | Card bodies | Catalog Gate SHALL NOT include a function body in any Catalog Card. | Test | High | Bodies stay in Trusted Helper Snapshots. |
| INV-CTX27-05 | Memory payload | Compaction Gate SHALL NOT include raw payload text in the Memory Record. | Test | High | Payloads stay in the Compaction Snapshot. |
| INV-CTX27-06 | Prompt leak | omp SHALL NOT include any 32-byte slice of a filed payload value in an assembled prompt outside a UDT Descriptor cut sample string or cut text line. | Test | High | Prevents raw payload leak into model context. |
| INV-CTX27-07 | Fixture cap | omp SHALL NOT exceed 700 Proxy Counter tokens in the Fixture Transcript. | Test | High | Done condition budget. |
| REQ-CTX27-01 | Token counter | Emission Gate SHALL count tool-result, descriptor, card, and transcript tokens with `natives.countTokens(text, Encoding.O200kBase)`. | Test | High | Deterministic native token counter. |
| REQ-CTX27-02 | Inline admission | WHEN a tool result is under 1,500 tokens and adding it keeps turn inline tool tokens at most 1,500 and session inline tool tokens at most 6,000, Emission Gate SHALL admit the tool result inline. | Test | High | F-inline, F-turn, F-session boundaries. |
| REQ-CTX27-03 | Filing trigger | WHEN a tool result is 1,500 tokens or more or adding it exceeds 1,500 turn inline tool tokens or 6,000 session inline tool tokens, Emission Gate SHALL replace the transcript text with one UDT Descriptor. | Test | High | F-over, F-turn, F-session filing. |
| REQ-CTX27-04 | Descriptor cap | Emission Gate SHALL produce each UDT Descriptor as one JSON object of at most 400 Proxy Counter tokens with `class`, `name` (`artifact_<id>`), schema names cut at 31 characters, text keeping 5 head and 5 tail lines cut at 40 characters, and JSON array sample strings cut at 40 characters. | Test | High | Worst-case punctuation fits under 400 tokens. |
| REQ-CTX27-05 | Descriptor trim | WHEN a UDT Descriptor exceeds 400 Proxy Counter tokens, Emission Gate SHALL drop `sample_row_0` first and `low_cardinality_distributions` second until the UDT Descriptor is at most 400 Proxy Counter tokens. | Test | High | Deterministic progressive fallback. |
| REQ-CTX27-06 | Kernel binding | WHEN Emission Gate files a tool result under `artifact_<id>`, IPython Kernel SHALL bind `artifact_<id>` to a value whose SHA-256 equals the original payload SHA-256. | Test | High | Lossless in-kernel payload preservation. |
| REQ-CTX27-07 | Display cap | WHEN IPython Kernel formats display output for `artifact_<id>`, IPython Kernel SHALL emit at most 60 lines and at most 2,048 bytes. | Test | High | Prevents `print(artifact)` dump-back. |
| REQ-CTX27-08 | Snapshot save | Catalog Gate SHALL write each Trusted Helper Snapshot as a regular user-owned non-symlink file with mode `0600` under `~/.omp/agent/repl-snapshots/` matching `manifest.json` SHA-256 and byte size. | Test | High | Trusted snapshot storage invariant. |
| REQ-CTX27-09 | Card injection | WHEN Catalog Gate has saved `F` functions in Trusted Helper Snapshots, Catalog Gate SHALL inject into every subsequent assembled prompt `F` Catalog Cards of at most 80 Proxy Counter tokens each and at most `80 * F` tokens total. | Test | High | Every turn carries the cards, never the bodies. |
| REQ-CTX27-10 | Unpicklable drop | WHEN IPython Kernel holds an unpicklable variable during `session_before_compact`, Compaction Gate SHALL omit that variable from the Compaction Snapshot and record its name in `open_items`. | Test | High | Degraded compaction path prevents session deadlock. |
| REQ-CTX27-11 | Compaction record | WHEN the Compaction Snapshot verifies as a non-empty xz stream whose decompressed bytes start with `0x80` and whose SHA-256 matches, Compaction Gate SHALL write one Memory Record `auto-compact-memory-<session_id>-<seq>` and allow compaction to proceed. | Test | High | Lossless compaction recovery anchor. |
| REQ-CTX27-12 | Snapshot reload | WHEN `dill.load_session` loads a verified Compaction Snapshot in a fresh Python process, IPython Kernel SHALL restore `artifact_<id>` with the original payload SHA-256. | Test | High | Round-trip durability proof. |
| REQ-CTX27-13 | Compaction refusal | WHEN the Compaction Snapshot SHA-256 mismatches the Memory Record or the Compaction Snapshot write fails, Compaction Gate SHALL return `{ cancel: true }` from `session_before_compact` so `omp` throws `CompactionCancelledError` with unchanged compaction-entry count and status text `Compaction cancelled`. | Test | High | Fail-closed on corrupt or failed snapshot write. |

## 4.5 Non-Functional & Quality Attributes

| ID | Attribute | Requirement | Verification |
|----|-----------|-------------|--------------|
| REQ-CTX27-14 | Token determinism | Emission Gate SHALL evaluate every token budget using `Encoding.O200kBase` in deterministic in-process time without network calls. | Test |

## 5. High-Entropy Zones (Adjudicated)

| Zone | Question | Resolution | Decided By |
|------|----------|------------|------------|
| Z1 | Done condition vs Test 1 inline fixture | Exclude F-inline, F-turn, and F-session from the 700-token cap; cap applies to F-over + 3 cards + compaction status line | User (CL4) |
| Z2 | Text descriptor token ceiling | Keep 5 head + 5 tail lines cut at 40 characters (308 tokens worst-case punctuation) | User (CL4) |
| Z3 | Card token ceiling | `name` ≤ 16, `signature` ≤ 24, `summary` ≤ 32, `snapshot` ≤ 24 (76 tokens worst-case punctuation, cap 80) | User (CL4) |
| Z4 | Schema names vs 32-byte slice check | Cut key and column names at 31 characters and exempt them from the 32-byte payload-value slice check | User (CL4) |
| Z5 | Unpicklable objects during compaction | Drop unpicklable names, list them in `open_items`, snapshot the rest, and compact; refuse only on hash mismatch or write failure | User (CL4) |
| Z6 | Multi-result turn and session dilution | Cap inline tool text at 1,500 tokens per turn and 6,000 tokens per session | User (CL4) |

## 5.5 Rejected Alternatives

| Decision | Alternative Considered | Why Rejected |
|----------|------------------------|--------------|
| 5 head + 5 tail lines at 40 chars | 10 head + 10 tail lines at 120 chars | Exceeds the 400-token descriptor cap (up to 1,648 tokens on punctuation) |
| Drop unpicklable names to `open_items` | Refuse compaction on any unpicklable variable | One open socket or generator would permanently block compaction until session death |
| Per-turn (1,500) + per-session (6,000) budgets | Per-result threshold alone | Fifty 1,400-token results would pass the gate and flood context |

## 6. Tool/API Interface Summary

| Interface | Purpose | Mutates State? | Called By | Triggered When |
|-----------|---------|----------------|-----------|----------------|
| `ContextEfficiencyEnforcer.admitToolResult` | Gate tool outputs by token count and turn/session budgets | YES | `omp` tool-result path | Every tool result |
| `saveTrustedHelperSnapshot` | Persist a helper function to `~/.omp/agent/repl-snapshots/` and update `manifest.json` | YES | Catalog Gate | Saving a reusable helper |
| `assemblePromptWithCatalogCards` | Inject Catalog Cards into assembled prompts | NO | `omp` prompt assembly | Every prompt turn |
| `ContextEfficiencyEnforcer.runBeforeCompactHook` | Snapshot kernel, write Memory Record, or return `{ cancel: true }` | YES | `omp` `session_before_compact` | Before compaction |

## 6.5 Blocking Dependencies

| Unresolved Zone | Blocks |
|-----------------|--------|
| none | nothing |

## 7. Failure Mode Specification

| Requirement | Failure Condition | Behavior | Notification |
|:------------|:------------------|:---------|:-------------|
| REQ-CTX27-05 | Serialized UDT Descriptor exceeds 400 tokens | Emission Gate SHALL trim optional sample and distribution fields in priority order until the descriptor is at most 400 tokens. | Emission Gate SHALL keep `class`, `name`, and cut schema names in the descriptor. |
| REQ-CTX27-08 | Trusted Helper Snapshot fails mode, symlink, or SHA-256 check on restore | Catalog Gate SHALL leave prior bindings unchanged. | Catalog Gate SHALL return an error naming the failed snapshot validation. |
| REQ-CTX27-10 | Kernel variable is unpicklable during compaction | Compaction Gate SHALL drop the variable from the snapshot and continue compaction. | Compaction Gate SHALL list the dropped variable name in `open_items`. |
| REQ-CTX27-13 | Compaction Snapshot write fails or SHA-256 mismatches | Compaction Gate SHALL return `{ cancel: true }` and abort compaction. | omp SHALL throw `CompactionCancelledError` and set status `Compaction cancelled`. |

## 8. Completion Promise (Ralph Loop Exit)

> Tests 1–4 pass in CI against `ContextEfficiencyEnforcer`, `saveTrustedHelperSnapshot`, `assemblePromptWithCatalogCards`, and `findLeakedPayloadValueSlices`, and the Fixture Transcript excluding user prompts, F-inline, F-turn, and F-session is at most 700 Proxy Counter tokens.

## 9. Contract Authority

**Authoritative Sources**: `contracts/context_efficiency_enforcement.contract.py` and `contracts/context_efficiency_enforcement.contract.ts`

requirements/REQUIREMENT_MANIFEST_CTX27.md (this file)
        ↓
plans/context-efficiency-enforcement.plan.yml
        ↓
contracts/context_efficiency_enforcement.contract.py / .ts
        ↓
packages/coding-agent/test/context-efficiency-enforcement.test.ts
        ↓
packages/coding-agent/src/context/context-efficiency-enforcement.ts

## 10. Revision History

| Date | Author | Change |
|------|--------|--------|
| 2026-11-05 | Ketema Harris | Initial IEEE 29148 manifest for ketema/omp#27 context efficiency enforcement |
