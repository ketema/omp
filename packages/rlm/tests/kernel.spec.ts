/**
 * RED PHASE — kernel manager implementation tests (SLICE-3).
 *
 * Targets the IMPLEMENTATION artifact packages/rlm/src/kernel.ts, not the
 * contract. At RED time the module does not exist; every test fails with
 * a module-resolution error.
 *
 * CONTRACT AUTHORITY RECORD:
 * - File: requirements/contracts/rlm-kernel.contract.ts
 * - PRE: 1, POST: 3, INV: 3, INV-LIFETIME: 3, SEQ: 5, ERRORS: 3, FORBIDDEN: 3
 *
 * TSR discipline (standing rule): this file restates CLAUSE observables.
 * All doubles are injected AT CONSTRUCTION (gotcha: testing-the-mock —
 * never post-construction cast-overrides). All timing runs on the
 * injectable clock's scheduler (gotcha: fake timers vs real awaits —
 * the manager must schedule through the clock, and tests advance time
 * manually). Rejection handlers attach in the same tick as the promise
 * (gotcha: stored-promise late rejection).
 *
 * Public surface exercised (all through KernelManager):
 * - new KernelManager(transport, {clock, artifactsDir})
 *   transport: {start(); execute(id, code); interrupt(); kill();
 *               onOutput(cb); snapshotNames(); writeSnapshot(names);
 *               restoreSnapshot(); bootstrap(); isBusy(); alive(); dispose()}
 *   clock: {now(); schedule(fn, ms) -> cancel}
 * - await manager.ensureStarted()
 * - await manager.execute(code) -> KernelExecutionResult
 * - await manager.abort()
 * - await manager.dispose({snapshot?: boolean})
 * - await manager.onCompactionComplete()
 * - manager.compactionNotice(): string | null
 */

import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"

import {
  ABORT_GRACE_MS,
  BUSY_INTERRUPT_INTERVAL_MS,
  BUSY_REUSE_WAIT_MS,
  DISPOSE_TIMEOUT_MS,
  MAX_OUTPUT_CHARS,
  SNAPSHOT_ALWAYS_SKIP,
  SNAPSHOT_DEBOUNCE_MS,
  TRUNCATION_MARKER,
  KernelManager,
} from "../src/kernel.ts"

// ---------------------------------------------------------------------------
// Doubles — injected at construction, scripted at construction
// ---------------------------------------------------------------------------

type TransportResult = {
  code: number
  stdout: string
  stderr: string
  result: string
  traceback?: string
  errorEname?: string
}

/** Injectable clock with a DETERMINISTIC scheduler: the manager schedules
 * all timers through clock.schedule, and tests advance virtual time. */
function makeClock() {
  let now = 0
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = []
  const clock = {
    now: () => now,
    schedule(fn: () => void, ms: number): () => void {
      const t = { at: now + ms, fn, cancelled: false }
      timers.push(t)
      return () => { t.cancelled = true }
    },
    /** Advance virtual time; runs due timers in order, yielding between.
     * Drains to QUIESCENCE: after reaching the target, keeps processing
     * any timers scheduled during the drain (chained waits like the
     * busy-cadence loop) until none are due — preventing lost wakeups
     * where a promise chain schedules its next timer after this loop has
     * already decided no timer is due. */
    async advance(ms: number): Promise<void> {
      const target = now + ms
      for (;;) {
        const due = timers.filter(t => !t.cancelled && t.at <= now).sort((a, b) => a.at - b.at)[0]
          ?? timers.filter(t => !t.cancelled && t.at <= target).sort((a, b) => a.at - b.at)[0]
        if (due === undefined) break
        now = Math.max(now, due.at)
        due.cancelled = true
        due.fn()
        await new Promise(r => setTimeout(r, 0)) // microtask yield between timers
      }
      now = target
    },
  }
  return clock
}

