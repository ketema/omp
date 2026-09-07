# REQ-2026-PINNED-COMPOSER: Pinned interactive prompt dock

## CCABDD Governance

Human owns: intent (front) + reality judgment (back).
AI owns: enforcement (middle).
Neither crosses the boundary.

Human MUST confirm real-world effect matches intent.
AI MAY NOT infer success from metrics.

**INV-3**: No discretion. No judgment. Only state.

## Actors

| Actor | Identifier |
|---|---|
| User | Interactive operator |
| TUI | `packages/tui/src/tui.ts` |
| PinnedViewport | `packages/tui/src/pinned-viewport.ts` |
| Composer | `packages/coding-agent/src/modes/composer.ts` |
| TranscriptContainer | `packages/coding-agent/src/modes/components/transcript-container.ts` |
| Overlay | Fullscreen TUI overlay (`/settings` and peers) |

---

## 1. Intent Traceability

- **Source Prose**:
  > "create a bug free implmentation of a pinned omp prompt input area similar to the one prime-agent uses. all tests must pass, ccabdd must be followed."
  >
  > "whenever I scroll up the input box goes away. if I start typing the scroll back jumps back down to the bottom. this is disruptive because when I am reading long output i often need a reference and like to type WHILE i am at the point i am reading the content."
  >
  > "1 > pinned. there should be no option. pinned is how i want it always. period. 2 > Confirmed."
  >
  > "you must use typescript 7 and you must follow the typescript-mastery skill"
- **Our Understanding**: The operator wants the composer (editor and status line) to remain on the last rows of the terminal while they scroll earlier transcript, and to type there without the view jumping to the tail. Interactive OMP is always pinned. There is no inline/native-scrollback mode and no settings toggle. v1 does not flush the in-memory transcript into emulator or tmux history. Tests derive expected behavior from contracts, not from existing code. Existing pin code may be reused. New and changed TypeScript follows TypeScript 7 and typescript-mastery (erasable syntax, `#private`, no `enum` keyword, no unchecked `as`).
- **Ambiguity Score**: 1

## 2. The Actor Matrix

| Actor | Permission Level | Prohibited Actions |
|:------|:-----------------|:-------------------|
| User | Scroll transcript; type in dock | User SHALL NOT be offered a viewport-mode setting |
| TUI | Own alt-screen enter/leave; intercept wheel and page keys; paint composed frames | TUI SHALL NOT re-enter DECSET 1049 while already on the alternate screen |
| PinnedViewport | Own scrollTop and following; compose dock plus window | PinnedViewport SHALL NOT emit CSI |
| Composer | Split scroll rows vs dock rows; start pinned session | Composer SHALL NOT emit HistoryBatch while interactive; Composer SHALL NOT import the contract module |
| Overlay | Paint modal on the existing alt screen | Overlay SHALL NOT write a second DECSET 1049h when pin already owns alt screen |

## 3. The State Transition

- **Initial State ($S_0$)**: Interactive session on the normal buffer; native wheel moves the editor off-screen; a keypress CUP snaps the view to the live grid.
- **Transformation**: Interactive start enters the alternate screen and composes a fixed-height frame (scrolled transcript plus clipped dock).
- **Terminal State ($S_1$)**: Dock occupies the last N screen rows for the whole interactive session. Wheel, PageUp, and PageDown change `scrollTop`. Printable keys mutate the editor without changing `scrollTop` when not following. Follow chord (`ctrl+shift+down`) returns to the tail.

## 3.5 Integration Specification

### Dependency Graph

- PinnedViewport DEPENDS ON clipped dock height for compose
- TUI DEPENDS ON PinnedViewport for scroll state
- TUI DEPENDS ON Terminal alt-screen enter/leave (DECSET 1049)
- Composer DEPENDS ON TUI.enterPinned at start
- Overlay DEPENDS ON existing alt-screen owner (no second 1049 enter)

### Control Flow Requirements (Sequencing Specs)

| ID | Caller | Must Invoke | Temporal Constraint | Breaks If Missing |
|----|--------|-------------|---------------------|-------------------|
| SEQ-1 | Composer.start | TUI.enterPinned | AFTER ui.start | Session stays on the normal buffer |
| SEQ-2 | TUI.#handleInput | PinnedViewport.scrollBy | BEFORE focused editor.handleInput for wheel and page keys | Typing or wheel jumps or fails |
| SEQ-3 | Overlay fullscreen enter | MUST NOT write 1049h if pin already owns alt | DURING overlay enter | Alt buffer clears |
| SEQ-4 | TUI.stop | leave alt screen once | BEFORE terminal.stop | Shell prompt corrupted |
| SEQ-5 | Composer.renderFrame | omit HistoryBatch | every interactive frame | Native scrollback receives retired rows |

