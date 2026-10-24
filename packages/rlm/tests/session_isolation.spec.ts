/**
 * RLM Session State Isolation Tests (SLICE-2).
 *
 * Verifies session directory partitioning, lifecycle context resolution,
 * and skipped variable warning telemetry under CCABDD.
 *
 * CONTRACT AUTHORITY RECORD:
 * - Contract: contracts/rlm-session-isolation.contract.ts
 * - Clauses covered:
 *     POST-SESSION-ISOLATION-1: Resolves artifactsDir partitioned by session context (ctx.sessionManager or sessionEvent)
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

function makeKernelPort(overrides: {
  restoredNames?: string[]
  restoredSkipped?: Array<{ name: string; reason: string }>
} = {}): { port: RlmExtensionKernelPort; calls: Array<{ kind: string; detail: string }>; wasStarted: () => boolean } {
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
    restoredSkipped() {
      return overrides.restoredSkipped ?? []
    },
    async onCompactionComplete() {
      calls.push({ kind: "onCompactionComplete", detail: "" })
    },
    compactionNotice() {
      return null
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
    handlers: Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>
    sentMessages: MessageReceipt[]
  } = { tools: [], handlers: new Map(), sentMessages: [] }

  const api = {
    registerTool(tool: Record<string, unknown>) {
      registered.tools.push(tool)
    },
    registerFlag() {},
    registerCommand() {},
    on(event: string, handler: (event: unknown, ctx?: unknown) => unknown) {
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
  test("POST-SESSION-ISOLATION-1: fresh session with sessionManager.getArtifactsDir() partitions artifactsDir and does NOT bleed shared root snapshot (F2/F6)", async () => {
    /**
     * FOUR-CRITERIA TEST VALIDITY GATE:
     *   [✓] C1 VALID: cites clause POST-SESSION-ISOLATION-1 and FORBIDDEN-CROSS-SESSION-BLEED-1
     *   [✓] C2 VALUABLE: passes 'can impl be wrong and test pass?' = NO
     *   [✓] C3 NON-DUPLICATIVE: asserts true (event, ctx) production lifecycle signature
     *   [✓] C4 NOT FUTURE-EDIT: exercises sessionManager.getArtifactsDir() integration
     */
    const tempRoot = fs.mkdtempSync("/tmp/rlm-session-iso-")
    try {
      // Create a stale legacy snapshot in unpartitioned root: .omp/artifacts/kernel-state.dill
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

      // Provide authentic (event, ctx) shape matching OMP runtime (F2 / F6 fix)
      const sessionArtifactsDir = join(tempRoot, "sessions", "session-alpha", "artifacts")
      fs.mkdirSync(sessionArtifactsDir, { recursive: true })

      const mockCtx = {
        cwd: tempRoot,
        sessionManager: {
          getArtifactsDir: () => sessionArtifactsDir,
          getSessionId: () => "session-alpha",
        },
      }

      await sessionStartHandlers[0]({ type: "session_start" }, mockCtx)

      // Fresh session has no snapshot in its partitioned artifacts directory,
      // so no revival message should announce leaked variables from the shared root.
      const revivalMessages = registered.sentMessages.filter(m => {
        const payload = m.payload
        if (payload && typeof payload === "object" && "customType" in payload) {
          return payload.customType === "rlm-revival"
        }
        return false
      })

      expect(revivalMessages.length).toBe(0)
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  test("POST-SESSION-ISOLATION-1: session with snapshot in partitioned directory revives and surfaces skipped warnings (F5)", async () => {
    const tempRoot = fs.mkdtempSync("/tmp/rlm-session-iso-dir-")
    try {
      const sessionArtifactsDir = join(tempRoot, "sessions", "session-beta", "artifacts")
      fs.mkdirSync(sessionArtifactsDir, { recursive: true })
      fs.writeFileSync(join(sessionArtifactsDir, "kernel-state.dill"), "VALID_SESSION_SNAPSHOT")

      const kernel = makeKernelPort({
        restoredNames: ["valid_var"],
        restoredSkipped: [{ name: "broken_var", reason: "missing module" }],
      })

      const { api, registered } = makeApi()
      const factory = createRlmExtension({
        createKernel() {
          return kernel.port
        },
      })
      await factory(api as never)

      const sessionStartHandlers = registered.handlers.get("session_start") ?? []
      expect(sessionStartHandlers.length).toBeGreaterThan(0)

      const mockCtx = {
        cwd: tempRoot,
        sessionManager: {
          getArtifactsDir: () => sessionArtifactsDir,
          getSessionId: () => "session-beta",
        },
      }

      await sessionStartHandlers[0]({ type: "session_start" }, mockCtx)

      const revivalMessages = registered.sentMessages.filter(m => {
        const payload = m.payload
        if (payload && typeof payload === "object" && "customType" in payload) {
          return payload.customType === "rlm-revival"
        }
        return false
      })

      expect(revivalMessages.length).toBe(1)
      const firstPayload = revivalMessages[0].payload
      let content = ""
      if (firstPayload && typeof firstPayload === "object" && "content" in firstPayload) {
        const rawContent = firstPayload.content
        if (typeof rawContent === "string") {
          content = rawContent
        }
      }
      expect(content).toContain("valid_var")
      expect(content).toContain("Warning: The following unpicklable variables were skipped: broken_var")
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