type TransportScript = {
  start?: () => Promise<void> | void
  execute?: (id: string, code: string, call: number) => Promise<TransportResult>
  snapshotNames?: () => Promise<string[]>
  writeSnapshot?: (names: string[]) => Promise<{ bytes: number; skipped: { name: string; reason: string }[] }>
  /** Snapshot payload write at the FS boundary: default writes to artifactsDir. */
  writeSnapshotPayload?: (dir: string) => Promise<void>
  restoreSnapshot?: () => Promise<string[]>
  isBusy?: () => boolean
}

/** Fake transport: scripted AT CONSTRUCTION, records every call. */
function makeTransport(script: TransportScript = {}) {
  const calls: Array<{ kind: string; detail: string }> = []
  const listeners: Array<(o: { id: string; stream: "stdout" | "stderr"; data: string }) => void> = []
  let execCount = 0
  const transport = {
    calls,
    emit(id: string, stream: "stdout" | "stderr", data: string) {
      for (const l of listeners) l({ id, stream, data })
    },
    async start(): Promise<void> {
      calls.push({ kind: "start", detail: "" })
      await script.start?.()
    },
    async execute(id: string, code: string): Promise<TransportResult> {
      execCount += 1
      calls.push({ kind: "execute", detail: `${id}:${code}` })
      const r = await script.execute?.(id, code, execCount)
      return r ?? { code: 0, stdout: "", stderr: "", result: "" }
    },
    interrupt() { calls.push({ kind: "interrupt", detail: "" }) },
    kill() { calls.push({ kind: "kill", detail: "" }) },
    onOutput(cb: (o: { id: string; stream: "stdout" | "stderr"; data: string }) => void) {
      listeners.push(cb)
    },
    async snapshotNames(): Promise<string[]> {
      calls.push({ kind: "snapshotNames", detail: "" })
      return await (script.snapshotNames?.() ?? Promise.resolve(["a", "b"]))
    },
    async writeSnapshot(names: string[]): Promise<{ bytes: number; skipped: { name: string; reason: string }[] }> {
      calls.push({ kind: "writeSnapshot", detail: names.join(",") })
      return await (script.writeSnapshot?.(names) ?? Promise.resolve({ bytes: 10, skipped: [] }))
    },
    async restoreSnapshot(): Promise<string[]> {
      calls.push({ kind: "restoreSnapshot", detail: "" })
      return await (script.restoreSnapshot?.() ?? Promise.resolve(["a", "b"]))
    },
    async bootstrap(): Promise<void> { calls.push({ kind: "bootstrap", detail: "" }) },
    isBusy(): boolean { return script.isBusy?.() ?? false },
    ...(script.writeSnapshotPayload !== undefined
      ? { writeSnapshotPayload: (dir: string) => script.writeSnapshotPayload?.(dir) }
      : {}),
    alive(): boolean { return true },
    async dispose(): Promise<void> { calls.push({ kind: "transportDispose", detail: "" }) },
  }
  return transport
}

function artifactsDir(): string {
  return fs.mkdtempSync("/tmp/rlm-km-test-")
}

// ---------------------------------------------------------------------------
// SEQ-KM-1 — admission before any execution
// ---------------------------------------------------------------------------

test("SEQ-KM-1: first execute admits the kernel BEFORE running the cell", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: SEQ-KM-1: first tool call SHALL admit the kernel BEFORE
   *      any cell execution (IP-1, REQ-RLM-0003)
   * - Category: integration (lifecycle ordering)
   * - Risk tier: High
   * - Adversarial: Implementation-blind
   *
   * SEQ TEST SELF-CHECK: [x] parent lifecycle via execute() [x] order via
   * recorded calls [x] no internal helper called [x] doubles at ctor
   *
   * FOUR-CRITERIA GATE: C1 SEQ-KM-1 · C2 execute-before-start fails the
   * order assertion · C3 only order test at this surface · C4 contracted
   */
  const transport = makeTransport()
  const manager = new KernelManager(transport, { clock: makeClock(), artifactsDir: artifactsDir() })
  await manager.execute("print(1)")
  const kinds = transport.calls.map(c => c.kind)
  expect(kinds.indexOf("start")).toBeGreaterThanOrEqual(0)
  expect(kinds.indexOf("execute")).toBeGreaterThan(kinds.indexOf("start"))
})

