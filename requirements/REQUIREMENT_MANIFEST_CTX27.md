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
| Kernel Manager | `kernel_manager` |

## 1. Intent Traceability

- **Source Prose**:
  > "Build the enforcement in /Users/ketema/projects/omp for ketema/omp#27. The gate counts with natives.countTokens(text, Encoding.O200kBase) from @oh-my-pi/pi-natives. That counter is the proxy. A vendor tokenizer may differ by 10-20 percent. The gate does not retokenize per model. A result under 1,500 tokens is inline only while the turn still has room. A turn admits at most 1,500 tokens of inline tool text. Once the transcript already holds 6,000 tokens of inline tool text, later results are filed even if each is under 1,500. A result of 1,500 tokens or more is always filed. Issue 27's 1.5 KB line is not the threshold. A descriptor is one JSON object of at most 400 tokens. class and name are required. name is artifact_<id>. Key names and column names are cut at 31 characters. Text keeps 5 head lines and 5 tail lines, each cut at 40 characters. That maximum, counted as punctuation, is 308 tokens. A JSON sample string is cut at 40 characters. If the object still exceeds 400 tokens, drop the sample, then the distributions, until it fits. Do not drop class, name, or the cut schema names. A JSON object descriptor copies no values. A card is at most 80 tokens: name at most 16 characters, signature at most 24, summary at most 32, snapshot basename at most 24. That maximum, counted as punctuation, is 76 tokens. A card contains no function body. A trusted helper snapshot is a regular, user-owned, non-symlink file, mode 0600, whose real path stays under ~/.omp/agent/repl-snapshots/. Its SHA-256 and byte size match manifest.json. ~/.agents/skills/repl-snapshots/restore.py loads the declared names and types. A failed load leaves the previous bindings and returns an error. A verified compaction snapshot is ~/.omp/agent/ipython-compact-<session_id>.pkl: a non-empty xz stream whose decompressed bytes begin with pickle magic 0x80, with the SHA-256 stored in the one record. The one record is Memory MCP entry auto-compact-memory-<session_id>-<seq>. Its body is narrative, descriptors, kernel_handles, snapshot_path, sha256, files_touched, open_items. It contains no payload. If dill.dump_session fails because a name is unpicklable, drop those names, list them in open_items, snapshot the rest, and compact. Refuse only when the snapshot hash does not match the record, or the snapshot write fails. Refusal is { cancel: true } from session_before_compact, then CompactionCancelledError, an unchanged compaction-entry count, and the text Compaction cancelled. Search order and recovery are the search-hierarchy and compaction-recovery skills. The IPython kernel is for durable work of at most 30 seconds. eval is for a longer job that is not a build, test, lint, install, or deploy. tmux is only for those five. Done when tests 1-4 pass in CI. The 700-token cap applies only to F-over plus the three cards plus the compaction status line, excluding user prompts and excluding F-inline, F-turn, and F-session. That transcript is at most 700 tokens."
- **Our Understanding**: `omp` enforces context efficiency through three mechanical gates and prompt assembly: Emission Gate counts tokens with `Encoding.O200kBase`, enforces the 1,500 per-result/per-turn and 6,000 per-session inline budgets, replaces filed outputs with a ≤400-token UDT Descriptor, binds the full payload in IPython Kernel under `artifact_<id>`, and caps display output for that name at 60 lines and 2,048 bytes; Catalog Gate saves helpers to Trusted Helper Snapshots and injects ≤80-token Catalog Cards with zero function bodies on every prompt; Compaction Gate drops unpicklable names to `open_items`, verifies the xz/`0x80`/SHA-256 Compaction Snapshot and single Memory Record, and cancels compaction on hash mismatch or write failure.
- **Ambiguity Score**: 0
- **Source Prose (SLICE-2, 2026-11-05)**:
  > "the model there on a fresh session was completely ignorant. even though it has the context efficiency directives in its system prompt, it failed to even regurgitate that prose when I asked it a simple question. ... and to top it off it had no idea on how to use the repl or the cards. i want a solution to this. a new session needs to use the tools and techniques I have made." / "we are working on item number 1. the workbench must be started automatically in a new session." / "1 -> a 2 -> a 3 -> a" / "Plan approved. Go. Unmount the context efficiency extension"
- **Source Prose (SLICE-2, notice redesign, 2026-11-05)**:
  > "no that is not my intent and not how I want it to work. i want the harness to notify the model via a system message that supports the system prompt so that the model is encouraged and inclined to follow the context efficiency rules" / "no i do not want a constant repeating message every turn that just builds up. that is NOT efficient. when the harness loads the workbench issue a system message into the context. it can fire on the next user message if possible, but i thought omp had its own system message bus that was independent of user messages?" / "modify the requirement then proceed. all linters must pass. follow ccabdd. be context efficient."