### Integration Points Checklist

| ID | Source | Target | Handoff Data | Contract Clause |
|----|--------|--------|-------------|-----------------|
| IP-1 | Composer.renderFrame | TUI.#renderPinnedFrame | pinnedScroll and pinnedDock | SEQ-5 |
| IP-2 | parseSgrMouse | TUI pinned wheel | SgrMouseEvent.wheel | SEQ-2 |
| IP-3 | KeybindingsManager | TUI viewport keys | pageUp, pageDown, top, follow | SEQ-2 |

### Lifecycle Paths

| Component | INIT (created/started by) | CLEANUP (stopped/released by) |
|-----------|--------------------------|-------------------------------|
| PinnedViewport | TUI.enterPinned during Composer.start | TUI.exitPinned / TUI.stop |
| Alt screen | first of pin or overlay | last owner leaving; TUI.stop leaves once |

## 4. Hard Invariants (The "Never" List)

| ID | Category | Invariant |
|----|----------|-----------|
| INV-01 | Dock | TUI SHALL NOT paint the editor above the dock region. |
| INV-02 | Follow | TUI SHALL NOT set following true because a printable key arrived. |
| INV-03 | Alt | TUI SHALL NOT write DECSET 1049h while the session is already on the alternate screen. |
| INV-04 | History | Composer SHALL NOT emit HistoryBatch CRLFs. |
| INV-05 | Coupling | Composer SHALL NOT import the contract file. |
| INV-06 | Mode | TUI SHALL NOT expose or honor an inline/unpinned viewport setting. |

## 5. High-Entropy Zones (Adjudicated)

| Zone | Question | Resolution | Decided By |
|------|----------|------------|------------|
| Viewport mode | pinned default vs toggle | Always pinned. No option. | User |
| Native history flush | dump ring on exit? | v1 does not flush (Prime does not) | User |
| Existing code | rewrite vs reuse | Reuse allowed; tests from contracts only | User |
| TypeScript | dialect | TypeScript 7 + typescript-mastery | User |

## 5.5 Rejected Alternatives

| Decision | Alternative Considered | Why Rejected |
|----------|----------------------|--------------|
| Always-on alt-screen dock | `tui.viewport` inline/pinned setting | User: no option |
| Software viewport | DECSTBM sticky footer | Host-dependent native scroll |
| Keep CUP | Suppress CUP | Breaks IME |
| Port Prime compose/scroll only | Port Prime paint() and selection | Dual diff caches; skip Kitty/IME |

## 6. Tool/API Interface Summary

| Interface | Purpose | Mutates State? | Called By | Triggered When |
|-----------|---------|----------------|----------|----------------|
| PinnedViewport.composeFrame | Build height-row frame | YES (scrollTop clamp) | TUI.#renderPinnedFrame | every pinned paint |
| PinnedViewport.scrollBy | Wheel/page | YES | TUI.#handlePinnedInput | wheel or page keys |
| TUI.enterPinned | Alt screen + mouse | YES | Composer.start | interactive start |
| TUI.stop | Leave alt once | YES | Composer.stop | session end |

## 6.5 Blocking Dependencies

| Unresolved Zone | Blocks |
|-----------------|--------|
| none | — |

## 7. Failure Mode Specification

| Requirement | Failure Condition | Behavior | Notification |
|------------|-------------------|----------|-------------|
| composeFrame height | height < 1 | FAIL FAST throw citing PRE-1 | Exception |
| Overlay while pinned | second 1049h | Forbidden; no-op at DECSET | Tests |

## 8. Completion Promise

TUI SHALL keep the dock on the last N rows. TUI SHALL NOT set following from a printable key. Overlay SHALL NOT write a second 1049h. Composer.start SHALL enter pin. Composer.renderFrame SHALL omit HistoryBatch.

## 9. Contract Authority

**Authoritative Source**: `requirements/contracts/pinned-composer.contract.ts`

## 10. Revision History

| Date | Author | Change |
|------|--------|--------|
| 2026-09-07 | K. Harris | Restart: always pinned, no setting, no v1 flush, TS7 |