// ---------------------------------------------------------------------------
// SEQ-KM-2 — restore before bootstrap
// ---------------------------------------------------------------------------

test("SEQ-KM-2: start restores snapshot BEFORE bootstrap injection", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: SEQ-KM-2 / INV-KM-3 (F-177): restore after start, before
   *      bootstrap overwrites live handles
   * - Category: integration (lifecycle ordering)
   * - Risk tier: High — wrong order destroys revived state
   */
  const transport = makeTransport()
  const manager = new KernelManager(transport, { clock: makeClock(), artifactsDir: artifactsDir() })
  await manager.ensureStarted()
  const kinds = transport.calls.map(c => c.kind)
  expect(kinds.indexOf("bootstrap")).toBeGreaterThan(kinds.indexOf("restoreSnapshot"))
  expect(kinds.indexOf("restoreSnapshot")).toBeGreaterThan(kinds.indexOf("start"))
})

// ---------------------------------------------------------------------------
// PRE-KM-1 / INV-KM-1 — serialization in submission order
// ---------------------------------------------------------------------------

test("INV-KM-1: concurrent executes serialize; submission order preserved", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: PRE-KM-1 + INV-KM-1 (F-004)
   * - Category: invariant (concurrent submissions; in-flight gate)
   * - Risk tier: High — interleaved cells corrupt kernel state
   */
  let inFlight = 0
  let maxInFlight = 0
  const transport = makeTransport({
    execute: async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 5))
      inFlight -= 1
      return { code: 0, stdout: "", stderr: "", result: "" }
    },
  })
  const manager = new KernelManager(transport, { clock: makeClock(), artifactsDir: artifactsDir() })
  await Promise.all([manager.execute("first"), manager.execute("second")])
  expect(maxInFlight).toBe(1)
  const execs = transport.calls.filter(c => c.kind === "execute").map(c => c.detail)
  expect(execs[0]).toContain("first")
  expect(execs[1]).toContain("second")
})

// ---------------------------------------------------------------------------
// POST-KM-1 — result shape
// ---------------------------------------------------------------------------

test("POST-KM-1: ok and error results carry status/streams/ename/duration", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: POST-KM-1 (F-031)
   * - Category: positive + error pair
   * - Risk tier: Medium
   */
  const good = makeTransport({ execute: async () => ({ code: 0, stdout: "hi", stderr: "", result: "4" }) })
  const m1 = new KernelManager(good, { clock: makeClock(), artifactsDir: artifactsDir() })
  const ok = await m1.execute("2+2")
  expect(ok.status).toBe("ok")
  expect(ok.stdout).toBe("hi")
  expect(ok.result).toBe("4")
  expect(ok.durationMs).toBeGreaterThanOrEqual(0)

  const bad = makeTransport({ execute: async () => ({ code: 1, stdout: "", stderr: "boom", result: "", traceback: "T...", errorEname: "ValueError" }) })
  const m2 = new KernelManager(bad, { clock: makeClock(), artifactsDir: artifactsDir() })
  const err = await m2.execute("raise")
  expect(err.status).toBe("error")
  expect(err.errorEname).toBe("ValueError")
})

// ---------------------------------------------------------------------------
// POST-KM-2 — exact truncation
// ---------------------------------------------------------------------------

test("POST-KM-2: oversized streams carry the exact marker; payload capped", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: POST-KM-2 (F-006, KM-V1)
   * - Category: boundary (exact values)
   * - Risk tier: Medium
   */
  const big = "x".repeat(MAX_OUTPUT_CHARS + 5000)
  const transport = makeTransport({ execute: async () => ({ code: 0, stdout: big, stderr: big, result: big }) })
  const manager = new KernelManager(transport, { clock: makeClock(), artifactsDir: artifactsDir() })
  const r = await manager.execute("big")
  const marker = TRUNCATION_MARKER.replace("%d", String(MAX_OUTPUT_CHARS))
  expect(r.stdout.endsWith(marker)).toBe(true)
  expect(r.stderr.endsWith(marker)).toBe(true)
  expect(r.result.endsWith(marker)).toBe(true)
  expect(r.stdout.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS + marker.length)
})