- **Our Understanding (SLICE-2)**: When a top-level session that owns an artifacts directory starts, omp starts the IPython Kernel, which loads Ketema's Trusted Helper Snapshots by running his existing `restore.py` inside that kernel. omp then sends one developer-role context message through its own message bus, delivered with the user's next message, that lists the loaded helpers (or the failure cause and every refused snapshot) and states the context efficiency rules so the model follows them. The message is sent once per kernel start, never repeated per turn, and never placed in a tool result. Sessions that own no artifacts directory (in-memory sessions) and subagents keep a lazy kernel, because kernels cost memory on this host. The context efficiency extension is not mounted in any session until Ketema re-approves it.
- **Source Prose (SLICE-3, ipython output filing, 2026-11-05)**:
  > "normal context items need to stay as they are, i never specified any changes to anything except the ipython kernel. reuse what already exists. if it is as simple as defining a new protocol like prefix then do that. ipython:// perhaps?" / "2 - yes let's start with 1500 and see how it works." / "the existing system should work as is. if the kernel is not working then there will be no variables or outputs to save that have anything to do with the kernel. all other mechanisms DO NOT CHANGE. so file://, xd://, paste://, pr:// whatever they all work the same no matter what." / "on the dual pointer we should ensure that it is KNOWN there are 2 access methods for the SAME variable. the artifact:// convention can be for pure full retrieval and the ipython access is preferred and allows processing." / "out_<n> is approved. make sure you do not forget and cover all those risks you pointed out in the tool descriptions." / "I approve the requirements and accept the recommended values for the 3 decisions"
- **Our Understanding (SLICE-3)**: Only the output of the ipython tool changes. When a cell's stdout reaches 800 tokens, the full text stays in the kernel as `out_<n>`, omp saves the same text as a session artifact, and the transcript carries a short descriptor that names both ways to open it, with the kernel variable preferred because it allows processing before anything enters context. Every other tool, protocol and thinking block is untouched, and nothing happens when the kernel is not running. The threshold of 800 was set on 2026-11-05 from a measurement of 56,407 utility calls: the descriptor costs about 210 tokens, and the net saving is flat between 600 and 1,000 tokens.

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
| SEQ-5 | Kernel Manager start sequence | `restore.py` inside IPython Kernel | AFTER kernel bootstrap, BEFORE the first cell executes | A fresh session finds an empty workbench |

### Integration Points Checklist

