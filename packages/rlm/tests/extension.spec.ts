/**
 * RED PHASE — RLM extension registration/wiring tests (SLICE-4).
 *
 * Targets the IMPLEMENTATION artifact packages/rlm/src/extension.ts, not
 * the contract. At RED time the module does not exist; every test fails
 * with a module-resolution error.
 *
 * Clauses exercised (plan SLICE-4 scope):
 * - REQ-RLM-0002  plugin provides the model the additional ipython tool
 * - REQ-RLM-0014  config surface F-250..F-258 as plugin-schema fields
 * - SEQ-BOOT-1/2  config delivered to the runtime BEFORE kernel start
 *                 (manifest SEQ-11 / IP-8; satisfied-by-construction here)
 * - Pivot wiring  session-resume revival notice + compaction-complete
 *                 notice (SEQ-KM-5) with transcript evidence
 *
 * Flag names follow the RLM_* convention the SAFE contract established for
 * kernel-env keys (SLICE-2); they are the user-visible config interface, so
 * they are pinned as exact values, not implementation shapes.
 *
 * Public surface exercised:
 * - createRlmExtension(options?) -> extension factory (api) => void
 *   api (structural, faked): registerTool / registerFlag / registerCommand /
 *   on / getFlag / sendMessage
 * - options.createKernel(config) -> kernel port (injected double)
 */

import { describe, expect, test } from "bun:test"

import * as fs from "node:fs"
import { join } from "node:path"

import {
  createRlmExtension,
  type RlmExtensionKernelPort,
  type RlmKernelConfig,
} from "../src/extension.ts"

// ---------------------------------------------------------------------------
// Doubles — scripted AT CONSTRUCTION, injected AT CONSTRUCTION
// ---------------------------------------------------------------------------

function makeKernelPort(overrides: { restoredNames?: string[]; compactionNotice?: string | null } = {}) {
  const calls: Array<{ kind: string; detail: string }> = []
  let started = false
  const port: RlmExtensionKernelPort = {
    async ensureStarted() {
      calls.push({ kind: "ensureStarted", detail: "" })
      started = true
    },
    async execute(code) {
      calls.push({ kind: "execute", detail: code })
      return {
        status: "ok" as const,
        stdout: "",
        stderr: "",
        result: "",
        traceback: undefined,
        errorEname: undefined,
        durationMs: 1,
        kernelRestarted: undefined,
      }
    },
    async kill() {
      calls.push({ kind: "kill", detail: "" })
      started = false
    },
    async dispose() {
      calls.push({ kind: "dispose", detail: "" })
    },
    restoredNames() {
      return overrides.restoredNames ?? []
    },
    async onCompactionComplete() {
      calls.push({ kind: "onCompactionComplete", detail: "" })
    },
    compactionNotice() {
      return overrides.compactionNotice ?? null
    },
  }
  return { port, calls, wasStarted: () => started }
}

function makeApi(options: { flags?: Record<string, string | boolean> } = {}) {
  const registered: {
    tools: Array<Record<string, unknown>>
    flags: Array<{ name: string; type: string; default: string | boolean | undefined }>
    commands: Array<{ name: string; handler: (args: string) => unknown }>
    handlers: Map<string, Array<(event: unknown) => unknown>>
    sentMessages: Array<{ payload: unknown; options: unknown }>
  } = { tools: [], flags: [], commands: [], handlers: new Map(), sentMessages: [] }
  const flagValues: Record<string, string | boolean> = { ...(options.flags ?? {}) }
  const api = {
    registerTool(tool: Record<string, unknown>) {
      registered.tools.push(tool)
    },
    registerFlag(name: string, opts: { type: "boolean" | "string"; default?: string | boolean }) {
      registered.flags.push({ name, type: opts.type, default: opts.default })
      if (opts.default !== undefined && flagValues[name] === undefined) {
        flagValues[name] = opts.default
      }
    },
    registerCommand(name: string, opts: { handler: (args: string) => unknown }) {
      registered.commands.push({ name, handler: opts.handler })
    },
    on(event: string, handler: (event: unknown) => unknown) {
      const list = registered.handlers.get(event) ?? []
      list.push(handler)
      registered.handlers.set(event, list)
    },
    getFlag(name: string) {
      return flagValues[name]
    },
    sendMessage(payload: unknown, opts?: unknown) {
      registered.sentMessages.push({ payload, options: opts })
    },
  }
  return { api, registered, flagValues }
}

