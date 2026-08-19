# DISCONNECT MATRIX: RLM Host Factory Mount

**Date**: 2026-08-19
**Branch**: feature/rlm-port
**Source Prose**: "RLM plugin SHALL provide the model an additional RLM tool" (REQ-RLM-0002). Live test: "Use your ipython tool…"

## Summary

| Metric | Count |
|--------|-------|
| Total Behaviors | 2 |
| OVERRIDE | 1 |
| NEW | 0 |
| REMOVE | 0 |
| KEEP | 1 |

## Matrix

| ID | Behavior | EXPECTED | OBSERVED | DELTA | Location | Priority |
|----|----------|----------|----------|-------|----------|----------|
| B01 | Host mounts `ipython` | Session construction with `restrictToolNames=false` registers a tool named `ipython` before the first model turn (REQ-RLM-0002, SEQ-TOOL-1) | Loader calls `createRlmExtension(api)`; HOF returns unused inner factory; 0 tools registered. Live session used `eval` on Homebrew 3.11. Observation harness: `tools=[]`, `returnType=function` | OVERRIDE | packages/coding-agent/src/sdk.ts:1969 | P1 |
| B02 | Factory HOF for tests | `createRlmExtension({ createKernel })` returns an `ExtensionFactory` that registers `ipython` | `createRlmExtension()(api)` registers `ipython` + 8 flags + 1 command. Harness: `tools=["ipython"]` | KEEP | packages/rlm/src/extension.ts:300 | P2 |

## Evidence

### B01: Host mounts `ipython`

**EXPECTED Source**: REQ-RLM-0002; SEQ-TOOL-1; user test prompt "Use your ipython tool to define data = …"

**OBSERVED Source**: library harness `/tmp/observe-rlm-factory.ts` + live session `01a01bb3-1e6f-7000-a5b6-7386ebc9debb`

```
{"label":"current-sdk-shape","tools":[],"flagCount":0,"commandCount":0,"events":[],"returnType":"function"}
{"label":"invoked-factory-shape","tools":["ipython"],"flagCount":8,"commandCount":1,"events":["auto_compaction_end","session_start","session_shutdown"],"returnType":"undefined"}
```

Live session thinking: "Looking at my available tools, I have an `eval` tool"
Live interpreter: `/opt/homebrew/opt/python@3.11/bin/python3.11`
No `~/.omp/agent/kernel-venv/`. No `kernel-state.dill`.

**DELTA Rationale**: OVERRIDE — mount line exists but passes the uninvoked HOF. `as ExtensionFactory` hides the type error (typescript-mastery: never `as` to silence the checker).

**Location**: `packages/coding-agent/src/sdk.ts:1969`

### B02: Factory HOF for tests

**EXPECTED Source**: extension.spec.ts injection seam `createRlmExtension({ createKernel })`

**OBSERVED Source**: same harness, invoked-factory-shape row.

**DELTA Rationale**: KEEP — HOF is correct; only the host call site is wrong.

## Halfstep

OVERRIDE at `sdk.ts:1969`: invoke `createRlmExtension()` before push. No disposable bridge — one call-shape change. No `as` cast.
