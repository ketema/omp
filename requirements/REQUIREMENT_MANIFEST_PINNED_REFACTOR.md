# REQ-2026-PINNED-001: Pinned Viewport, Clipboard, and MCP Overlay Refactor

**Authority:** IEEE 29148 / CCABDD

**Status:** Requirements amendment complete and ready for CL11 contract amendment and M3 plan review.

**Scope:** Pinned interactive viewport reconciliation, terminal-native ordinary selection preservation, explicitly requested fullscreen-overlay pointer input, and a focused `/mcp list` information overlay.

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
>
> "A"
>
> "The pinned-dock commit deliberately replaced host-native selection ownership" this was Probably a BAD decision. you should have stayed within the proven repo conventions not roll your own overly complex solution that has now created a cascade of problems. I strongly advise going back to the root and analyzing this decision. ponytail rules: amallest change possible to achieve the objective.
>
> "NATIVE APPROVED"
> "1 is approved"
> "2. defer it"
>
> "this is an example of you an llm not listening. i explicitly said that there is no unpinned inline mode. you can check past convos. there is no point or need for the prompt input box to ever not be pinned"
>
> "2"
>
> "A."

**Confirmed understanding:**

1. Ordinary pinned-transcript drag selection remains terminal-native: TUI does not synthesize selected bytes, OSC 52, or native-pasteboard delivery from a pointer gesture.
2. `/mcp list` presents focused, scrollable, Escape-dismissible information instead of persistent transcript output.
3. The pinned dock, software transcript window, alternate-screen behavior, overlays, and keyboard viewport navigation remain available without taking pointer-selection ownership.
4. The user rejected cross-pane copied bytes, persistent `/mcp list` output, pinned-local error banners, status-text-only copy errors, and the app-owned selection subsystem that created the pointer-copy path.
5. Pinned mode does not enter `?1002h` or `?1006h` merely to support ordinary selection; host-native selection is the authoritative path. This slice removes the existing ordinary pinned SGR wheel-to-scroll path; any future app-owned wheel feature is deliberately out of scope.
6. A fullscreen overlay owns terminal mouse reporting only when its `mouseTracking` option is explicitly `true`; omitted or `false` leaves native terminal pointer behavior unclaimed.
7. Decision 9A keeps the prompt input box pinned throughout its interactive TUI lifecycle; no inline or unpinned viewport mode is permitted.
8. Decision 9B requires `TUI.start()` to render the first prompt frame in the pinned dock without acquiring alternate-screen ownership merely for startup; fullscreen overlays retain their independently requested alternate-screen behavior.
9. Decision 9C sets alternate-screen exit behavior: an explicit pinned session returns its owned alternate screen to the primary screen and preserves the pinned dock and prompt; overlay- and resize-owned state remains untouched.
10. Inherited pinned-render integrity and provider-fixture remediation are deferred as recorded plan debt; this decision does not weaken their authoritative contract clauses.
11. The newly observed pre-existing keyboard page-navigation binding defect moves to a deferred plan slice; `POST-PV-14` remains an authoritative contract obligation and does not block the explicit-overlay opt-in correction.
**Ambiguity Score:** 0 — Decisions 9B and 9C adjudicate the startup and explicit pinned-exit alternate-screen lifecycle.

## 2. Actor Matrix

| Actor | Permission Level | Prohibited Actions |
|---|---|---|
| User | Selects intended visible behavior and accepts real-world execution. | Cannot bypass machine-gated state transitions. |
| TUI | Renders pinned frames and keyboard viewport navigation without taking ordinary pointer-selection ownership. | Cannot enter pinned mouse reporting or synthesize pointer-selected clipboard bytes solely because pinned mode is active. |
| PinnedViewport | Owns transcript windowing and scroll position. | Cannot truncate semantic history to the visible frame or define ordinary pointer-selection boundaries. |
| Composer | Supplies pinned transcript lines. | Cannot reintroduce inline viewport behavior. |
| MCPCommandController | Builds MCP server inventory text. | Cannot persist `/mcp list` through generic command-output presentation. |
| InteractiveMode | Presents focused MCP overlays and styled errors outside ordinary native selection. | Cannot leave a focused overlay without Escape dismissal and editor-focus restoration. |
| ClipboardTransport | Remains available only to separately specified non-pointer delivery paths. | Cannot become a fallback for ordinary native pinned selection. |
| ImplementationModule | Implements production behavior. | Cannot import a contract specification file. |

