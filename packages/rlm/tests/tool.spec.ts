/**
 * RED PHASE — RLM tool implementation tests (SLICE-4).
 *
 * Targets the IMPLEMENTATION artifact packages/rlm/src/tool.ts, not the
 * contract. At RED time the module does not exist; every test fails with
 * a module-resolution error.
 *
 * CONTRACT AUTHORITY RECORD:
 * - File: requirements/contracts/rlm-tool.contract.ts
 * - PRE: 1, POST: 5, INV: 1, INV-LIFETIME: 1, ERRORS: 1, FORBIDDEN: 2
 *
 * TSR discipline (standing rule): this file restates CLAUSE observables,
 * never implementation shapes. All doubles are injected AT CONSTRUCTION
 * and scripted at construction (gotcha: testing-the-mock). The kernel
 * double implements the kernel-manager result surface established by
 * SLICE-3 (status/streams/ename/duration/kernelRestarted).
 *
 * Public surface exercised:
 * - createRlmToolDefinition({ kernel }) -> descriptor
 *   descriptor: { name, label, description, parameters, executionMode,
 *                 execute(toolCallId, params, signal, onUpdate, ctx) }
 * - kernel port (structural, injected):
 *   ensureStarted(onProgress?) / execute(code) / kill() / dispose() /
 *   restoredNames()
 * - ctx (structural, injected): { hasUI, setWorkingMessage(msg?),
 *   ui.select(title, options) -> label }
 */

import { describe, expect, test } from "bun:test"

import { KernelBusyAfterInterruptError } from "../src/kernel.ts"
import {
  RlmRuntimeMissingError,
  TOOL_BUSY_CHOICES,
  TOOL_NAME,
  TOOL_RESTART_NOTICE_CLOSE,
  TOOL_RESTART_NOTICE_OPEN,
  TOOL_WORKING_MESSAGES,
  createRlmToolDefinition,
  type RlmToolKernelPort,
  type RlmToolKernelResult,
} from "../src/tool.ts"

// ---------------------------------------------------------------------------
// Doubles — scripted AT CONSTRUCTION, injected AT CONSTRUCTION
// ---------------------------------------------------------------------------

type KernelScript = {
  /** Results returned by execute(), in order; last one repeats. */
  results?: RlmToolKernelResult[]
  /** Errors thrown by execute(), in order (consumed before results). */
  executeErrors?: unknown[]
  /** Phases ensureStarted reports, in order. */
  startupPhases?: Array<"starting" | "restoring" | "preparing">
  /** Names restored by the last admission. */
  restoredNames?: string[]
}

function makeOkResult(overrides: Partial<RlmToolKernelResult> = {}): RlmToolKernelResult {
  return {
    status: "ok",
    stdout: "",
    stderr: "",
    result: "",
    traceback: undefined,
    errorEname: undefined,
    durationMs: 42,
    kernelRestarted: undefined,
    ...overrides,
  }
}

function makeKernel(script: KernelScript = {}) {
  const calls: Array<{ kind: string; detail: string }> = []
  const workingMessagesSeenByKernel: string[] = []
  let execIndex = 0
  let errorIndex = 0
  let started = false
  const results = script.results ?? [makeOkResult()]
  const kernel: RlmToolKernelPort = {
    calls,
    async ensureStarted(onProgress) {
      calls.push({ kind: "ensureStarted", detail: String(started) })
      if (started) return
      for (const phase of script.startupPhases ?? ["starting", "restoring", "preparing"]) {
        onProgress?.(phase)
      }
      started = true
    },
    async execute(code) {
      calls.push({ kind: "execute", detail: code })
      const errors = script.executeErrors ?? []
      if (errorIndex < errors.length) {
        throw errors[errorIndex++]
      }
      const r = results[Math.min(execIndex, results.length - 1)]
      execIndex += 1
      return r
    },
    async kill() {
      calls.push({ kind: "kill", detail: "" })
      started = false
    },
    async dispose() {
      calls.push({ kind: "dispose", detail: "" })
    },
    restoredNames() {
      return script.restoredNames ?? []
    },
  }
  return { kernel, calls, workingMessagesSeenByKernel }
}

