# DISCONNECT MATRIX — Pinned jitter and copy (2026-09-07)

Authority: `/tmp/grok_orchestration_directive.md` (orchestrator forensic diagnosis of user video).
Worktree: `combine-pinned-spawn-model`.

| ID | Behavior | EXPECTED | OBSERVED | DELTA | Location |
|----|----------|----------|----------|-------|----------|
| DM-1 | Concatenated SGR wheel packets | Every `\x1b[<…M` in a stdin chunk is parsed; wheel deltas sum into one `scrollBy` | `parseSgrMouse` anchored regex returns null on multi-event chunks; `#handlePinnedInput` swallows the chunk | OVERRIDE | `packages/tui/src/mouse.ts`, `packages/tui/src/tui.ts` `#handlePinnedInput` |
| DM-2 | Highlight-to-copy | Drag-select copies visible text to the clipboard (OSC 52 / native) | `?1002h` forwards drags; handler discards non-wheel SGR | OVERRIDE | `packages/tui/src/pinned-viewport.ts` `PINNED_MOUSE_ENTER`; `tui.ts` `#handlePinnedInput` |
| DM-3 | Pinned frame cost | Pinned `pinnedScroll` is windowed or cached; not a full-history `transcript.render(width)` every frame | `composer.ts` pinned branch concatenates `transcript.render(width)` every paint | OVERRIDE | `packages/coding-agent/src/modes/composer.ts` |
| DM-4 | Follow hint | Follow affordance MUST NOT overwrite transcript content rows | `lines[hintRow] = " ${followKey} to follow "` clobbers last transcript row | OVERRIDE | `packages/tui/src/tui.ts` `#renderPinnedFrame` |
