# REQUIREMENT MANIFEST: Pinned Viewport, Scrollback, and Overlay Compositing Refactor

**Authority**: IEEE 29148 / CCABDD Mandate (2026-09-08)
**Status**: APPROVED
**Scope**: Complete architectural reconciliation of OMP pinned interactive mode against Prime reference (`~/projects/prime-agent/packages/tui/src/fullscreen.ts`), `REQ-2026-PINNED-COMPOSER.md`, and `packages/coding-agent/src/modes/interactive/interactive-mode.ts`.

---

## 1. Intent & Source Prose Traceability
- **Human Intent**:
  > "how did you allow this to happen? why are MORE issues being created? we have a reference implementation in ~/projects/prime-agent. we have a test suite. this is a completely new bug. i do not want to flap back and forth. follow CCABDD and properly refactor this code. you must have requirements, a plan file, contracts and non theater tests. execute constitutional-refactor IN FULL. read EVERY byte of the file and execute every step... you are the orchestrator and you must orchestrate Grok to constitutional completion."
  >
  > "Rejected by User: selection highlight and pasted clipboard payload cross from the originating Herdr pane into the neighboring pane. The pasted evidence interleaves both panes and includes divider glyphs. This is copied-data contamination, not merely visual spill. Passing tests do not override this rejection."
- **Core Problem**:
  Prior ad-hoc attempts created compounding regressions:
  1. Concatenated SGR mouse packets were dropped by anchored regex `/^...$/`, causing scroll inertia.
  2. To "fix" lag, `composer.ts` truncated `pinnedScroll` to `renderViewport(..., height)`, destroying the software scrollback history (`maxScroll = 0`), which completely froze scrollback and caused 0 output rows when headers/containers filled the frame.
  3. Floating/anchored overlays (`/switch`, `/model`) were omitted from `#renderPinnedFrame`, causing invisible overlays that stole input focus and froze keyboard input in the prompt dock.
  4. SGR 1006 tracking was torn down upon fullscreen overlay display due to `PINNED_MOUSE_LEAVE`.
  5. Drag selection used naive string slicing, corrupting Unicode and dropping trailing cells.
  6. In-app visual selection was not rendered, relying on the host terminal which crosses multiplexer pane borders.
  7. Legacy tests from predecessor contract files (`pinned-composer.contract.ts`) tested uncontracted behaviors or cited deleted clause IDs.
- **Ambiguity Score**: 0 (Unambiguous: Option A in-repo full selection, Prime architecture, and complete approved requirements provenance).

---

## 2. Disconnect Matrix (EXPECTED vs OBSERVED)