## 3. State Transition

- **Initial State:** Pinned mode enters `?1002h/?1006h`, consumes pointer drag reports, synthesizes visual selections, and emits an application-owned OSC 52 copy payload.
- **Transformation:** Preserve the dock, software transcript window, explicit alternate-screen rendering, overlays, and keyboard navigation while returning ordinary pointer selection to the terminal; remove pinned-mode mouse-report ownership and pointer-copy delivery; render the startup dock without acquiring alternate-screen ownership solely to show the first prompt; after an explicit pinned-screen entry, release only the pinned session's alternate-screen ownership while retaining the dock.
- **Terminal State:** TUI renders the first and post-exit pinned dock without enabling `?1002h/?1006h` or `?1049h` merely for startup; after `TUI.exitPinned()` it returns an explicitly pinned-owned alternate screen to the primary screen while retaining the dock; it leaves overlay- or resize-owned alternate-screen lifecycles untouched; MCPCommandController presents `/mcp list` as focused overlay information without persistent transcript mount.

## 3.5 Integration Specification

### Dependency Graph

1. TUI depends on PinnedViewport for visible transcript scrolling and frame composition.
2. Composer depends on TranscriptContainer for full transcript-line generation.
3. TUI depends on Terminal native selection by leaving ordinary pinned pointer gestures unclaimed.
4. MCPCommandController depends on InteractiveMode for focused MCP inventory presentation.
5. ClipboardTransport has no dependency edge from ordinary pinned pointer selection in this slice.

### Control Flow Requirements

| ID | Caller | Must Invoke | Temporal Constraint | Breaks If Missing |
|---|---|---|---|---|
| SEQ-PV-1 | TUI.#renderPinnedFrame | PinnedViewport.composeFrame | Before overlay compositing | Pinned frame lacks its base transcript window. |
| SEQ-PV-2 | TUI.#renderPinnedFrame | TUI.#compositeOverlaysIntoWindow | After composeFrame and before alternate-frame emission | Floating overlays become invisible while retaining focus. |
| SEQ-PV-3 | Fullscreen overlay lifecycle | Terminal mouse reporting | Only while a fullscreen overlay explicitly requests pointer interaction | Overlay pointer controls cannot receive their declared input. |
| SEQ-MCP-1 | MCPCommandController.#list | InteractiveMode.showSessionInfo | After inventory formatting and before command return | MCP inventory persists in transcript history. |
| SEQ-PV-10 | TUI.enterPinned | Terminal alternate-screen ownership and native selection | Upon an explicit pinned-screen entry and before that entry's first frame, while leaving `?1002h/?1006h` unwritten | Explicit pinned-screen behavior lacks its existing terminal lifecycle. |
| SEQ-PV-11 | TUI.start | Pinned dock activation | Before the first interactive frame, without acquiring alternate-screen ownership solely for startup | Startup consumes the independently requested fullscreen-overlay lifecycle or renders an inline prompt. |
| SEQ-PV-12 | TUI.exitPinned | Pinned-session alternate-screen release and dock render | After an explicit pinned entry when the pinned session owns the alternate screen; preserve the dock and do not release overlay- or resize-owned screen state | Exit either unpins the prompt, leaves a pinned-owned alternate screen active, or releases another lifecycle's screen. |

### Integration Points Checklist

