# REQ-2026-PINNED-COMPOSER: Pinned interactive prompt dock

## CCABDD Governance

Human owns: intent (front) + reality judgment (back).
AI owns: enforcement (middle).
Neither crosses the boundary.

**INV-3**: No discretion. No judgment. Only state.

## 1. Intent Traceability

- **Source Prose**:
  > "create a bug free implmentation of a pinned omp prompt input area similar to the one prime-agent uses. all tests must pass, ccabdd must be followed."
  >
  > Prior: "whenever I scroll up the input box goes away. if I start typing the scroll back jumps back down to the bottom. this is disruptive because when I am reading long output i often need a reference and like to type WHILE i am at the point i am reading the content."
- **Our Understanding**: Interactive OMP SHALL keep the composer (editor + status line) on the last rows of the terminal while the user scrolls the transcript. Scroll position SHALL be application state on the alternate screen, matching Prime-agent's FullscreenViewport compose/scroll subset. Typing SHALL NOT yank the transcript window to the tail.
- **Ambiguity Score**: 1
- **Decided By: User**: Prime-like pin; reject DECSTBM and CUP suppression; v1 SHALL NOT flush the in-memory transcript into native scrollback (Prime does not).

## 2. The Actor Matrix

| Actor | Permission Level | Prohibited Actions |
|:------|:-----------------|:-------------------|
| User | Scroll transcript; type in dock; toggle `tui.viewport` | Cannot make the dock leave the physical screen while pinned |
| TUI | Own alt-screen enter/leave; intercept wheel/page keys | SHALL NOT re-enter DECSET 1049 while already on alt screen |
| Composer | Split scroll rows vs dock rows; skip HistoryBatch while pinned | SHALL NOT import the contract module |

## 3. The State Transition

- **Initial State ($S_0$)**: Interactive session on the normal buffer; native wheel moves the editor off-screen; keypress CUP snaps to the active grid.
- **Transformation**: `tui.viewport=pinned` enters alt screen, composes a fixed-height frame (scrolled transcript + clipped dock).
- **Terminal State ($S_1$)**: Dock occupies the last N screen rows. Wheel/PageUp/PageDown change `scrollTop`. Printable keys mutate the editor without changing `scrollTop` when not following.

## 3.5 Integration Specification

### Dependency Graph

- PinnedViewport DEPENDS ON clipped dock height for compose
- TUI DEPENDS ON PinnedViewport for scroll state
- TUI DEPENDS ON Terminal.enter/leave alt screen (1049)
- Composer DEPENDS ON TUI.isPinned for HistoryBatch suppression
- Overlay fullscreen DEPENDS ON existing alt-screen owner (no second 1049 enter)

### Control Flow Requirements

| ID | Caller | Must Invoke | Temporal Constraint | Breaks If Missing |
|----|--------|-------------|---------------------|-------------------|
| SEQ-1 | Composer.start | TUI.enterPinned | AFTER ui.start when viewport is pinned | Session stays on normal buffer |
| SEQ-2 | TUI.#handleInput | PinnedViewport.scrollBy | BEFORE focused editor.handleInput for wheel/page keys | Typing or wheel jumps/fails |
| SEQ-3 | Overlay fullscreen open | MUST NOT write 1049h if pinned already on alt | DURING overlay enter | Alt buffer clears |
| SEQ-4 | TUI.stop | leave alt screen once | BEFORE terminal.stop | Shell prompt corrupted |

### Integration Points

| ID | Source | Target | Handoff |
|----|--------|--------|---------|
| IP-1 | Composer.renderFrame | TUI.#renderPinnedFrame | pinnedScroll + pinnedDock |
| IP-2 | parseSgrMouse | TUI pinned wheel | SgrMouseEvent.wheel |
| IP-3 | KeybindingsManager | TUI viewport keys | pageUp/pageDown/top/follow |

### Lifecycle

| Component | INIT | CLEANUP |
|-----------|------|---------|
| PinnedViewport | TUI.enterPinned | TUI.exitPinned / stop |
| Alt screen | first of overlay or pin | last owner leaving |

## 4. Hard Invariants

| ID | Category | Invariant |
|----|----------|-----------|
| INV-01 | Dock | The system shall not paint the editor above the dock region while pinned. |
| INV-02 | Follow | The system shall not set following true because a printable key arrived. |
| INV-03 | Alt | The system shall not write DECSET 1049h while the session is already on the alternate screen. |
| INV-04 | History | The system shall not emit HistoryBatch CRLFs while pinned. |
| INV-05 | Coupling | Implementation shall not import the contract file. |

## 5. High-Entropy Zones (Adjudicated)

| Zone | Resolution | Decided By |
|------|------------|------------|
| Native history flush | v1: no flush (Prime) | User |
| DECSTBM | Rejected | User / peers |
| Default mode | `pinned` | User (unpinned is unacceptable) |
| composeFrame signature | options object, not Prime positional | typescript-mastery |

## 5.5 Rejected Alternatives

| Decision | Alternative | Why Rejected |
|----------|-------------|--------------|
| Alt-screen software viewport | DECSTBM sticky footer | Host-dependent native scroll |
| Keep CUP | Suppress CUP | Breaks IME |
| Port Prime paint() | Use OMP #emitAltFrame-style paint | Dual diff caches, skip Kitty/IME |

## 6. Tool/API Interface Summary

| Interface | Purpose | Mutates State? |
|-----------|---------|----------------|
| PinnedViewport.composeFrame | Build height-row frame | YES (scrollTop clamp) |
| PinnedViewport.scrollBy | Wheel/page | YES |
| TUI.enterPinned / exitPinned | Alt screen + mouse | YES |
| tui.viewport setting | Mode | YES |

## 7. Failure Mode Specification

| Requirement | Failure Condition | Behavior | Notification |
|------------|-------------------|----------|-------------|
| composeFrame | height < 1 | FAIL FAST throw citing PRE-1 | Exception |
| Invalid mode | not inline/pinned | FAIL FAST throw citing PRE-MODE-1 | Exception |
| Overlay while pinned | re-enter 1049 | Forbidden; no-op at DECSET | Tests |

## 8. Completion Promise

PinnedViewport unit tests plus TUI integration tests SHALL fail if the dock is not the last N rows, if wheel mutates editor text, if following=false stream appends change scrollTop, or if a second 1049h is written while pinned.

## 9. Contract Authority

**Authoritative Source**: `requirements/contracts/pinned-composer.contract.ts`

## 10. Revision History

| Date | Author | Change |
|------|--------|--------|
| 2026-09-06 | omp/grok-4.6 | Initial manifest from prior pin dialogue |