// ---------------------------------------------------------------------------
// POST-KM-3 / FORBIDDEN-KM-2 — msg_id gate
// ---------------------------------------------------------------------------

test("POST-KM-3: stale-id stream output never leaks; live-id output lands", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: POST-KM-3 + FORBIDDEN-KM-2 (F-005)
   * - Category: invariant (fault injection: stale emit mid-execution)
   * - Risk tier: High — stale output poisons results
   */
  const transport = makeTransport({
    execute: async (id: string) => {
      transport.emit("stale-execution-id", "stdout", "STALE LEAK")
      transport.emit(id, "stdout", "LIVE")
      return { code: 0, stdout: "", stderr: "", result: "" }
    },
  })
  const manager = new KernelManager(transport, { clock: makeClock(), artifactsDir: artifactsDir() })
  const r = await manager.execute("live cell")
  expect(r.stdout).toBe("LIVE")
  expect(r.stdout.includes("STALE LEAK")).toBe(false)
})

// ---------------------------------------------------------------------------
// ERRORS-KM-3 — abort grace (rejection handled in-tick)
// ---------------------------------------------------------------------------

test("ERRORS-KM-3: aborted execution resolves 'aborted' after the grace window", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: ERRORS-KM-3 (F-008/F-222)
   * - Category: timing (virtual clock)
   * - Risk tier: Medium
   */
  const clock = makeClock()
  const transport = makeTransport({
    execute: () => new Promise<TransportResult>(() => {}), // never resolves
  })
  const manager = new KernelManager(transport, { clock, artifactsDir: artifactsDir() })
  const settled = manager.execute("while True: pass") // handler attached below, same tick chain
  const assertion = settled.then(r => { expect(r.status).toBe("aborted") })
  void manager.abort().catch(() => {})
  await clock.advance(ABORT_GRACE_MS + 10)
  await assertion
})

// ---------------------------------------------------------------------------
// ERRORS-KM-1 — busy cadence
// ---------------------------------------------------------------------------

test("ERRORS-KM-1: persistent busy throws after the budget with interrupt cadence", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: ERRORS-KM-1 (F-009/F-221): busy past
   *      BUSY_REUSE_WAIT_MS with interrupts every
   *      BUSY_INTERRUPT_INTERVAL_MS
   * - Category: timing (virtual clock; interrupt count observable)
   * - Risk tier: Medium
   */
  const clock = makeClock()
  const transport = makeTransport({ isBusy: () => true })
  const manager = new KernelManager(transport, { clock, artifactsDir: artifactsDir() })
  const attempt = manager.execute("second cell")
  // Handler attached in the same tick (gotcha: stored-promise late
  // rejection); expect().rejects held across a long advance starves under
  // bun:test — capture the error directly and assert after settling
  let caught: unknown = undefined
  const settled = attempt.catch((e: unknown) => { caught = e })
  await clock.advance(BUSY_REUSE_WAIT_MS + BUSY_INTERRUPT_INTERVAL_MS)
  await settled
  expect(String(caught)).toContain("still running the previously interrupted cell")
  const interrupts = transport.calls.filter(c => c.kind === "interrupt").length
  expect(interrupts).toBeGreaterThanOrEqual(Math.floor(BUSY_REUSE_WAIT_MS / BUSY_INTERRUPT_INTERVAL_MS) - 1)
})

// ---------------------------------------------------------------------------
// INV-KM-LIFETIME-1 / LIFETIME-3 — dead-kernel replacement
// ---------------------------------------------------------------------------

