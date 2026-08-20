# DISCONNECT MATRIX: Top-Level Native ipython Pinning

**Date**: 2026-08-20
**Branch**: feature/rlm-port
**Source Prose**: "i want iPython to be as high priority as possible. essential or even MANDATORY if such a level exists. can we put it inside the native tool array ?" (User directive 2026-08-20).

## Summary

| Metric | Count |
|--------|-------|
| Total Behaviors | 3 |
| OVERRIDE | 3 |
| NEW | 0 |
| REMOVE | 0 |
| KEEP | 0 |

## Matrix

| ID | Behavior | EXPECTED | OBSERVED | DELTA | Location | Priority |
|----|----------|----------|----------|-------|----------|----------|
| B01 | Top-Level Active Tools Array | `session.getActiveToolNames()` includes `"ipython"` on unrestricted session boot, directly exposing it to the model's native callable tool schema alongside `bash` and `eval` | `session.getActiveToolNames()` = `["read","bash","edit","eval","glob","grep","task","hub","todo","web_search","write"]` — `hasIpythonActive: false` | OVERRIDE | packages/coding-agent/src/tools/essential-tools.ts:23-35 | P1 |
| B02 | Default Load Mode | `defaultLoadModeForToolName("ipython")` returns `"essential"` | `defaultLoadModeForToolName("ipython")` returns `"discoverable"` | OVERRIDE | packages/coding-agent/src/tools/essential-tools.ts:43-46 | P1 |
| B03 | xd:// Presentation Pinning | `XDEV_KEEP_TOP_LEVEL` includes `ipython: true`, preventing xdev mounting from ever demoting `ipython` | `XDEV_KEEP_TOP_LEVEL` = `{ todo: true, ask: true, grep: true, web_search: true }` — `ipython` absent | OVERRIDE | packages/coding-agent/src/tools/xdev.ts:55-60 | P1 |

## Evidence

### B01–B03: Top-Level Active Tools Array & Presentation

**EXPECTED Source**: User directive ("i want iPython to be as high priority as possible. essential... inside the native tool array"), REQ-RLM-0002.

**OBSERVED Source**: Observation harness `/tmp/obs-toplevel-ipython.ts` output:
```json
{
  "activeToolNames": ["read","bash","edit","eval","glob","grep","task","hub","todo","web_search","write"],
  "allToolNames": ["read","bash","edit","ast_edit","debug","eval","glob","grep","browser","task","hub","todo","web_search","write","goal","init_experiment","run_experiment","log_experiment","update_notes","ipython"],
  "hasIpythonActive": false,
  "inEssentialNames": false,
  "inKeepTopLevel": false,
  "isMountableUnderXdev": false,
  "defaultLoadMode": "discoverable"
}
```

**DELTA Rationale**: OVERRIDE — `ipython` is loaded by the extension into `allToolNames`, but adapter boundaries default omitted `loadMode` to `"discoverable"`, excluding `ipython` from `getActiveToolNames()`.

**Locations**:
- `packages/coding-agent/src/tools/essential-tools.ts:23-35`
- `packages/coding-agent/src/tools/xdev.ts:55-60`
- `packages/rlm/src/tool.ts:218-224`

## Halfstep

OVERRIDE constants in `essential-tools.ts`, `xdev.ts`, and `tool.ts`.
Phase 2 (Bridging) is NON-APPLICABLE: configuration constant overrides do not require disposable feature flag bridges.