function loadExtension(options: { flags?: Record<string, string | boolean>; kernel?: ReturnType<typeof makeKernelPort> } = {}) {
  const { api, registered, flagValues } = makeApi({ flags: options.flags })
  const kernel = options.kernel ?? makeKernelPort()
  const kernelConfigs: RlmKernelConfig[] = []
  const factory = createRlmExtension({
    createKernel(config) {
      kernelConfigs.push(config)
      kernel.calls.push({ kind: "createKernel", detail: "" })
      return kernel.port
    },
  })
  factory(api as never)
  return { api, registered, flagValues, kernel, kernelConfigs }
}

// ---------------------------------------------------------------------------
// Registration (REQ-RLM-0002)
// ---------------------------------------------------------------------------

describe("extension registration", () => {
  test("REQ-RLM-0002: registers exactly one tool named ipython", () => {
    // Risk tier: HIGH — the slice's first user-visible value; a missing or
    // doubly-registered tool breaks the model-facing surface.
    const { registered } = loadExtension()
    expect(registered.tools.length).toBe(1)
    expect(registered.tools[0].name).toBe("ipython")
    expect(typeof registered.tools[0].execute).toBe("function")
  })
})

// ---------------------------------------------------------------------------
// Config surface (REQ-RLM-0014, F-250..F-258)
// ---------------------------------------------------------------------------