| ID | Source | Target | Handoff Data | Temporal Constraint | Contract Clause | Recorded Exception |
|---|---|---|---|---|---|---|
| IP-PV-1 | TUI.enterPinned | Terminal alternate-screen ownership and native selection | Explicit pinned-screen entry emits its owned alternate-screen transition without `?1002h/?1006h` pinned-mode entry | Before an explicitly requested pinned-screen frame | `pinned_dock.contract.ts::POST-PV-11, POST-PV-25, SEQ-PV-10, INV-PV-15, FORBIDDEN-PV-5` | |
| IP-MCP-1 | MCPCommandController.#handleList | InteractiveMode.showSessionInfo | Fully formatted configured-server inventory | After inventory formatting and before command return | `mcp_list_overlay.contract.ts::POST-MCP-2, SEQ-MCP-1` | |
| IP-PV-4 | TUI.#handlePinnedInput | Terminal native selection | Ordinary SGR pointer reports remain unparsed and unclaimed by the pinned selection path; the existing pinned SGR wheel-to-scroll branch is removed | During a pinned pointer gesture | `pinned_dock.contract.ts::FORBIDDEN-PV-7, FORBIDDEN-PV-8, ERRORS-PV-6` | No SEQ clause: the required behavior is absence of any TUI parser, callback, or terminal-mode handoff. |
| IP-PV-5 | TUI.#doRender | Terminal mouse reporting | `?1006h` is enabled only while the top visible fullscreen overlay has `mouseTracking === true` | On fullscreen-overlay entry, option changes, and dismissal | `pinned_dock.contract.ts::POST-PV-27, SEQ-PV-3, LIFETIME_INV-PV-1` | |
| IP-PV-6 | TUI.start | Pinned dock activation | First prompt frame is docked without startup `?1049h` ownership | Before the first interactive frame | `pinned_dock.contract.ts::POST-PV-28, SEQ-PV-11, INV-PV-17` | |
| IP-PV-7 | TUI.exitPinned | Terminal alternate-screen ownership and pinned dock activation | Matching `?1049l` only for a pinned-owned alternate screen; persistent dock on the primary screen | During explicit pinned exit | `pinned_dock.contract.ts::POST-PV-29, SEQ-PV-12, INV-PV-18, FORBIDDEN-PV-10` | |

### Lifecycle Paths

| Component | INIT (created/started by) | CLEANUP (stopped/released by) |
|---|---|---|
| TUI | `TUI.start()` establishes the pinned dock and keyboard input without claiming ordinary pointer selection or alternate-screen ownership merely for startup; explicit pinned-screen and fullscreen-overlay paths own alternate-screen transitions only when invoked. | `TUI.exitPinned()` releases an explicitly pinned-owned alternate screen while retaining the dock; it leaves overlay- or resize-owned state intact; `TUI.stop()` releases any remaining modes it owns. |
| ClipboardTransport | Starts only from a separately specified non-pointer delivery boundary. | No ordinary pinned pointer gesture reaches this component. |
| InteractiveMode overlay | MCPCommandController requests inventory presentation. | Escape invokes overlay close and restores the active editor area. |

## 4. Hard Invariants

