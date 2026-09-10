# REQ-2026-PINNED-001: Pinned Viewport, Clipboard, and MCP Overlay Refactor

**Authority:** IEEE 29148 / CCABDD

**Status:** Requirements complete and ready for CL11 contract generation.

**Scope:** Pinned interactive viewport reconciliation, native macOS delivery for pinned-selection copies, and a focused `/mcp list` information overlay.

## CCABDD Governance

Human intent and real-world acceptance remain human-owned. This manifest records machine-verifiable requirements and decision provenance; tests and audits do not establish human acceptance.

## Actors

| Actor | Identifier |
|---|---|
| User | HUMAN_USER |
| TUI | TUI |
| PinnedViewport | PINNED_VIEWPORT |
| Composer | COMPOSER |
| MCPCommandController | MCP_COMMAND_CONTROLLER |
| InteractiveMode | INTERACTIVE_MODE |
| ClipboardTransport | CLIPBOARD_TRANSPORT |
| ImplementationModule | IMPLEMENTATION_MODULE |

## 1. Intent Traceability

**Source Prose:**

> "how did you allow this to happen? why are MORE issues being created? we have a reference implementation in ~/projects/prime-agent. we have a test suite. this is a completely new bug. i do not want to flap back and forth. follow CCABDD and properly refactor this code. you must have requirements, a plan file, contracts and non theater tests. execute constitutional-refactor IN FULL. read EVERY byte of the file and execute every step... you are the orchestrator and you must orchestrate Grok to constitutional completion."
>
> "Rejected by User: selection highlight and pasted clipboard payload cross from the originating Herdr pane into the neighboring pane. The pasted evidence interleaves both panes and includes divider glyphs. This is copied-data contamination, not merely visual spill. Passing tests do not override this rejection."
>
> "1 -> A"
>
> "2 -> A -> accepted. dismiss maintenance mode. the ai panel is not critical. you can perform the same external multi model multi provider critique via manual dispatch of a sub agent."
>
> "3A"
>
> "4A"

**Confirmed understanding:**

1. Pinned selection emits OSC 52 for compatibility and uses native macOS pasteboard provider resolution as the authoritative local-success signal.
2. `/mcp list` presents focused, scrollable, Escape-dismissible information instead of persistent transcript output.
3. A total pinned-selection copy failure uses the existing styled `showError` surface and remains in transcript history.
4. The user rejected cross-pane copied bytes, persistent `/mcp list` output, pinned-local error banners, and status-text-only copy errors.

**Disconnect Matrix:** `requirements/DISCONNECT_MATRIX_PINNED_JITTER.md` is the observed-versus-expected ledger. It includes the legacy pinned regressions plus clipboard transport and MCP output deltas.

**Ambiguity Score:** 0. User decision 4A defines native provider resolution as the total-copy-success predicate and forbids clipboard readback.

## 2. Actor Matrix

| Actor | Permission Level | Prohibited Actions |
|---|---|---|
| User | Selects intended visible behavior and accepts real-world execution. | Cannot bypass machine-gated state transitions. |
| TUI | Extracts in-app visual selection, renders pinned frames, and emits terminal control sequences. | Cannot rely on host selection to define pane-local copied bytes. |
| PinnedViewport | Owns transcript windowing, scroll position, and visual selection boundaries. | Cannot truncate semantic history to the visible frame. |
| Composer | Supplies pinned transcript lines. | Cannot reintroduce inline viewport behavior. |
| MCPCommandController | Builds MCP server inventory text. | Cannot persist `/mcp list` through generic command-output presentation. |
| InteractiveMode | Presents overlays and styled errors. | Cannot leave a focused overlay without Escape dismissal and editor-focus restoration. |
| ClipboardTransport | Attempts terminal and native clipboard delivery and preserves result status. | Cannot swallow a native clipboard failure that determines required user feedback. |
| ImplementationModule | Implements production behavior. | Cannot import a contract specification file. |

## 3. State Transition

- **Initial State:** Pinned selection emits only OSC 52; `/mcp list` mounts formatted output in transcript history.
- **Transformation:** Preserve in-app selection extraction while adding native pasteboard delivery and a result boundary; route `/mcp list` formatted inventory to an existing scrollable overlay path.
- **Terminal State:** TUI emits OSC 52 for compatibility, derives local copy success from native pasteboard resolution, and directs native failure to styled error presentation; MCPCommandController presents `/mcp list` as focused overlay information without a persistent transcript mount.

## 3.5 Integration Specification

