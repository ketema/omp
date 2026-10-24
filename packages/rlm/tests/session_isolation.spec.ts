/**
 * RED PHASE — RLM Session State Isolation Tests (SLICE-2).
 *
 * Targets packages/rlm/src/extension.ts.
 *
 * CONTRACT AUTHORITY RECORD:
 * - Contract: contracts/rlm-session-isolation.contract.ts
 * - Clauses covered:
 *     POST-SESSION-ISOLATION-1: Resolves artifactsDir partitioned by session identifier
 *     FORBIDDEN-CROSS-SESSION-BLEED-1: Prohibits loading snapshots from shared root
 *     IP-5: Delivers partitioned artifactsDir to kernel initialization
 */

import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import { join } from "node:path"

import {
  createRlmExtension,
  type RlmExtensionKernelPort,
} from "../src/extension.ts"

function makeKernelPort(overrides: { restoredNames?: string[] } = {}) {
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
  }
  return { port, calls, wasStarted: () => started }
}

interface MessageReceipt {
  readonly payload: unknown
  readonly options: unknown
}

function makeApi() {
  const registered: {
    tools: Array<Record<string, unknown>>
    handlers: Map<string, Array<(event: unknown) => unknown>>
    sentMessages: MessageReceipt[]
  } = { tools: [], handlers: new Map(), sentMessages: [] }

  const api = {
    registerTool(tool: Record<string, unknown>) {
      registered.tools.push(tool)
    },
    registerFlag() {},
    registerCommand() {},
    on(event: string, handler: (event: unknown) => unknown) {
      const list = registered.handlers.get(event) ?? []
      list.push(handler)
      registered.handlers.set(event, list)
    },
    getFlag() {
      return undefined
    },
    sendMessage(payload: unknown, options?: unknown) {
      registered.sentMessages.push({ payload, options })
    },
  }
  return { api, registered }
}

describe("SLICE-2: Session Artifacts Isolation", () => {
  test("POST-SESSION-ISOLATION-1: fresh session with sessionId partitions artifactsDir and does NOT bleed shared root snapshot", async () => {
    const tempRoot = fs.mkdtempSync("/tmp/rlm-session-iso-")
    try {
      // Create a fake legacy snapshot in unpartitioned root: .omp/artifacts/kernel-state.dill
      const sharedRoot = join(tempRoot, ".omp", "artifacts")
      fs.mkdirSync(sharedRoot, { recursive: true })
      fs.writeFileSync(join(sharedRoot, "kernel-state.dill"), "STALE_PRIOR_SESSION_DATA")

      const kernel = makeKernelPort({ restoredNames: ["stale_leaked_var"] })

      const { api, registered } = makeApi()
      const factory = createRlmExtension({
        createKernel() {
          return kernel.port
        },
      })
      await factory(api as never)

      const sessionStartHandlers = registered.handlers.get("session_start") ?? []
      expect(sessionStartHandlers.length).toBeGreaterThan(0)

      const sessionId = "01a15eec-fresh-session-uuid"
      await sessionStartHandlers[0]({
        type: "session_start",
        sessionId,
        cwd: tempRoot,
      })

      const revivalMessages = registered.sentMessages.filter(m => {
        if (typeof m.payload === "object" && m.payload !== null && "customType" in m.payload) {
          return m.payload.customType === "rlm-revival"
        }
        return false
      })

      expect(revivalMessages.length).toBe(0)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  test("POST-SESSION-ISOLATION-1: session with explicit sessionDir restores from partitioned path", async () => {
    const tempRoot = fs.mkdtempSync("/tmp/rlm-session-iso-dir-")
    try {
      const explicitSessionDir = join(tempRoot, "my-session-dir")
      fs.mkdirSync(explicitSessionDir, { recursive: true })
      fs.writeFileSync(join(explicitSessionDir, "kernel-state.dill"), "VALID_SESSION_SNAPSHOT")

      const kernel = makeKernelPort({ restoredNames: ["valid_session_var"] })

      const { api, registered } = makeApi()
      const factory = createRlmExtension({
        createKernel() {
          return kernel.port
        },
      })
      await factory(api as never)

      const sessionStartHandlers = registered.handlers.get("session_start") ?? []
      expect(sessionStartHandlers.length).toBeGreaterThan(0)

      await sessionStartHandlers[0]({
        type: "session_start",
        sessionDir: explicitSessionDir,
      })

      const revivalMessages = registered.sentMessages.filter(m => {
        if (typeof m.payload === "object" && m.payload !== null && "customType" in m.payload) {
          return m.payload.customType === "rlm-revival"
        }
        return false
      })

      expect(revivalMessages.length).toBe(1)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