type CtxRecord = {
  workingMessages: Array<string | undefined>
  selectCalls: Array<{ title: string; labels: string[] }>
  selectAnswer: string | undefined
}

function makeCtx(overrides: { hasUI?: boolean; selectAnswer?: string | undefined } = {}) {
  const record: CtxRecord = {
    workingMessages: [],
    selectCalls: [],
    selectAnswer: overrides.selectAnswer,
  }
  const ctx = {
    hasUI: overrides.hasUI ?? true,
    setWorkingMessage(message?: string) {
      record.workingMessages.push(message)
    },
    ui: {
      async select(title: string, options: ReadonlyArray<{ label: string }>) {
        record.selectCalls.push({ title, labels: options.map(o => o.label) })
        return record.selectAnswer
      },
    },
  }
  return { ctx, record }
}

function makeTool(script: KernelScript = {}) {
  const k = makeKernel(script)
  const descriptor = createRlmToolDefinition({ kernel: k.kernel })
  return { descriptor, kernel: k.kernel, calls: k.calls }
}

async function runCell(
  descriptor: ReturnType<typeof createRlmToolDefinition>,
  ctx: unknown,
  code = "x = 1",
) {
  return descriptor.execute("call-1", { code }, undefined, undefined, ctx as never)
}

// ---------------------------------------------------------------------------
// Descriptor surface
// ---------------------------------------------------------------------------

describe("tool descriptor surface", () => {
  test("PRE-TOOL-1: parameter schema is exactly { code: string }", async () => {
    // Risk tier: HIGH — the wire schema is what the Model may send; extra or
    // missing parameters change the contracted call surface (F-020, TOOL-V1).
    const { descriptor } = makeTool()
    const schema = (descriptor.parameters as { toJsonSchema(): Record<string, unknown> }).toJsonSchema()
    expect(schema.type).toBe("object")
    expect(Object.keys((schema.properties ?? {}) as object).sort()).toEqual(["code"])
    expect(((schema.properties as Record<string, { type: string }>).code).type).toBe("string")
    expect([...(schema.required ?? []) as string[]]).toEqual(["code"])
  })

  test("INV-TOOL-1: descriptor declares sequential execution and identity is ipython", () => {
    // Risk tier: MEDIUM — the declaration is the contracted observable
    // (F-021); the no-overlap guarantee itself is enforced by the kernel
    // manager queue (INV-KM-1, SLICE-3).
    const { descriptor } = makeTool()
    expect(descriptor.name).toBe(TOOL_NAME)
    expect(descriptor.executionMode).toBe("sequential")
  })

  test("FORBIDDEN-TOOL-1: descriptor is purely additive — no eval-tool or kernel-registry surface", () => {
    // Risk tier: HIGH — REQ-N-1. Bounds the registration path at the
    // descriptor surface: the factory output carries ONLY the contracted
    // tool fields, so no eval tool / registry / runner handle can ride
    // along on the descriptor.
    const { descriptor } = makeTool()
    expect(descriptor.name).not.toBe("eval")
    expect(Object.keys(descriptor).sort()).toEqual(
      ["description", "execute", "executionMode", "label", "name", "onSession", "parameters"],
    )
  })

  test("FORBIDDEN-TOOL-2: the only model-facing text is the description (no mandatory main-context sections)", () => {
    // Risk tier: HIGH — REQ-N-2. The descriptor exposes no system-prompt or
    // per-turn context injection field; the tool description adjoining the
    // tool inventory is the sole model-facing text the registration adds.
    const { descriptor } = makeTool()
    const d = descriptor as Record<string, unknown>
    expect(d.systemPrompt).toBeUndefined()
    expect(d.promptSection).toBeUndefined()
    expect(d.contextSection).toBeUndefined()
    expect(typeof d.description).toBe("string")
    expect((d.description as string).length).toBeGreaterThan(0)
  })

  test("POST-TOOL-5: description delivers the prompt contract F-040..F-062", () => {
    // Risk tier: HIGH — REQ-RLM-0005: the Model only learns the notebook
    // discipline through this surface. Each assertion pins one reference
    // rule by its exact behavioral wording.
    const { descriptor } = makeTool()
    const d = descriptor.description
    // F-040 notebook framing: persistent control environment across turns/compaction
    expect(d).toContain("persistent")
    expect(d).toContain("kernel")
    // F-042 %%bash must be the first cell line
    expect(d).toContain("%%bash")
    // F-043 do not install into the kernel for a project
    expect(d.toLowerCase()).toContain("project")
    // F-044 assign read/search results to named variables
    expect(d).toContain("variable")
    // F-046 persistence enumeration
    expect(d).toContain("imports")
    // F-050 rlm() returns an admission handle, never waits
    expect(d).toContain("rlm(")
    // F-049 a child's reply is never the rlm() return value
    expect(d.toLowerCase()).toContain("reply")
  })
})