test("INV-KM-LIFETIME-1/3: mid-execution death retried once; kernelRestarted recorded; no notice", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: INV-KM-LIFETIME-1 + INV-KM-LIFETIME-3 (F-013/F-031/F-029)
   * - Category: invariant (fault injection at transport)
   * - Risk tier: High
   */
  let startCount = 0
  let died = false
  const transport = makeTransport({
    start: () => { startCount += 1 },
    execute: async () => {
      if (!died) {
        died = true
        throw new Error("kernel process died mid-execution")
      }
      return { code: 0, stdout: "recovered", stderr: "", result: "" }
    },
  })
  const manager = new KernelManager(transport, { clock: makeClock(), artifactsDir: artifactsDir() })
  const r = await manager.execute("fragile")
  expect(r.status).toBe("ok")
  expect(r.stdout).toBe("recovered")
  expect((r as { kernelRestarted?: boolean }).kernelRestarted).toBe(true)
  expect(startCount).toBe(2)
  expect(manager.compactionNotice()).toBeNull()
})

// ---------------------------------------------------------------------------
// SEQ-KM-3 — debounced snapshot; coalescing
// ---------------------------------------------------------------------------

test("SEQ-KM-3: successful execution schedules a debounced snapshot", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: SEQ-KM-3 (F-180)
   * - Category: timing (virtual clock — fully deterministic)
   * - Risk tier: High — snapshot is the durability surface
   */
  const clock = makeClock()
  const transport = makeTransport()
  const manager = new KernelManager(transport, { clock, artifactsDir: artifactsDir() })
  await manager.execute("x = 1")
  expect(transport.calls.some(c => c.kind === "writeSnapshot")).toBe(false)
  await clock.advance(SNAPSHOT_DEBOUNCE_MS + 1)
  expect(transport.calls.some(c => c.kind === "writeSnapshot")).toBe(true)
})

test("SEQ-KM-3 coalescing: successive executions defer to one snapshot per quiet window", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: SEQ-KM-3 (debounce semantics)
   * - Category: boundary
   * - Risk tier: Low-Medium
   */
  const clock = makeClock()
  const transport = makeTransport()
  const manager = new KernelManager(transport, { clock, artifactsDir: artifactsDir() })
  await manager.execute("a = 1")
  await clock.advance(SNAPSHOT_DEBOUNCE_MS / 2)
  await manager.execute("b = 2")
  await clock.advance(SNAPSHOT_DEBOUNCE_MS / 2 + 1)
  expect(transport.calls.filter(c => c.kind === "writeSnapshot").length).toBe(0)
  await clock.advance(SNAPSHOT_DEBOUNCE_MS + 1)
  expect(transport.calls.filter(c => c.kind === "writeSnapshot").length).toBe(1)
})

// ---------------------------------------------------------------------------
// SEQ-KM-4 — dispose flush ordering
// ---------------------------------------------------------------------------

test("SEQ-KM-4: dispose flushes the snapshot BEFORE transport teardown", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: SEQ-KM-4 (F-181)
   * - Category: integration (lifecycle ordering)
   * - Risk tier: High
   */
  const transport = makeTransport()
  const manager = new KernelManager(transport, { clock: makeClock(), artifactsDir: artifactsDir() })
  await manager.execute("final = 'state'")
  await manager.dispose({ snapshot: true })
  const kinds = transport.calls.map(c => c.kind)
  expect(kinds.indexOf("writeSnapshot")).toBeGreaterThan(-1)
  expect(kinds.indexOf("writeSnapshot")).toBeLessThan(kinds.lastIndexOf("transportDispose"))
})

// ---------------------------------------------------------------------------
// FORBIDDEN-KM-1 — crash-mid-write protection (temp+rename at the manager)
// ---------------------------------------------------------------------------