| ID | Source | Target | Handoff Data | Contract Clause |
|----|--------|--------|--------------|-----------------|
| IP-1 | `omp` tool-result dispatch | Emission Gate | toolCallId, result text → inline text or UDT Descriptor | assigned in contracts |
| IP-2 | Emission Gate | IPython Kernel | `artifact_<id>`, raw payload → SHA-256 parity and capped display | assigned in contracts |
| IP-3 | Catalog Gate | `omp` prompt assembly | `manifest.json` entries → Catalog Cards | assigned in contracts |
| IP-4 | `omp` `session_before_compact` | Compaction Gate | sessionId, kernel state → Memory Record or `{ cancel: true }` | assigned in contracts |
| IP-5 | Kernel Manager | IPython Kernel | `restore.py` → helper names loaded, or the failure cause | assigned in contracts |

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
| REQ-CTX27-15 | Snapshot migration | WHEN the managed Python environment upgrades to CPython `3.14.10`, Catalog Gate SHALL migrate every Trusted Helper Snapshot in `manifest.json` from its neutral Python source to the target Python minor version and atomically update `python_version`, `dill_version`, `sha256`, and `byte_size`. | Test | High | Dill code-object bytecode does not cross Python minor versions; neutral source migration preserves every helper across 3.11 to 3.14.10. |
| REQ-CTX27-16 | Workbench start | WHEN the IPython Kernel of a session starts, Kernel Manager SHALL run `~/.agents/skills/repl-snapshots/restore.py` inside that IPython Kernel BEFORE the first cell executes. | Test | High | A fresh session finds Ketema's helpers on its workbench without being told. |
| REQ-CTX27-17 | Extension unmount | omp SHALL NOT mount the context efficiency extension in any session. | Test | High | In session 01a1aba2 the mounted extension hid 22 tool results and skill files; suspended until Ketema re-approves. |
| REQ-CTX27-18 | Workbench message | WHEN Kernel Manager finishes running `restore.py` at kernel start in a top-level session, omp SHALL send one developer-role context message that lists the helper names that loaded, delivered with the next user message. | Test | High | The model learns what is on its workbench through the harness message bus, not through a tool result. |
| REQ-CTX27-19 | Workbench rules | WHEN omp sends the workbench message, omp SHALL end the message with the context efficiency rules approved in Z11. | Test | High | The message reinforces the system prompt at the moment the workbench appears. |
| REQ-CTX27-20 | No repeat | omp SHALL NOT resend the workbench message after the user's next message for the same kernel start. | Test | High | A message repeated every turn accumulates in the transcript and defeats context efficiency. |
| REQ-CTX27-21 | No tool-result notice | omp SHALL NOT place workbench message text in any ipython tool result. | Test | High | Notice text mixed into cell output made the model rerun the cell. |
| REQ-CTX27-22 | Kernel at launch | WHEN a top-level session that owns an artifacts directory starts, omp SHALL start the IPython Kernel before the user's first message. | Test | High | The workbench exists when a real session begins, not after the first ipython call; in-memory sessions stay lazy to save memory. |
| REQ-CTX27-23 | Output filing | WHEN an ipython cell's stdout reaches 800 o200k tokens and the cell raised no error, omp SHALL keep the full stdout in the IPython Kernel variable `out_<n>` and replace that stdout in the tool result with a descriptor. | Test | High | A large printed result stays in the kernel where code can process it, instead of in every later turn. |
| REQ-CTX27-24 | Output naming | WHEN omp files an ipython output, omp SHALL name the variable `out_<n>`, counting filed outputs from 1 in each session and skipping any name already bound. | Test | High | A filed output never replaces a variable the model or Ketema created. |
| REQ-CTX27-25 | Artifact copy | WHEN omp files an ipython output, omp SHALL save the same full text as a session artifact through the session artifact manager. | Test | High | The text survives a kernel restart and is retrievable with the existing artifact:// protocol. |
| REQ-CTX27-26 | Descriptor | WHEN omp files an ipython output, omp SHALL state in the descriptor the variable name, line count, size, token count, the first 5 and last 5 lines cut at 100 characters, and both access methods with the kernel variable marked preferred. | Test | High | The model decides whether to open the output from the descriptor alone. |
| REQ-CTX27-27 | Passthrough | omp SHALL leave ipython stderr, tracebacks, expression results and stdout below 800 tokens unchanged in the tool result. | Test | High | The model always sees errors, small outputs and values directly. |
| REQ-CTX27-28 | Tool description | omp SHALL state in the ipython tool description that a filed output has two access methods for the same data, that kernel access ranks first because it allows processing before anything enters context, that artifact:// returns the whole unchanged text and needs paging, and that rebinding the variable leaves the artifact unchanged. | Test | High | The model must know about both doors before it meets a descriptor. |
| REQ-CTX27-29 | No other tool | omp SHALL NOT file, truncate or rewrite the result of any tool other than ipython. | Test | High | Normal context items stay as they are (Ketema, 2026-11-05). |
| REQ-CTX27-30 | Output ceiling | WHEN ipython stdout exceeds 16 MiB, omp SHALL keep the first 16 MiB and state the cut in the descriptor. | Test | High | A runaway print cannot exhaust memory in the kernel, the artifact store or the host. |
| REQ-CTX27-31 | Whole-read refusal | WHEN a read of `artifact://<id>` names an ipython filed output and carries no line range, omp SHALL refuse the call and state in the refusal that the answer comes from `out_<n>` in ipython or from the range form `artifact://<id>:1-60`. | Test | High | In session 01a1add1 the whole 1,189-token text came back into context and cancelled the saving. |
| REQ-CTX27-32 | Descriptor instruction | omp SHALL state in the descriptor that the answer comes from `out_<n>` in ipython, that the model pastes no filed lines into its reply, and that the model reads the artifact by range only. | Test | High | The model skipped the preferred route and retyped all 100 rows into its reply. |

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
| Z7 | Which sessions start the IPython Kernel at launch | Top-level sessions that own an artifacts directory; in-memory sessions and subagents start it on first use | User (CL4, amended 2026-11-05) |
| Z8 | Which loader runs at kernel start | Ketema's existing `~/.agents/skills/repl-snapshots/restore.py` | User (CL4) |
| Z9 | How the workbench load is announced | One developer-role message sent through omp's message bus at load and delivered with the next user message; never a tool-result line, never repeated per turn | User (CL4, 2026-11-05) |
| Z10 | Context efficiency extension in live sessions | Unmounted in every session | User (CL4) |
| Z11 | Wording of the context efficiency rules in the workbench message | Draft by the coding agent from Ketema's goal statement (session 01a18024, line 1286); held in one contract constant so Ketema can edit it and the tests follow | User (CL4): authorized proceeding with the draft, wording editable |
| Z12 | Cost of a kernel at launch vs the session isolation contract | Option 3: start at launch only for sessions that own an artifacts directory, so the existing rule that a lifecycle event for an in-memory session creates nothing still holds; resource management is critical on this host | User (CL4, 2026-11-05): "I choose option 3. resource management is critical on this system." |
| Z13 | What the filing threshold measures | Stdout only; an expression result (`repr`) stays inline for now | User (CL4, 2026-11-05): accepted the recommended value |
| Z14 | Ceiling for one filed output | 16 MiB | User (CL4, 2026-11-05): accepted the recommended value |
| Z15 | Name of the filed variable | `out_<n>`; the IPython `Out[n]` dict is not filled by this kernel (history is not stored), so it would be an unused convention here | User (CL4, 2026-11-05): "out_<n> is approved" |
| Z16 | How the filed output is reached | Two access methods for the same data: the kernel variable (preferred, allows processing) and the existing artifact:// copy (whole unchanged text); the ipython:// protocol comes in a later slice | User (CL4, 2026-11-05) |
| Z17 | Whole read of a filed artifact | omp refuses the read call only; it does not rewrite the result of any tool, touches no other artifact and no other protocol, so REQ-CTX27-29 stands | User (CL4, 2026-11-05): "let's implement #2 next. that is a quick win. include #3 and #4 as well" |