| ID | Category | Invariant |
|---|---|---|
| INV-PV-1 | Scrollback | PinnedViewport SHALL NOT truncate scroll history to visible-window height while semantic history exists. |
| INV-PV-2 | Visibility | TUI SHALL NOT omit a visible floating overlay from the pinned terminal frame. |
| INV-PV-3 | Focus | TUI SHALL NOT assign input focus to an invisible or uncomposited component. |
| INV-PV-4 | Packet Loss | While an explicitly pointer-interactive fullscreen overlay owns tracking, TUI SHALL NOT drop concatenated SGR mouse reports from one stdin buffer chunk; ordinary pinned mode leaves those reports unclaimed. |
| INV-PV-5 | Content Integrity | TUI SHALL NOT overwrite transcript content lines with navigation or follow hints. |
| INV-PV-6 | Contract Coupling | ImplementationModule SHALL NOT import a contract specification file. |
| INV-PV-7 | Pinned Prompt Lifecycle | TUI SHALL render the prompt input box only in the pinned dock throughout its interactive lifecycle. |
| INV-PV-8 | Dock Placement | PinnedViewport SHALL place the dock in the final dock-height rows of the physical frame. |
| INV-PV-9 | Terminal Discipline | TUI SHALL NOT use DECSTBM to pin the dock. |
| INV-PV-10 | Native Scrollback | TUI SHALL NOT emit retired interactive transcript rows to native terminal scrollback. |
| FORBIDDEN-MCP-1 | MCP Information Lifecycle | MCPCommandController SHALL NOT route `/mcp list` through showCommandMessage or presentCommandOutput. |
| FORBIDDEN-PV-5 | Native Selection Ownership | TUI SHALL NOT emit an application-owned OSC 52 payload for an ordinary pinned pointer gesture. |
| INV-PV-15 | Mouse Mode Ownership | TUI SHALL NOT write `?1002h` or `?1006h` solely because pinned mode is active. |
| FORBIDDEN-PV-7 | Wheel Ownership | TUI SHALL NOT apply an ordinary pinned SGR wheel report to PinnedViewport.scrollBy. |
| FORBIDDEN-PV-8 | Pointer Input Ownership | TUI SHALL NOT parse or consume an ordinary pinned SGR pointer report unless an explicitly pointer-interactive fullscreen overlay owns input. |
| INV-PV-16 | Overlay Mouse Opt-In | TUI SHALL gate fullscreen-overlay mouse-reporting enablement on a `mouseTracking` option equal to `true`. |
| LIFETIME_INV-PV-1 | Mode Lifecycle | Across pinned entry, explicit overlay ownership transfer, pinned exit, and stop, TUI SHALL enable and release only terminal modes it owns. |
| INV-PV-17 | Startup Alternate-Screen Ownership | TUI SHALL NOT emit `?1049h` solely to render the first pinned prompt frame after `TUI.start()`. |
| INV-PV-18 | Explicit Pinned Exit Dock Continuity | `TUI.exitPinned()` SHALL retain the dock and prompt after an explicit pinned exit. |
| FORBIDDEN-PV-10 | Explicit Pinned Exit Ownership | `TUI.exitPinned()` SHALL NOT emit `?1049l` for an alternate screen owned by an overlay or resize lifecycle. |

## 5. High-Entropy Zones

| Zone | Question | Resolution | Decided By |
|---|---|---|---|
| Native delivery | Does ordinary pinned pointer selection retain OSC 52 and native pasteboard delivery? | No. Decision 6A supersedes 1A/3A/4A for ordinary pinned pointer selection; the terminal owns that interaction. | User (6A; Decided By: User) |
| MCP inventory lifecycle | Does `/mcp list` persist as transcript output or appear as focused information? | Use a scrollable, Escape-dismissible overlay with no persistent transcript mount. | User (2A) |
| Copy-failure surface | Where does a total copy failure appear for separately specified non-pointer delivery? | Use the established styled showError surface in transcript history. | User (3A) |
| Selection ownership | Does TUI own ordinary pointer selection while pinned? | No. Preserve terminal-native selection by not enabling pinned `?1002h/?1006h` reporting; retain keyboard navigation, remove the existing ordinary pinned SGR wheel branch, and defer any future app-owned wheel feature. | User (6A; Decided By: User) |
| Gesture qualification | Does a same-cell press/release with no motion count as a copyable one-cell selection? | Not applicable to ordinary pinned pointer selection after decision 6A; it remains historical only if a separately approved app-owned selection path is introduced. | User (5A; Decided By: User) |
| Overlay pointer ownership | Does a fullscreen overlay with omitted `mouseTracking` receive terminal mouse reporting? | No. Only `mouseTracking === true` is an explicit pointer-interaction request; omitted and `false` retain native terminal pointer behavior. | User (7A; Decided By: User) |
| Keyboard page-navigation repair | Does this increment repair the pre-existing `tui.viewport.pageUp` / `pageDown` keybinding defect exposed by POST-PV-14 RED evidence? | No. Defer it to a dedicated slice; retain POST-PV-14 as an authoritative obligation. | User (7B; Decided By: User) |
| Pinned prompt lifecycle | May the prompt input box render outside the pinned dock before entry or after exit? | No. Decision 9A keeps the prompt input box pinned throughout its interactive TUI lifecycle; no inline or unpinned viewport mode is permitted. | User (9A; Decided By: User) |
| Startup alternate-screen ownership | Does `TUI.start()` enter `?1049h` merely to render the first docked prompt? | No. Startup renders the pinned dock without TUI alternate-screen ownership; an explicitly requested fullscreen overlay retains its independent lifecycle. | User (9B; Decided By: User) |
| Explicit pinned-exit alternate-screen disposition | After an explicit `TUI.enterPinned()` owns the alternate screen, does `TUI.exitPinned()` release it while retaining the dock, or retain it? | Release the pinned-owned alternate screen and retain the dock on the primary screen; do not release overlay- or resize-owned state. | User (9C; Decided By: User) |
## 5.5 Rejected Alternatives