### Dependency Graph

1. TUI depends on PinnedViewport for visible transcript selection, scrolling, and frame composition.
2. Composer depends on TranscriptContainer for full transcript-line generation.
3. TUI depends on ClipboardTransport for native pasteboard delivery and transport-result reporting.
4. ClipboardTransport depends on InteractiveMode for styled total-failure presentation.
5. MCPCommandController depends on InteractiveMode for focused MCP inventory presentation.

### Control Flow Requirements

| ID | Caller | Must Invoke | Temporal Constraint | Breaks If Missing |
|---|---|---|---|---|
| SEQ-PV-1 | TUI.#renderPinnedFrame | PinnedViewport.composeFrame | Before overlay compositing | Pinned frame lacks its base transcript window. |
| SEQ-PV-2 | TUI.#renderPinnedFrame | TUI.#compositeOverlaysIntoWindow | After composeFrame and before alternate-frame emission | Floating overlays become invisible while retaining focus. |
| SEQ-PV-3 | TUI.#handlePinnedInput | parseSgrMouseStream | Before wheel-delta application | Concatenated trackpad reports are dropped. |
| SEQ-PV-4 | TUI.#copySelectedTranscriptToClipboard | ClipboardTransport delivery boundary | After visual-cell extraction and before copy outcome presentation | Native delivery and user-visible failure cannot be traced. |
| SEQ-PV-5 | ClipboardTransport | InteractiveMode.showError | After native provider rejection or throw | A native local-copy failure remains silent. |
| SEQ-PV-6 | MCPCommandController.#list | InteractiveMode.showSessionInfo | After inventory formatting and before command return | MCP inventory persists in transcript history. |

### Integration Points Checklist

| ID | Source | Target | Handoff Data | Contract Clause |
|---|---|---|---|---|
| IP-PV-1 | TUI.#copySelectedTranscriptToClipboard | ClipboardTransport | ANSI-stripped selected text, OSC 52 compatibility emission attempt, and native-provider result | `pinned_dock.contract.ts::POST-PV-6b, POST-PV-21, SEQ-PV-7` |
| IP-PV-2 | ClipboardTransport | InteractiveMode.showError | Native-provider rejection or thrown failure | `pinned_dock.contract.ts::POST-PV-23, POST-PV-24, SEQ-PV-8, ERRORS-PV-4` |
| IP-MCP-1 | MCPCommandController.#handleList | InteractiveMode.showSessionInfo | Fully formatted configured-server inventory | `mcp_list_overlay.contract.ts::POST-MCP-2, SEQ-MCP-1` |

### Lifecycle Paths

| Component | INIT (created/started by) | CLEANUP (stopped/released by) |
|---|---|---|
| TUI | Interactive runtime enters pinned mode and starts input handling. | TUI exit clears active selection and releases terminal modes. |
| ClipboardTransport | TUI invokes delivery after a completed left-drag selection. | Delivery result resolves before the copy interaction completes. |
| InteractiveMode overlay | MCPCommandController requests inventory presentation. | Escape invokes overlay close and restores the active editor area. |

## 4. Hard Invariants

| ID | Category | Invariant |
|---|---|---|
| INV-PV-1 | Scrollback | PinnedViewport SHALL NOT truncate scroll history to visible-window height while semantic history exists. |
| INV-PV-2 | Visibility | TUI SHALL NOT omit a visible floating overlay from the pinned terminal frame. |
| INV-PV-3 | Focus | TUI SHALL NOT assign input focus to an invisible or uncomposited component. |
| INV-PV-4 | Packet Loss | TUI SHALL NOT drop concatenated SGR mouse reports from one stdin buffer chunk. |
| INV-PV-5 | Content Integrity | TUI SHALL NOT overwrite transcript content lines with navigation or follow hints. |
| INV-PV-6 | Contract Coupling | ImplementationModule SHALL NOT import a contract specification file. |
| INV-PV-7 | Mode Purity | TUI SHALL NOT expose an inline or unpinned viewport mode; Composer SHALL NOT expose one. |
| INV-PV-8 | Dock Placement | PinnedViewport SHALL place the dock in the final dock-height rows of the physical frame. |
| INV-PV-9 | Terminal Discipline | TUI SHALL NOT use DECSTBM to pin the dock. |
| INV-PV-10 | Native Scrollback | TUI SHALL NOT emit retired interactive transcript rows to native terminal scrollback. |
| INV-PV-11 | MCP Information Lifecycle | MCPCommandController SHALL NOT route `/mcp list` through showCommandMessage or presentCommandOutput. |
| INV-PV-12 | Clipboard Truthfulness | ClipboardTransport SHALL NOT report native macOS pasteboard success after the native provider rejects or throws. |
| INV-PV-13 | Copy Failure Visibility | InteractiveMode SHALL present styled showError output after ClipboardTransport receives a native-provider rejection or throw. |