describe("config surface", () => {
  test("REQ-RLM-0014: depth defaults are 0 and 1 (F-250, F-251)", () => {
    const { registered } = loadExtension()
    const depth = registered.flags.find(f => f.name === "RLM_DEPTH")
    const maxDepth = registered.flags.find(f => f.name === "RLM_MAX_DEPTH")
    expect(depth?.default).toBe("0")
    expect(maxDepth?.default).toBe("1")
  })

  test("REQ-RLM-0014: interpreter override, forkserver, agent dir, venv path are registered (F-252..F-255)", () => {
    const { registered } = loadExtension()
    const names = registered.flags.map(f => f.name)
    expect(names).toContain("RLM_KERNEL_PYTHON")
    expect(names).toContain("RLM_KERNEL_FORKSERVER")
    expect(names).toContain("OMP_RLM_AGENT_DIR")
    expect(names).toContain("RLM_KERNEL_VENV")
    // F-253: forkserver is enabled by default; "0" disables.
    const forkserver = registered.flags.find(f => f.name === "RLM_KERNEL_FORKSERVER")
    expect(forkserver?.default).toBe(true)
  })

  test("REQ-RLM-0014: model-search limit default 8 and name max length 64 (F-256, F-257)", () => {
    const { registered } = loadExtension()
    const searchLimit = registered.flags.find(f => f.name === "RLM_MODEL_SEARCH_LIMIT")
    const nameMax = registered.flags.find(f => f.name === "RLM_NAME_MAX_LENGTH")
    expect(searchLimit?.default).toBe("8")
    expect(nameMax?.default).toBe("64")
  })

  test("F-258: /rlm-max-depth validates non-negative integers", () => {
    // Risk tier: MEDIUM — the command is the user's depth override; a
    // negative or non-numeric value must be rejected, not applied.
    const { registered } = loadExtension()
    const cmd = registered.commands.find(c => c.name === "rlm-max-depth")
    expect(cmd).toBeDefined()
    const handler = cmd!.handler
    expect(() => handler("-1")).toThrow()
    expect(() => handler("abc")).toThrow()
    expect(() => handler("1.5")).toThrow()
    expect(() => handler("0")).not.toThrow()
    expect(() => handler("3")).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Config-before-start ordering (SEQ-BOOT-2 / manifest SEQ-11)
// ---------------------------------------------------------------------------

describe("config delivery ordering", () => {
  test("SEQ-BOOT-2: the kernel receives resolved config BEFORE any start, including the interpreter override", async () => {
    // Risk tier: HIGH — config that arrives after start silently applies
    // defaults inside run() (manifest SEQ-11 failure mode). The clause
    // bounds ordering only (config before start), not when resolution
    // happens — so the test triggers first kernel use and checks the order.
    const kernel = makeKernelPort()
    const { registered, kernelConfigs } = loadExtension({
      kernel,
      flags: { RLM_KERNEL_PYTHON: "/custom/interpreter" },
    })
    const onSession = registered.tools[0].onSession as (event: { reason: string }) => Promise<void> | void
    await onSession({ reason: "start" })
    expect(kernelConfigs.length).toBe(1)
    expect(kernelConfigs[0].kernelPython).toBe("/custom/interpreter")
    const configAt = kernel.calls.findIndex(c => c.kind === "createKernel")
    const firstStart = kernel.calls.findIndex(c => c.kind === "ensureStarted")
    expect(configAt).toBeGreaterThanOrEqual(0)
    expect(firstStart).toBeGreaterThan(configAt)
  })
})

// ---------------------------------------------------------------------------
// Durability wiring (pivot guidance: transcript evidence)
// ---------------------------------------------------------------------------

describe("durability wiring", () => {
  test("session resume restores state and announces revived names in the transcript", async () => {
    // Risk tier: HIGH — without the notice the Model does not know its state
    // survived; the pivot requires transcript evidence for this surface.
    const kernel = makeKernelPort({ restoredNames: ["df", "config"] })
    const { registered } = loadExtension({ kernel })
    const tool = registered.tools[0]
    const onSession = tool.onSession as (event: { reason: string }) => Promise<void> | void
    await onSession({ reason: "start" })
    expect(kernel.calls.some(c => c.kind === "ensureStarted")).toBe(true)
    expect(registered.sentMessages.length).toBe(1)
    const text = JSON.stringify(registered.sentMessages[0].payload)
    expect(text).toContain("df")
    expect(text).toContain("config")
  })

  test("session resume with no prior snapshot sends no revival notice", async () => {
    const kernel = makeKernelPort({ restoredNames: [] })
    const { registered } = loadExtension({ kernel })
    const onSession = registered.tools[0].onSession as (event: { reason: string }) => Promise<void> | void
    await onSession({ reason: "start" })
    expect(registered.sentMessages.length).toBe(0)
  })

  test("session shutdown disposes the kernel", async () => {
    const kernel = makeKernelPort()
    const { registered } = loadExtension({ kernel })
    const onSession = registered.tools[0].onSession as (event: { reason: string }) => Promise<void> | void
    await onSession({ reason: "shutdown" })
    expect(kernel.calls.some(c => c.kind === "dispose")).toBe(true)
  })

  test("SEQ-KM-5: compaction completion injects the namespace-inventory notice into the transcript", async () => {
    // Risk tier: HIGH — the Model must learn its state survived compaction;
    // SLICE-3 owns the notice content, SLICE-4 owns this wiring.
    const kernel = makeKernelPort({
      compactionNotice: "[ipython_state] surviving names: a, b",
    })
    const { registered } = loadExtension({ kernel })
    const handlers = registered.handlers.get("auto_compaction_end") ?? []
    expect(handlers.length).toBe(1)
    await handlers[0]({})
    expect(kernel.calls.some(c => c.kind === "onCompactionComplete")).toBe(true)
    expect(registered.sentMessages.length).toBe(1)
    expect(JSON.stringify(registered.sentMessages[0].payload)).toContain("surviving names")
  })

  test("SEQ-KM-5 negative: no notice is sent when the kernel has none pending", async () => {
    const kernel = makeKernelPort({ compactionNotice: null })
    const { registered } = loadExtension({ kernel })
    const handlers = registered.handlers.get("auto_compaction_end") ?? []
    await handlers[0]({})
    expect(registered.sentMessages.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Live wiring — end-to-end through the DEFAULT construction path
// ---------------------------------------------------------------------------

describe("extension live wiring (SEQ-TOOL-1)", () => {
  test("SEQ-TOOL-1: the default registration path executes a real cell with no injected kernel", async () => {
    // Risk tier: HIGH — the isolated-component failure mode: a registered
    // tool whose kernel path was never constructed. NO createKernel hook —
    // the extension must resolve the interpreter via the SLICE-2 bootstrap,
    // construct the transport (REQ-RLM-0019), and admit the runner itself
    // (manifest SEQ-13). A tool that cannot reach a real kernel fails here.
    const workRoot = fs.mkdtempSync("/tmp/rlm-ext-wire-")
    try {
      const { api, registered } = makeApi({ flags: { OMP_RLM_AGENT_DIR: workRoot } })
      const factory = createRlmExtension()
      factory(api as never)
      expect(registered.tools.length).toBe(1)
      const tool = registered.tools[0]
      const ctx = {
        hasUI: false,
        setWorkingMessage(_message?: string) {},
        sessionDir: join(workRoot, "session"),
        ui: { async select() { return undefined } },
      }
      const execute = tool.execute as (
        toolCallId: string,
        params: { code: string },
        signal: undefined,
        onUpdate: undefined,
        ctx: unknown,
      ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>
      const res = await execute("call-1", { code: "print(6*7)" }, undefined, undefined, ctx)
      expect(res.isError ?? false).toBe(false)
      expect(res.content[0].text).toContain("42")
    } finally {
      fs.rmSync(workRoot, { recursive: true, force: true })
    }
  }, 300_000)
})