| Decision | Alternative Considered | Why Rejected | Decided By |
|---|---|---|---|
| MCP inventory overlay | Persistent command-output transcript block | It leaves `/mcp list` information in history instead of a focused dismissible view. | User (2A) |
| Copy-failure surface | Pinned-local error banner | It introduces a separate visual lifecycle instead of the established error surface. | User (3A) |
| Copy-failure surface | Status text | It lacks the established error severity and durable actionable context. | User (3A) |
| Selection ownership | App-owned SGR drag parsing, visual selection reconstruction, and OSC 52 delivery | It replaces the proven terminal-native path and created the current gesture/copy complexity. | User (6A) |
| Overlay pointer ownership | Default-on fullscreen overlay mouse reporting | It grants application pointer ownership without an explicit request and conflicts with terminal-native ordinary selection. | User (7A; Decided By: User) |
| Keyboard page-navigation repair | Repair the unregistered page-navigation bindings in the Decision 7A active slice | It expands the approved explicit-overlay opt-in correction beyond the user-selected scope. | User (7B; Decided By: User) |
| Pinned prompt lifecycle | Any inline or unpinned prompt-input surface | The user stated there is no point or need for the prompt input box ever not to be pinned. | User (9A; Decided By: User) |
| Startup alternate-screen ownership | Startup `?1049h` acquisition solely to render the first docked prompt | It makes fullscreen overlays guests of a startup-owned canvas and caused verified cross-cutting regression failures. | User (9B; Decided By: User) |
| Explicit pinned-exit alternate-screen disposition | Retain the pinned-owned alternate screen after `TUI.exitPinned()` | It leaves an explicit exit request fullscreen despite the selected dock-independent lifecycle. | User (9C; Decided By: User) |

## 6. Tool/API Interface Summary

| Interface | Purpose | Mutates State? | Called By | Triggered When |
|---|---|---|---|---|
| TUI.start | Establishes the first pinned dock frame without startup alternate-screen ownership. | Yes | Interactive runtime | Interactive TUI startup |
| TUI.enterPinned | Activates pinned rendering without claiming ordinary terminal pointer selection. | Yes | Interactive runtime | Pinned mode begins |
| TUI.exitPinned | Releases an explicitly pinned-owned alternate screen while retaining the pinned dock on the primary screen. | Yes | Interactive runtime | Explicit pinned exit request |
| Terminal native selection | Selects and copies ordinary pinned transcript text. | Yes | Terminal host | User drags and copies text |
| ClipboardTransport | Handles only separately specified non-pointer delivery paths. | Yes | Explicit non-pointer caller | Contracted non-pointer request |
| MCPCommandController.#list | Formats configured MCP server inventory. | No | Slash-command dispatch | `/mcp list` |
| InteractiveMode.showSessionInfo | Presents scrollable, focused, Escape-dismissible information. | Yes | MCPCommandController.#list | Completed MCP inventory formatting |

## 6.5 Blocking Dependencies

| Unresolved Zone | Blocks |
|---|---|
| None | Decisions 9B and 9C resolve the requirements-level alternate-screen lifecycle; contract amendment and re-planning may proceed. |

## 7. Failure Mode Specification