| ID | Component | EXPECTED Behavior | OBSERVED Behavior | DELTA Classification | Location | Approved Provenance |
|---|---|---|---|---|---|---|
| **DM-1** | `PinnedViewport` / `Composer` Scrollback | `PinnedViewport` holds full scrollable transcript lines from components; `composeFrame` slices window from `scrollTop` to `scrollTop + windowHeight`. `maxScroll = max(0, transcript.length - windowHeight)`. History scrolls back smoothly without freezing. | `composer.ts` truncated `pinnedScroll` to `renderViewport(..., height)`, forcing `transcript.length == windowHeight`, making `maxScroll = 0` (zero scrollback) and allocating 0 lines to conversation output. | **OVERRIDE** | `packages/coding-agent/src/modes/composer.ts`, `packages/tui/src/pinned-viewport.ts` | Prime reference + `REQ-2026-PINNED-COMPOSER.md` §3 |
| **DM-2** | Header Retirement & Output Display | When interactive messages exist, startup header retires to index 0 of history so it does NOT permanently choke out conversation lines on fixed-height displays. | Header remained unretired forever in pinned mode (`this.#headerRetired = false`), consuming 25 rows permanently. Available transcript rows `rows - before - after` became <= 0, causing complete loss of output. | **OVERRIDE** | `packages/coding-agent/src/modes/composer.ts` | `REQ-2026-PINNED-COMPOSER.md` §1 |
| **DM-3** | Overlay Compositing | Every visible overlay (fullscreen AND non-fullscreen/floating like `/switch`, `/model`) composites into the pinned frame via `#compositeOverlaysIntoWindow(lines, width, height)`. | Floating overlays were ignored in `#renderPinnedFrame`, rendering them invisible while stealing input focus and freezing the dock. | **OVERRIDE** | `packages/tui/src/tui.ts` | Prime reference + `REQ-2026-PINNED-COMPOSER.md` §3.5 |
| **DM-4** | Stream Mouse Parsing & Momentum | Stream parser (`parseSgrMouseStream`) extracts all concatenated SGR reports in one chunk; wheel deltas sum into smooth scroll steps without dropped packets or inertia. | Anchored regex `/^\\x1b\\[<...$/` returned null on multi-packet trackpad bursts, swallowing scroll events. | **OVERRIDE** | `packages/tui/src/mouse.ts`, `packages/tui/src/tui.ts` | Prime reference |
| **DM-5** | Drag Selection & Clipboard Copy | Left-click drag across transcript lines highlights text with in-app inverse video and copies plaintext to the macOS clipboard via OSC 52 / native copy using `sliceWithWidth`. | Mode `1002h` forwarded drag events which were discarded without clipboard copy, or sliced naively. | **OVERRIDE** | `packages/tui/src/tui.ts`, `packages/tui/src/pinned-viewport.ts` | Prime reference `fullscreen.ts` |
| **DM-6** | SGR Mode Retention on Overlays | SGR 1006 tracking mode remains active across overlay open/close without teardown by `PINNED_MOUSE_LEAVE`. | Overlay opened with 1006h, but `#syncPinnedMouseTracking` immediately emitted `PINNED_MOUSE_LEAVE` (`?1006l`), breaking overlay mouse input. | **OVERRIDE** | `packages/tui/src/tui.ts` | `REQ-2026-PINNED-COMPOSER.md` SEQ-3 |
| **DM-7** | Alt-Screen Re-entrancy & Single Leave | `TUI.enterPinned` enters alternate screen once; `TUI.stop` leaves once. Overlays do not write second `1049h`. | Multiple callers or uncoordinated teardowns could emit redundant `1049h`/`1049l` escapes. | **KEEP / CONTRACT** | `packages/tui/src/tui.ts` | `REQ-2026-PINNED-COMPOSER.md` INV-03, SEQ-3, SEQ-4 |
| **DM-8** | Input Precedence | Wheel and page keys reach `PinnedViewport.scrollBy` before editor input. | Uncoordinated key handlers can type navigation keys into the editor. | **KEEP / CONTRACT** | `packages/tui/src/tui.ts` | `REQ-2026-PINNED-COMPOSER.md` SEQ-2 |
| **DM-9** | Oversized Dock Clipping | When the dock exceeds available height, it is clipped from the top, retaining the editor and at least `PINNED_MIN_TRANSCRIPT_ROWS` (3 rows). | Oversized dock without clipping can overflow physical terminal grid. | **KEEP / CONTRACT** | `packages/tui/src/pinned-viewport.ts` | `REQ-2026-PINNED-COMPOSER.md` §3 & §3.5 |
| **DM-10** | Non-Following Scroll Preservation | While not following, printable typing into the editor does not reset `scrollTop` to the tail. | Keypresses could trigger unwanted auto-scroll. | **KEEP / CONTRACT** | `packages/tui/src/pinned-viewport.ts` | `REQ-2026-PINNED-COMPOSER.md` §1 & INV-02 |
| **DM-11** | Tail Pinning & Scroll Pause/Resume | Scrolling up pauses following; scrolling down to the bottom resumes following. | Following state desynchronized from viewport position. | **KEEP / CONTRACT** | `packages/tui/src/pinned-viewport.ts` | `REQ-2026-PINNED-COMPOSER.md` §3 S1 |
| **DM-12** | DECSTBM Prohibition | Pinned mode uses alternate-screen software viewport, never terminal scrolling regions (`DECSTBM`). | Host-dependent scroll region jitter. | **FORBIDDEN** | `packages/tui/src/tui.ts` | `REQ-2026-PINNED-COMPOSER.md` §5.5 |
| **DM-13** | Native Scrollback Suppression | Interactive paint does not emit retired transcript rows to native scrollback. | Emitting CRLFs pollutes host terminal scrollback. | **FORBIDDEN** | `packages/tui/src/tui.ts`, `packages/coding-agent/src/modes/composer.ts` | `REQ-2026-PINNED-COMPOSER.md` INV-04, SEQ-5 |