// ---------------------------------------------------------------------------
// Execution: result shaping
// ---------------------------------------------------------------------------

describe("tool execution result shaping", () => {
  test("POST-TOOL-1: ok result carries details with durationMs and status", async () => {
    // Risk tier: HIGH — the frontend and the Model both key off details.
    const { descriptor } = makeTool({
      results: [makeOkResult({ durationMs: 1234, stdout: "hello" })],
    })
    const { ctx } = makeCtx()
    const res = await runCell(descriptor, ctx)
    const details = res.details as Record<string, unknown>
    expect(details.durationMs).toBe(1234)
    expect(details.status).toBe("ok")
    expect(res.isError ?? false).toBe(false)
  })

  test("POST-TOOL-1 edge: error result still carries durationMs and status", async () => {
    const { descriptor } = makeTool({
      results: [
        makeOkResult({
          status: "error",
          durationMs: 7,
          errorEname: "ValueError",
          traceback: "Traceback (most recent call last):\nValueError: bad",
        }),
      ],
    })
    const { ctx } = makeCtx()
    const res = await runCell(descriptor, ctx)
    const details = res.details as Record<string, unknown>
    expect(details.durationMs).toBe(7)
    expect(details.status).toBe("error")
    expect(details.errorEname).toBe("ValueError")
  })

  test("POST-TOOL-2: isError is true iff status is error or aborted", async () => {
    // Risk tier: HIGH — the three status classes partition isError exactly
    // (F-032, TOOL-V2); one representative per class.
    const cases: Array<{ status: "ok" | "error" | "aborted"; isError: boolean }> = [
      { status: "ok", isError: false },
      { status: "error", isError: true },
      { status: "aborted", isError: true },
    ]
    for (const c of cases) {
      const { descriptor } = makeTool({ results: [makeOkResult({ status: c.status })] })
      const { ctx } = makeCtx()
      const res = await runCell(descriptor, ctx)
      expect(res.isError ?? false).toBe(c.isError)
    }
  })

  test("POST-TOOL-1: text assembles stdout, stderr, result, traceback in order", async () => {
    // Risk tier: MEDIUM — deterministic exact-value check of the F-031
    // assembly order.
    const { descriptor } = makeTool({
      results: [
        makeOkResult({
          status: "error",
          stdout: "OUT",
          stderr: "ERR",
          result: "RES",
          traceback: "TB",
        }),
      ],
    })
    const { ctx } = makeCtx()
    const res = await runCell(descriptor, ctx)
    const text = (res.content as Array<{ type: string; text: string }>)[0].text
    expect(text).toBe("OUT\nERR\nRES\nTB")
  })

  test("POST-TOOL-3: restart notice appears only when the kernel restarted, wrapped in exact tags", async () => {
    // Risk tier: HIGH — a restart notice without a restart lies to the Model
    // about its state (F-029, TOOL-V3).
    const restarted = makeTool({
      results: [makeOkResult({ stdout: "after", kernelRestarted: true })],
    })
    const { ctx: ctx1 } = makeCtx()
    const resRestarted = await runCell(restarted.descriptor, ctx1)
    const textRestarted = (resRestarted.content as Array<{ text: string }>)[0].text
    expect(textRestarted.startsWith(TOOL_RESTART_NOTICE_OPEN)).toBe(true)
    expect(textRestarted.endsWith("after")).toBe(true)
    expect(textRestarted).toContain(TOOL_RESTART_NOTICE_CLOSE)

    const plain = makeTool({ results: [makeOkResult({ stdout: "after" })] })
    const { ctx: ctx2 } = makeCtx()
    const resPlain = await runCell(plain.descriptor, ctx2)
    const textPlain = (resPlain.content as Array<{ text: string }>)[0].text
    expect(textPlain).not.toContain(TOOL_RESTART_NOTICE_OPEN)
    expect(textPlain).not.toContain(TOOL_RESTART_NOTICE_CLOSE)
  })
})