| Requirement | Failure Condition | Behavior | Notification |
|---|---|---|---|
| Ordinary pinned native selection | Terminal host cannot produce the user-selected text in the required real Herdr/tmux exercise. | TUI SHALL NOT synthesize OSC 52 or native-pasteboard fallback; record the execution failure for human review. | Human observes the failed real-terminal exercise. |
| Pinned mouse-mode ownership | A pinned entry would write `?1002h` or `?1006h`. | Reject the behavior by contract test before release. | Test failure cites the violated native-selection clause. |
| Fullscreen overlay pointer tracking | `mouseTracking` is omitted or `false`. | TUI SHALL NOT enable terminal mouse reporting; contract tests reject a mode write. | Test failure cites the explicit-overlay clause. |
| `/mcp list` | No configured servers exist. | Present the existing no-server guidance in the focused overlay. | Overlay remains scrollable and Escape-dismissible. |
| `/mcp list` | Overlay closes through Escape or cancel. | Hide overlay and restore focus to the active editor area. | MCPCommandController leaves transcript output unchanged. |
| Startup dock ownership | Startup rendering attempts to emit `?1049h` solely to show the first pinned prompt. | Reject the behavior by contract test before release. | Test failure cites the startup alternate-screen clause. |
| Explicit pinned exit ownership | `TUI.exitPinned()` finds no pinned-owned alternate screen, or an overlay/resize lifecycle owns it. | Retain the dock and intentionally do not emit `?1049l`; release only a pinned-owned alternate screen. | The test suite SHALL surface the named explicit pinned-exit ownership clause when execution crosses an ownership boundary. |

## 8. Completion Promise

> Completion of the active Decision 7A, Decision 9A, Decision 9B, and Decision 9C slices requires one canonical contract per domain, genuine RED discriminators for pinned mode emission, fullscreen-overlay `mouseTracking` omitted/false/true behavior, a prompt-input lifecycle that never renders unpinned, a first startup prompt frame that does not acquire alternate-screen ownership solely for docking, and an explicit pinned exit that returns only its own alternate screen to the primary buffer while retaining the dock; minimal GREEN corrections; live focused execution evidence; a real Ghostty and Herdr pane-confinement exercise using terminal-native drag/copy; and human acceptance of observed behavior. The pre-existing POST-PV-14 keyboard page-navigation defect remains a separately deferred contract obligation.

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
| 2026-09-10 | User and coordinator | Recorded decision 5A: only a gesture containing at least one motion event may copy a one-cell selection; a no-motion click is an intentional no-op. |
| 2026-09-10 | User and coordinator | Recorded decision 6A: ordinary pinned pointer selection remains terminal-native; pinned entry does not enable `?1002h/?1006h`, app-owned pointer copy and the existing ordinary SGR wheel branch are removed, keyboard navigation remains, and any future app-owned wheel feature is deferred. |
| 2026-09-10 | User and coordinator | Recorded decision 7A: fullscreen overlay mouse reporting is explicit opt-in (`mouseTracking === true`); inherited non-native legacy debt is deferred without relaxing its authoritative clauses. |
| 2026-09-10 | User and coordinator | Recorded decision 7B: defer the pre-existing POST-PV-14 keyboard page-navigation binding defect to a dedicated plan slice; preserve the clause authority and do not expand Decision 7A GREEN scope. |
| 2026-09-10 | User and coordinator | Recorded decision 9A: the prompt input box remains pinned throughout its interactive lifecycle; no inline or unpinned viewport mode or path is permitted. |
| 2026-09-12 | User and coordinator | Recorded decision 9B from verbatim User response `"2"`: `TUI.start()` must render the first prompt in the pinned dock without acquiring alternate-screen ownership merely for startup; fullscreen-overlay ownership remains independent. |
| 2026-09-24 | User and coordinator | Recorded decision 9C from verbatim User response `"A."`: after explicit `TUI.enterPinned()` ownership, `TUI.exitPinned()` releases only the pinned session's alternate screen and retains the dock on the primary screen; overlay- and resize-owned state remains untouched. |