test("FORBIDDEN-KM-1: crash during snapshot write leaves the prior payload intact", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: FORBIDDEN-KM-1 + INV-KM-2 (F-171, REQ-RLM-0011): the
   *      manager writes snapshots through temp+rename, so a crash
   *      mid-write cannot destroy the previous payload
   * - Category: invariant (fault injection at the write boundary — the
   *      payload writer throws after producing partial temp content)
   * - Risk tier: High — the durability guarantee itself
   */
  const dir = artifactsDir()
  const payloadPath = `${dir}/kernel-state.dill`
  fs.writeFileSync(payloadPath, "PRIOR SNAPSHOT PAYLOAD")
  const clock = makeClock()
  let attempts = 0
  // The transport's payload writer crashes mid-write EVERY time. The
  // manager's atomicity requirement: the crash corrupts at most a temp
  // file; the prior payload on disk remains intact.
  const transport = makeTransport({
    writeSnapshotPayload: async (targetDir: string) => {
      attempts += 1
      // Simulated partial write into the real payload path — this is what
      // a NON-atomic implementation would do; the manager must prevent it
      // by never handing the real path to the writer before the swap.
      // We attempt the worst case: the writer writes partial content
      // wherever it was told and then throws.
      fs.writeFileSync(`${targetDir}/kernel-state.dill.tmp-crash`, "PARTIAL")
      throw new Error("crash mid-write")
    },
  })
  const manager = new KernelManager(transport, { clock, artifactsDir: dir })
  await manager.execute("x = 1")
  await clock.advance(SNAPSHOT_DEBOUNCE_MS + 1)
  await new Promise(r => setTimeout(r, 5))
  expect(attempts).toBe(1)
  expect(fs.readFileSync(payloadPath, "utf8")).toBe("PRIOR SNAPSHOT PAYLOAD")
})

// ---------------------------------------------------------------------------
// FORBIDDEN-KM-3 — skip-set
// ---------------------------------------------------------------------------

test("FORBIDDEN-KM-3: snapshot excludes ALWAYS_SKIP names; skips recorded", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: FORBIDDEN-KM-3 (F-173/F-174)
   * - Category: negative-space
   * - Risk tier: Medium
   */
  const clock = makeClock()
  let requestedNames: string[] = []
  const transport = makeTransport({
    snapshotNames: async () => ["user_var", ...SNAPSHOT_ALWAYS_SKIP],
    writeSnapshot: async (names: string[]) => {
      requestedNames = names
      return { bytes: 4, skipped: [{ name: "open", reason: "always-skip" }] }
    },
  })
  const manager = new KernelManager(transport, { clock, artifactsDir: artifactsDir() })
  await manager.execute("user_var = 1")
  await clock.advance(SNAPSHOT_DEBOUNCE_MS + 1)
  expect(requestedNames).toEqual(["user_var"])
})

// ---------------------------------------------------------------------------
// SEQ-KM-5 — compaction notice
// ---------------------------------------------------------------------------

test("SEQ-KM-5: compaction completion injects the namespace-inventory notice", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: SEQ-KM-5 (F-179, IP-6)
   * - Category: integration (lifecycle surface)
   * - Risk tier: Medium
   */
  const transport = makeTransport({ snapshotNames: async () => ["df", "model"] })
  const manager = new KernelManager(transport, { clock: makeClock(), artifactsDir: artifactsDir() })
  await manager.execute("df = load()")
  expect(manager.compactionNotice()).toBeNull()
  await manager.onCompactionComplete()
  const notice = manager.compactionNotice()
  expect(notice).not.toBeNull()
  expect(notice).toContain("df")
  expect(notice).toContain("model")
  expect(notice.toLowerCase()).toContain("persist")
})

// ---------------------------------------------------------------------------
// INV-KM-LIFETIME-2 — dispose timeout
// ---------------------------------------------------------------------------

test("INV-KM-LIFETIME-2: dispose bounds in-flight work; kills the process", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: INV-KM-LIFETIME-2 (F-012)
   * - Category: timing boundary (virtual clock; rejection handled in-tick)
   * - Risk tier: Medium
   */
  const clock = makeClock()
  const transport = makeTransport({ execute: () => new Promise<TransportResult>(() => {}) })
  const manager = new KernelManager(transport, { clock, artifactsDir: artifactsDir() })
  const pending = manager.execute("while True: pass")
  void pending.catch(() => {}) // handler attached same tick
  const disposed = manager.dispose()
  await clock.advance(DISPOSE_TIMEOUT_MS + 10)
  await disposed
  expect(transport.calls.some(c => c.kind === "kill")).toBe(true)
  expect(transport.calls.some(c => c.kind === "transportDispose")).toBe(true)
})