## 5. High-Entropy Zones

| Zone | Question | Resolution | Decided By |
|---|---|---|---|
| Native delivery | Does pinned selection retain OSC 52 while adding local pasteboard delivery? | Emit OSC 52 and invoke the existing native macOS provider. | User (1A) |
| MCP inventory lifecycle | Does `/mcp list` persist as transcript output or appear as focused information? | Use a scrollable, Escape-dismissible overlay with no persistent transcript mount. | User (2A) |
| Copy-failure surface | Where does a total copy failure appear? | Use the established styled showError surface in transcript history. | User (3A) |
| OSC 52 completion | What observable event counts as local copy success when OSC 52 has no protocol acknowledgment? | Native provider resolution is authoritative; OSC 52 remains compatibility emission; clipboard readback is forbidden. | User (4A) |

## 5.5 Rejected Alternatives

| Decision | Alternative Considered | Why Rejected | Decided By |
|---|---|---|---|
| MCP inventory overlay | Persistent command-output transcript block | It leaves `/mcp list` information in history instead of a focused dismissible view. | User (2A) |
| Copy-failure surface | Pinned-local error banner | It introduces a separate visual lifecycle instead of the established error surface. | User (3A) |
| Copy-failure surface | Status text | It lacks the established error severity and durable actionable context. | User (3A) |

## 6. Tool/API Interface Summary

| Interface | Purpose | Mutates State? | Called By | Triggered When |
|---|---|---|---|---|
| TUI.#copySelectedTranscriptToClipboard | Extracts the in-app visual selection for delivery. | No | TUI.#handlePinnedInput | Valid left-drag release |
| ClipboardTransport | Attempts OSC 52 and native macOS pasteboard delivery and returns transport results. | Yes | TUI.#copySelectedTranscriptToClipboard | Non-empty selected text |
| InteractiveMode.showError | Presents styled actionable failure in transcript history. | Yes | ClipboardTransport | Total-copy-failure predicate |
| MCPCommandController.#list | Formats configured MCP server inventory. | No | Slash-command dispatch | `/mcp list` |
| InteractiveMode.showSessionInfo | Presents scrollable, focused, Escape-dismissible information. | Yes | MCPCommandController.#list | Completed MCP inventory formatting |

## 6.5 Blocking Dependencies

| Unresolved Zone | Blocks |
|---|---|
| None | No requirement-level blocker remains; CL11 contract authorities are drafted and M3 planning may proceed after contract review. |

## 7. Failure Mode Specification

| Requirement | Failure Condition | Behavior | Notification |
|---|---|---|---|
| Pinned selection copy | Native provider rejects or throws. | Emit OSC 52 for compatibility, preserve native failure, and direct the failure to InteractiveMode.showError. | Present styled showError without clipboard readback. |
| `/mcp list` | No configured servers exist. | Present the existing no-server guidance in the focused overlay. | Overlay remains scrollable and Escape-dismissible. |
| `/mcp list` | Overlay closes through Escape or cancel. | Hide overlay and restore focus to the active editor area. | MCPCommandController leaves transcript output unchanged. |

## 8. Completion Promise

> Completion requires one canonical contract per domain, genuine failing RED tests, minimal GREEN implementation, live focused execution evidence, a real Ghostty and Herdr pane-confinement exercise, and human acceptance of the observed behavior.

## 9. Contract Authority

- Pinned viewport and clipboard domain: `requirements/contracts/pinned_dock.contract.ts`.
- MCP inventory overlay domain: `requirements/contracts/mcp_list_overlay.contract.ts`.
- Tests bridge each production boundary to its domain contract; production modules do not import either contract file.

## 11. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-08 | Prior work | Established pinned viewport reconciliation requirements. |
| 2026-09-09 | User and coordinator | Recorded decisions 1A, 2A, and 3A; added clipboard and MCP inventory requirements; identified the unresolved OSC 52 completion boundary. |
| 2026-09-09 | User and coordinator | Recorded decision 4A: native pasteboard resolution is authoritative, OSC 52 is compatibility-only, and clipboard readback is forbidden. |