## 5.5 Rejected Alternatives

| Decision | Alternative Considered | Why Rejected |
|----------|------------------------|--------------|
| 5 head + 5 tail lines at 40 chars | 10 head + 10 tail lines at 120 chars | Exceeds the 400-token descriptor cap (up to 1,648 tokens on punctuation) |
| Drop unpicklable names to `open_items` | Refuse compaction on any unpicklable variable | One open socket or generator would permanently block compaction until session death |
| Per-turn (1,500) + per-session (6,000) budgets | Per-result threshold alone | Fifty 1,400-token results would pass the gate and flood context |
| Workbench notice as the first line of the first ipython result | Message through omp's message bus | The notice appears only after an ipython call and mixes into cell output; the model reran the cell to separate them |
| Rules appended to the system prompt on every turn | One message at workbench load | Repeating text every turn accumulates and defeats context efficiency (Ketema, 2026-11-05) |
| Rewrite or file the results of every tool | File only ipython output | Ketema: only the ipython kernel changes; normal context items stay as they are |
| Use the IPython `Out[n]` dict for the filed text | `out_<n>` | This kernel runs cells without storing history, so `Out` holds almost nothing and would be a misleading name |
| One access method (artifact:// only) | Both the kernel variable and the artifact copy | artifact:// cannot filter before the text enters context; the variable cannot survive a kernel restart |

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
| REQ-CTX27-15 | A Trusted Helper Snapshot has no recoverable Python source or fails target compilation during migration | Catalog Gate SHALL abort the migration without modifying `manifest.json` or existing snapshot files. | Catalog Gate SHALL raise an error naming the unmigratable snapshot record ID. |
| REQ-CTX27-16 | `restore.py` is missing, raises, or refuses a Trusted Helper Snapshot | Kernel Manager SHALL keep the IPython Kernel usable for cell execution. | omp SHALL send the workbench message naming the failure cause and every refused snapshot. |
| REQ-CTX27-23 | omp cannot bind the filed output in the IPython Kernel | omp SHALL return the stdout unchanged in the tool result. | omp SHALL add one line to the tool result saying that filing the output failed. |
| REQ-CTX27-25 | omp cannot save the artifact copy | omp SHALL still bind the kernel variable and return the descriptor. | omp SHALL state in the descriptor that the artifact copy is unavailable. |

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
| 2026-11-05 | Ketema Harris | SLICE-2 item 1a: REQ-CTX27-16 workbench helpers load at kernel start; REQ-CTX27-17 context efficiency extension unmounted; REQ-CTX27-18 workbench notice (Z7-Z10) |
| 2026-11-05 | Ketema Harris | SLICE-2 notice redesign: REQ-CTX27-18 is now a one-time developer-role message; REQ-CTX27-19 to 22 added (rules text, no repeat, no tool-result notice, kernel starts at launch); Z9 replaced, Z11 added |
| 2026-11-05 | Ketema Harris | Q1 decided (option 3): REQ-CTX27-22 and Z7 narrowed to sessions that own an artifacts directory; Z12 added |
| 2026-11-05 | Ketema Harris | SLICE-3 (item 2): REQ-CTX27-23 to 30 added for ipython-only output filing: `out_<n>` kernel variable, artifact:// copy, descriptor, tool description; Z13 to Z16 added |
| 2026-11-05 | Ketema Harris | REQ-CTX27-23 and REQ-CTX27-27: filing threshold lowered from 1,500 to 800 o200k tokens (User, CL4, after the transcript measurement) |
| 2026-11-05 | Ketema Harris | REQ-CTX27-31 and 32 added: refusal of a whole read of an ipython filed artifact, and the answer-from-the-kernel instruction in the descriptor; Z17 added |