---

## 3. Integration Specification (Phase 2.5)

### Dependency Graph
1. `TUI` DEPENDS ON `PinnedViewport` for `composeFrame`, `scrollBy`, `scrollTop`, and visual selection highlighting.
2. `Composer` DEPENDS ON `TranscriptContainer` for full transcript line generation with cached settled blocks.
3. `TUI.#renderPinnedFrame` DEPENDS ON `TUI.#compositeOverlaysIntoWindow` for all active overlays.
4. `TUI.#handlePinnedInput` DEPENDS ON `parseSgrMouseStream` for multi-event chunk decoding.

### Control Flow Requirements (Sequencing Specs)

| ID | Caller | Must Invoke | Temporal Constraint | Breaks If Missing | Approved Provenance |
|----|--------|-------------|---------------------|-------------------|---------------------|
| **SEQ-PV-1** | `TUI.#renderPinnedFrame` | `PinnedViewport.composeFrame` | BEFORE overlay compositing | Frame base not established | `REQ-2026-PINNED-COMPOSER.md` §6 |
| **SEQ-PV-2** | `TUI.#renderPinnedFrame` | `TUI.#compositeOverlaysIntoWindow` | AFTER `composeFrame`, BEFORE `#emitAltFrame` | Floating overlays invisible; input dock freezes | Prime reference |
| **SEQ-PV-3** | `TUI.#handlePinnedInput` | `parseSgrMouseStream` | BEFORE wheel delta application | Batched trackpad packets dropped (inertia) | Prime reference |
| **SEQ-PV-4** | `Composer.renderFrame` | Transcript full line provider with cache | EVERY pinned frame | Scrollback history destroyed or frame lag | Prime reference |
| **SEQ-PV-5** | `TUI.#handlePinnedInput` | `#dragStart`/`#dragEnd` reset | ON overlay focus or `exitPinned` | Stale drag selection leaks | Prime reference |
| **SEQ-PV-6** | Overlay fullscreen enter | Check alt-screen ownership | BEFORE emitting DECSET 1049h | Duplicate alt-screen clears buffer | `REQ-2026-PINNED-COMPOSER.md` SEQ-3 |

---

## 4. Hard Invariants (The "Never" List)

| ID | Category | Invariant | Approved Provenance |
|---|---|---|---|
| **INV-PV-1** | Scrollback | `PinnedViewport` SHALL NOT truncate scroll history to the visible window height (`options.transcript.length >= windowHeight` whenever history exists). | Prime reference + `REQ-2026-PINNED-COMPOSER.md` §3 |
| **INV-PV-2** | Visibility | `TUI` SHALL NOT discard or omit floating overlays from the rendered terminal buffer in pinned mode. | Prime reference |
| **INV-PV-3** | Focus | `TUI` SHALL NOT assign input focus to an invisible or uncomposited component. | Prime reference |
| **INV-PV-4** | Packet Loss | `TUI` input handler SHALL NOT drop concatenated SGR mouse reports arriving in a single stdin buffer chunk. | Prime reference |
| **INV-PV-5** | Content Integrity | `TUI` SHALL NOT overwrite transcript content lines with navigation or follow hints. | Prime reference |
| **INV-PV-6** | Coupling | Implementation modules SHALL NOT import the contract specification file (`CL11-F`). | Constitutional Law CL11-F |
| **INV-PV-7** | Mode Pure | `TUI` and `Composer` SHALL NOT expose, support, or branch on an inline/unpinned viewport mode. | `REQ-2026-PINNED-COMPOSER.md` §1 & INV-06 |
| **INV-PV-8** | Dock Placement | PinnedViewport dock SHALL occupy the last dockHeight rows of the physical frame. | `REQ-2026-PINNED-COMPOSER.md` INV-01 |
| **INV-PV-9** | DECSTBM Prohibition | Pinned mode SHALL NOT pin the dock by setting a terminal scrolling region (`DECSTBM`). | `REQ-2026-PINNED-COMPOSER.md` §5.5 |
| **INV-PV-10** | Native Scrollback | Interactive paint SHALL NOT emit retired transcript rows to native scrollback. | `REQ-2026-PINNED-COMPOSER.md` INV-04 & SEQ-5 |