// ---------------------------------------------------------------------------
// Execution: startup working messages (POST-TOOL-4)
// ---------------------------------------------------------------------------

describe("tool startup working messages", () => {
  test("POST-TOOL-4: first invocation shows the three working messages in phase order, then clears", async () => {
    // Risk tier: MEDIUM — F-030 exact strings; the user-facing progress
    // surface during kernel admission.
    const { descriptor } = makeTool({
      startupPhases: ["starting", "restoring", "preparing"],
    })
    const { ctx, record } = makeCtx()
    await runCell(descriptor, ctx)
    expect(record.workingMessages).toEqual([
      TOOL_WORKING_MESSAGES[0],
      TOOL_WORKING_MESSAGES[1],
      TOOL_WORKING_MESSAGES[2],
      undefined,
    ])
  })

  test("POST-TOOL-4: subsequent invocations emit no working messages", async () => {
    const { descriptor } = makeTool()
    const { ctx, record } = makeCtx()
    await runCell(descriptor, ctx)
    const countAfterFirst = record.workingMessages.length
    await runCell(descriptor, ctx, "y = 2")
    expect(record.workingMessages.length).toBe(countAfterFirst)
  })

  test("POST-TOOL-4: working message clears even when the cell fails", async () => {
    const { descriptor } = makeTool({
      results: [makeOkResult({ status: "error", errorEname: "SyntaxError" })],
    })
    const { ctx, record } = makeCtx()
    await runCell(descriptor, ctx)
    expect(record.workingMessages[record.workingMessages.length - 1]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Execution: serialized routing (INV-TOOL-1 behavioral half)
// ---------------------------------------------------------------------------

describe("tool cell routing", () => {
  test("INV-TOOL-1: every cell routes through the kernel manager exactly once, verbatim", async () => {
    // Risk tier: HIGH — a cell executed outside the manager queue bypasses
    // serialized execution. The tool's contribution is routing; the queue
    // itself is INV-KM-1 (SLICE-3).
    const { descriptor, calls } = makeTool()
    const { ctx } = makeCtx()
    await runCell(descriptor, ctx, "a = 1")
    await runCell(descriptor, ctx, "b = 2")
    const executes = calls.filter(c => c.kind === "execute")
    expect(executes.map(c => c.detail)).toEqual(["a = 1", "b = 2"])
  })
})

// ---------------------------------------------------------------------------
// Busy kernel (INV-TOOL-LIFETIME-1)
// ---------------------------------------------------------------------------

describe("busy kernel handling", () => {
  test("INV-TOOL-LIFETIME-1: interactive UI offers exactly the two contracted choices", async () => {
    // Risk tier: HIGH — F-028: the choice labels are the observable contract
    // surface; any other label set breaks the UI wiring.
    const { descriptor } = makeTool({
      executeErrors: [new KernelBusyAfterInterruptError("waited 5000ms")],
      results: [makeOkResult({ stdout: "done" })],
    })
    const { ctx, record } = makeCtx({ selectAnswer: TOOL_BUSY_CHOICES[0] })
    const res = await runCell(descriptor, ctx)
    expect(record.selectCalls.length).toBe(1)
    expect(record.selectCalls[0].labels).toEqual([...TOOL_BUSY_CHOICES])
    // The prompt must warn about state loss (F-028).
    expect(record.selectCalls[0].title.toLowerCase()).toContain("state")
    const text = (res.content as Array<{ text: string }>)[0].text
    expect(text).toContain("done")
  })

  test("INV-TOOL-LIFETIME-1: 'Kill kernel and restart' kills, retries, and marks kernelRestarted", async () => {
    // Risk tier: HIGH — the kill path is the only user-initiated restart;
    // POST-TOOL-3 notice depends on kernelRestarted being set here. The
    // kernel result does NOT carry the flag on this path (the manager only
    // sets it for mid-execution death, INV-KM-LIFETIME-3) — the tool tracks
    // its own user-initiated restart, prime-agent faithful.
    const { descriptor, calls } = makeTool({
      executeErrors: [new KernelBusyAfterInterruptError("waited 5000ms")],
      results: [makeOkResult({ stdout: "after-restart" })],
    })
    const { ctx } = makeCtx({ selectAnswer: TOOL_BUSY_CHOICES[1] })
    const res = await runCell(descriptor, ctx)
    expect(calls.some(c => c.kind === "kill")).toBe(true)
    const text = (res.content as Array<{ text: string }>)[0].text
    expect(text.startsWith(TOOL_RESTART_NOTICE_OPEN)).toBe(true)
    expect(text).toContain("after-restart")
    const details = res.details as Record<string, unknown>
    expect(details.kernelRestarted).toBe(true)
  })

  test("INV-TOOL-LIFETIME-1: non-UI contexts auto-cancel without any dialog", async () => {
    // Risk tier: HIGH — a headless session must never hang on a dialog;
    // F-028 auto-cancel is the contracted non-UI behavior.
    const { descriptor, calls } = makeTool({
      executeErrors: [new KernelBusyAfterInterruptError("waited 5000ms")],
    })
    const { ctx, record } = makeCtx({ hasUI: false })
    const res = await runCell(descriptor, ctx)
    expect(record.selectCalls.length).toBe(0)
    expect(calls.some(c => c.kind === "kill")).toBe(false)
    expect(res.isError ?? false).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Runtime missing (ERRORS-TOOL-1)
// ---------------------------------------------------------------------------

describe("runtime missing detection", () => {
  test("ERRORS-TOOL-1: a runtime import failure surfaces the rebuild guidance naming the interpreter override", async () => {
    // Risk tier: HIGH — F-237: without actionable guidance the Model cannot
    // recover a kernel that lacks the runtime.
    const { descriptor } = makeTool({
      results: [
        makeOkResult({
          status: "error",
          errorEname: "ModuleNotFoundError",
          traceback: "ModuleNotFoundError: No module named 'rlm'",
        }),
      ],
    })
    const { ctx } = makeCtx()
    const res = await runCell(descriptor, ctx)
    const text = (res.content as Array<{ text: string }>)[0].text
    const expectedPrefix = new RlmRuntimeMissingError("").message.replace(/ $/, "")
    expect(text).toContain("rlm-runtime is not installed in this IPython kernel")
    expect(text).toContain("rebuild via")
    expect(res.isError ?? false).toBe(true)
    const details = res.details as Record<string, unknown>
    expect(details.errorEname).toBe("ModuleNotFoundError")
  })

  test("ERRORS-TOOL-1 negative: ordinary ModuleNotFoundError for other modules is not the runtime-missing error", async () => {
    // Risk tier: MEDIUM — bounds the detection path: only the runtime import
    // marker triggers the rebuild guidance, not every missing module.
    const { descriptor } = makeTool({
      results: [
        makeOkResult({
          status: "error",
          errorEname: "ModuleNotFoundError",
          traceback: "ModuleNotFoundError: No module named 'pandas_typo'",
        }),
      ],
    })
    const { ctx } = makeCtx()
    const res = await runCell(descriptor, ctx)
    const text = (res.content as Array<{ text: string }>)[0].text
    expect(text).not.toContain("rlm-runtime is not installed in this IPython kernel")
    expect(res.isError ?? false).toBe(true)
  })
})
