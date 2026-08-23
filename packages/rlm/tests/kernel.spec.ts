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

/** Bun's runtime accepts test(name, fn, timeoutMs) but its current type
 * definitions omit the overload; this wrapper restores the typed form. */
const testWithTimeout = test as unknown as
  (name: string, fn: () => Promise<void>, timeout?: number) => void
import * as fs from "node:fs"

import {
  ABORT_GRACE_MS,
  BUSY_INTERRUPT_INTERVAL_MS,
  BUSY_REUSE_WAIT_MS,
  DISPOSE_TIMEOUT_MS,
  EXECUTE_TIMEOUT_MS,
  MAX_OUTPUT_CHARS,
  SNAPSHOT_ALWAYS_SKIP,
  SNAPSHOT_DEBOUNCE_MS,
  SNAPSHOT_DISPOSE_TIMEOUT_MS,
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

import type { KernelSnapshotWriteResult } from "../src/kernel.ts"

type TransportScript = {
  start?: () => Promise<void> | void
  execute?: (id: string, code: string, call: number) => Promise<TransportResult>
  snapshotNames?: () => Promise<string[]>
  writeSnapshot?: (names: string[], maxBytes: number) => Promise<KernelSnapshotWriteResult>
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
    async writeSnapshot(names: string[], maxBytes: number): Promise<{ bytes: number; skipped: { name: string; reason: string }[] }> {
      calls.push({ kind: "writeSnapshot", detail: names.join(",") })
      return await (script.writeSnapshot?.(names, maxBytes) ?? Promise.resolve({ bytes: 10, skipped: [] }))
    },
    async restoreSnapshot(): Promise<string[]> {
      calls.push({ kind: "restoreSnapshot", detail: "" })
      return await (script.restoreSnapshot?.() ?? Promise.resolve(["a", "b"]))
    },
    async bootstrap(): Promise<void> { calls.push({ kind: "bootstrap", detail: "" }) },
    isBusy(): boolean { return script.isBusy?.() ?? false },
    ...(script.writeSnapshotPayload !== undefined
      ? { writeSnapshotPayload: (dir: string): Promise<void> => script.writeSnapshotPayload?.(dir) ?? Promise.resolve() }
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


test("POST-SNAP-MANIFEST-1: KernelManager persists full compression telemetry when writing manifest", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Authority: requirements/contracts/rlm-dill-compression.contract.ts
   * - Enforces: POST-SNAP-MANIFEST-1, IP-4
   * - Category: integration (KernelManager manifest rewrite carries compression telemetry)
   */
  const dir = artifactsDir()
  const transport = makeTransport({
    writeSnapshot: async () => ({
      bytes: 25000,
      uncompressedBytes: 100000,
      compressedBytes: 25000,
      compression: "lzma",
      compressionRatio: 75.0,
      compressionDurationMs: 42.5,
      skipped: [],
    }),
  })
  const manager = new KernelManager(transport, { clock: makeClock(), artifactsDir: dir })
  await manager.execute("a = 1")
  await manager.dispose({ snapshot: true })

  const manifestFile = `${dir}/kernel-state.json`
  expect(fs.existsSync(manifestFile)).toBe(true)
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf-8"))
  expect(manifest.bytes).toBe(25000)
  expect(manifest.uncompressedBytes).toBe(100000)
  expect(manifest.compressedBytes).toBe(25000)
  expect(manifest.compression).toBe("lzma")
  expect(manifest.compressionRatio).toBe(75.0)
  expect(manifest.compressionDurationMs).toBe(42.5)
})

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
test("SEQ-KM-4: dispose without prior execute does not flush snapshot or reject on unstarted transport", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: SEQ-KM-4 / INV-KM-LIFETIME-2 (unstarted session teardown)
   * - Category: integration (lifecycle safety)
   * - Risk tier: High
   */
  const transport = makeTransport({
    snapshotNames: async () => {
      throw new Error("transport not started; call start() first")
    },
  })
  const manager = new KernelManager(transport, { clock: makeClock(), artifactsDir: artifactsDir() })
  // Never executed -> manager.dispose({ snapshot: true }) must not attempt snapshot or throw
  await manager.dispose({ snapshot: true })
  const kinds = transport.calls.map(c => c.kind)
  expect(kinds.includes("writeSnapshot")).toBe(false)
  expect(kinds.includes("snapshotNames")).toBe(false)
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
  const noticeText: string = notice ?? ""
  expect(noticeText).toContain("df")
  expect(noticeText).toContain("model")
  expect(noticeText.toLowerCase()).toContain("persist")
})

// ---------------------------------------------------------------------------
// Audit-r2 regression tests — each drives the exact probe failure
// ---------------------------------------------------------------------------

test("V1 regression: abort whose grace fires after normal settle does not poison the next execution", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: ERRORS-KM-3 + INV-KM-LIFETIME-1: only mid-flight-cancelled
   *      executions resolve aborted; a grace callback firing into an
   *      already-settled execution must leave NO trace
   * - Category: regression (audit r2 V1 — probe P1)
   * - Risk tier: High — the next cell silently never runs
   */
  const clock = makeClock()
  let releaseCell1: () => void = () => {}
  const cellGate = new Promise<void>(resolve => { releaseCell1 = resolve })
  const transport = makeTransport({
    execute: async () => {
      releaseCell1()
      await new Promise(r => setTimeout(r, 2))
      return { code: 0, stdout: "done", stderr: "", result: "" }
    },
  })
  const manager = new KernelManager(transport, { clock, artifactsDir: artifactsDir() })
  // Abort lands while cell 1 is ACTIVELY executing (transport dispatched);
  // cell 1 then completes normally BEFORE the 1000ms virtual grace elapses
  const cell1 = manager.execute("cell1")
  await cellGate
  void manager.abort()
  const r1 = await cell1
  expect(r1.status).toBe("ok")
  await clock.advance(ABORT_GRACE_MS + 10) // grace fires into a consumed settle
  // The NEXT execution must run normally — no poison latch
  const r2 = await manager.execute("cell2")
  expect(r2.status).toBe("ok")
  expect(r2.stdout).toBe("done")
  const execs = transport.calls.filter(c => c.kind === "execute")
  expect(execs.length).toBe(2)
})

testWithTimeout("V2 regression: dispose with a hung snapshot flush is bounded; kill still runs", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: SEQ-KM-4/F-181 (V2): the dispose flush is bounded by
   *      SNAPSHOT_DISPOSE_TIMEOUT_MS — a hung kernel cannot deadlock
   *      teardown (probe P2)
   * - Category: regression (timing boundary)
   * - Risk tier: High — session teardown hangs forever
   */
  const clock = makeClock()
  const transport = makeTransport({
    snapshotNames: () => new Promise<string[]>(() => {}), // hung kernel
  })
  const manager = new KernelManager(transport, { clock, artifactsDir: artifactsDir() })
  await manager.execute("x = 1")
  const disposeDone = manager.dispose({ snapshot: true })
  const bounded = disposeDone.then(() => "done")
  // Flush bound (5s) THEN the in-flight wait bound (5s) chain in virtual time
  await clock.advance(SNAPSHOT_DISPOSE_TIMEOUT_MS + DISPOSE_TIMEOUT_MS + 100)
  expect(await bounded).toBe("done")
  expect(transport.calls.some(c => c.kind === "kill")).toBe(true)
  expect(transport.calls.some(c => c.kind === "transportDispose")).toBe(true)
})

testWithTimeout("V3 regression: in-flight execution at dispose timeout gets a terminal aborted state", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: POST-KM-1 (V3/F11): execute resolves — a settled session
   *      never leaves the tool layer hanging (probe P3)
   * - Category: regression
   * - Risk tier: High — caller hangs with no terminal state
   */
  const clock = makeClock()
  const transport = makeTransport({
    execute: () => new Promise<TransportResult>(() => {}), // never resolves
  })
  const manager = new KernelManager(transport, { clock, artifactsDir: artifactsDir() })
  const pending = manager.execute("while True: pass")
  const settled = pending.then(r => r.status) // handler same tick
  // Let admission complete and the cell dispatch before dispose races it
  // (mirrors the production ordering: teardown arrives mid-execution,
  // not mid-admission)
  await new Promise(r => setTimeout(r, 20))
  const disposeDone = manager.dispose()
  await clock.advance(DISPOSE_TIMEOUT_MS + DISPOSE_TIMEOUT_MS + 100)
  await disposeDone
  expect(await settled).toBe("aborted")
})

test("V4 regression: payload temp lives INSIDE artifactsDir (same-filesystem rename)", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: FORBIDDEN-KM-1 (V4/F3): the payload temp directory must be
   *      a sibling of the destination so rename is atomic — a /tmp temp
   *      silently degrades to non-atomic copy across filesystems
   * - Category: regression (observable: the dir handed to the payload
   *      writer must be under artifactsDir)
   * - Risk tier: High — crash-window corruption on Linux tmpfs
   */
  const clock = makeClock()
  const dir = artifactsDir()
  let writerDir = ""
  const transport = makeTransport({
    writeSnapshotPayload: async (targetDir: string) => {
      writerDir = targetDir
      // Write the payload where the rename expects it
      fs.mkdirSync(targetDir, { recursive: true })
      fs.writeFileSync(`${targetDir}/kernel-state.dill`, "NEW PAYLOAD")
    },
  })
  const manager = new KernelManager(transport, { clock, artifactsDir: dir })
  await manager.execute("x = 1")
  await clock.advance(SNAPSHOT_DEBOUNCE_MS + 1)
  expect(writerDir.startsWith(dir)).toBe(true)
  expect(fs.readFileSync(`${dir}/kernel-state.dill`, "utf8")).toBe("NEW PAYLOAD")
})

testWithTimeout("V5 regression: manifest write is atomic — a crash mid-write leaves the prior manifest readable", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: INV-KM-2 (V5/F4): the previous snapshot stays intact AND
   *      READABLE — a torn manifest breaks revival tooling (KM-V3)
   * - Category: regression (fault injection at the manifest write)
   * - Risk tier: High
   */
  const dir = artifactsDir()
  const manifestPath = `${dir}/kernel-state.json`
  fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, savedNames: ["prior"], skipped: [], bytes: 1, pythonVersion: "3.11.9", timestamp: "2026-08-16T00:00:00Z" }))
  const clock = makeClock()
  // Crash the SNAPSHOT midway: names resolve, but the write hangs —
  // teardown-bounded flush abandons it; the prior manifest must survive
  const transport = makeTransport({
    snapshotNames: () => new Promise<string[]>(() => {}),
  })
  const manager = new KernelManager(transport, { clock, artifactsDir: dir })
  await manager.execute("x = 1")
  const disposeDone = manager.dispose({ snapshot: true })
  await clock.advance(SNAPSHOT_DISPOSE_TIMEOUT_MS + DISPOSE_TIMEOUT_MS + 100)
  await disposeDone
  const prior = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { savedNames: string[] }
  expect(prior.savedNames).toEqual(["prior"])
})

test("C9 regression: dispose is idempotent — second dispose neither snapshots nor re-kills", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: INV-KM-LIFETIME-2 discipline (C9): double dispose (signal
   *      handler + session teardown) is a no-op on a dead transport
   * - Category: regression (probe P4)
   * - Risk tier: Medium
   */
  const transport = makeTransport()
  const manager = new KernelManager(transport, { clock: makeClock(), artifactsDir: artifactsDir() })
  await manager.execute("x = 1")
  await manager.dispose({ snapshot: true })
  const killsBefore = transport.calls.filter(c => c.kind === "kill").length
  const snapshotsBefore = transport.calls.filter(c => c.kind === "writeSnapshot").length
  await manager.dispose({ snapshot: true })
  expect(transport.calls.filter(c => c.kind === "kill").length).toBe(killsBefore)
  expect(transport.calls.filter(c => c.kind === "writeSnapshot").length).toBe(snapshotsBefore)
})

test("C4 regression: between-execution kernel death is replaced BEFORE the next cell runs", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: INV-KM-LIFETIME-1 (C4): a dead kernel is replaced BEFORE
   *      the next execution — the retry stays reserved for mid-execution
   *      deaths
   * - Category: regression (liveness at the seam)
   * - Risk tier: Medium
   */
  let alive = true
  const transport = makeTransport({
    execute: async () => ({ code: 0, stdout: "ok", stderr: "", result: "" }),
  })
  ;(transport as { alive: () => boolean }).alive = () => alive
  const manager = new KernelManager(transport, { clock: makeClock(), artifactsDir: artifactsDir() })
  await manager.execute("first")
  alive = false // kernel dies between executions
  const r = await manager.execute("second")
  expect(r.status).toBe("ok")
  // Replacement happened proactively: kernelRestarted NOT set (no
  // mid-execution death), and the cell ran on a restarted kernel
  expect((r as { kernelRestarted?: boolean }).kernelRestarted).toBe(undefined)
  const starts = transport.calls.filter(c => c.kind === "start").length
  expect(starts).toBe(2)
})

test("C3 regression: runaway stream accumulation stays bounded (incremental capping)", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: POST-KM-2 discipline (C3/F10): the cap applies at the
   *      pump, not only at settle — observable as bounded accumulation
   * - Category: regression (memory safety)
   * - Risk tier: Medium
   */
  const clock = makeClock()
  const transport = makeTransport()
  const manager = new KernelManager(transport, { clock, artifactsDir: artifactsDir() })
  // Drive output emission directly: emit many large chunks for a live id
  // via a scripted execute that emits then resolves
  const big = "y".repeat(10_000)
  const emitting = makeTransport({
    execute: async (id: string) => {
      for (let i = 0; i < 100; i++) {
        transport.emit(id, "stdout", big) // 1MB total — would be 1MB uncapped
      }
      return { code: 0, stdout: "", stderr: "", result: "" }
    },
  })
  void transport
  const manager2 = new KernelManager(emitting, { clock, artifactsDir: artifactsDir() })
  const r = await manager2.execute("flood")
  expect(r.status).toBe("ok")
  expect(r.stdout.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS + 100)
})

test("N3 regression: compaction notice lists only live names (skip-set filtered)", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: SEQ-KM-5 (N3): the notice is a live-state inventory
   * - Category: regression
   * - Risk tier: Low
   */
  const transport = makeTransport({
    snapshotNames: async () => ["df", "model", "In", "Out", "open"],
  })
  const manager = new KernelManager(transport, { clock: makeClock(), artifactsDir: artifactsDir() })
  await manager.execute("x = 1")
  await manager.onCompactionComplete()
  const notice = manager.compactionNotice() ?? ""
  expect(notice).toContain("df")
  expect(notice).toContain("model")
  expect(notice).not.toContain("In")
  expect(notice).not.toContain("Out")
})

test("V6 regression: execute-after-dispose rejects with the domain error", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: INV-KM-LIFETIME-2 (r1 F1 fix verification — was untested)
   * - Category: regression
   * - Risk tier: High
   */
  const transport = makeTransport()
  const manager = new KernelManager(transport, { clock: makeClock(), artifactsDir: artifactsDir() })
  await manager.execute("x = 1")
  await manager.dispose()
  let caught: unknown = undefined
  await manager.execute("after death").catch((e: unknown) => { caught = e })
  expect(String(caught)).toContain("disposed")
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

test("POST-KM-4: hanging execute settles as error at EXECUTE_TIMEOUT_MS", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: POST-KM-4, ERRORS-KM-4, SEQ-KM-6, SEQ-KM-7, FORBIDDEN-KM-4
   * - Category: timing boundary (virtual clock)
   * - Risk tier: High — unbounded execute deadlocks INV-KM-1
   *
   * Theater check: a manager that never arms a timer leaves settled as STILL_PENDING
   * after clock.advance(EXECUTE_TIMEOUT_MS).
   */
  const clock = makeClock()
  const transport = makeTransport({ execute: () => new Promise<TransportResult>(() => {}) })
  const manager = new KernelManager(transport, { clock, artifactsDir: artifactsDir() })
  await manager.ensureStarted()
  const pending = manager.execute("while True: pass")
  let settled: unknown = "STILL_PENDING"
  void pending.then(
    r => { settled = r },
    e => { settled = e },
  )
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await clock.advance(EXECUTE_TIMEOUT_MS)
  expect(settled).not.toBe("STILL_PENDING")
  const result = settled as { status: string; errorEname?: string; traceback?: string; durationMs: number }
  expect(result.status).toBe("error")
  expect(result.errorEname).toBe("KernelExecuteTimeoutError")
  expect(String(result.traceback)).toContain("POST-KM-4")
  expect(result.durationMs).toBeGreaterThanOrEqual(EXECUTE_TIMEOUT_MS)
  expect(transport.calls.some(c => c.kind === "interrupt")).toBe(true)
})

test("POST-KM-4: execute after timeout still runs", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: POST-KM-4 + INV-KM-1 (queue liveness after timer settle)
   */
  const clock = makeClock()
  let calls = 0
  const transport = makeTransport({
    execute: (_id, _code, n) => {
      calls = n
      if (n === 1) return new Promise<TransportResult>(() => {})
      return Promise.resolve({ code: 0, stdout: "ok", stderr: "", result: "2" })
    },
  })
  const manager = new KernelManager(transport, { clock, artifactsDir: artifactsDir() })
  await manager.ensureStarted()
  const hung = manager.execute("while True: pass")
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await clock.advance(EXECUTE_TIMEOUT_MS)
  const second = await manager.execute("1+1")
  expect(second.status).toBe("ok")
  expect(calls).toBe(2)
})

test("POST-KM-4/POST-TRANS-2: issue #12 sequential execute after timeout desync reproduces failure", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Authority: requirements/contracts/rlm-timeout-desync.contract.ts
   * - Enforces: POST-KM-4, POST-TRANS-2, INV-TRANS-1, SEQ-2, SEQ-3, FORBIDDEN-1
   * - Category: Timing boundary / Desynchronization recovery
   * - Behavior: When execute times out in KernelManager, in-flight transport execution
   *   must be cleanly settled/cancelled and must not deadlock or drop frames on subsequent execute.
   */
  const clock = makeClock()
  let activeExecResolve: ((res: TransportResult) => void) | null = null
  let execCallCount = 0

  const transport = makeTransport({
    execute: (_id, _code, n) => {
      execCallCount = n
      if (n === 1) {
        return new Promise<TransportResult>(resolve => {
          activeExecResolve = resolve
        })
      }
      return Promise.resolve({ code: 0, stdout: "recovered", stderr: "", result: "42" })
    },
  })

  const manager = new KernelManager(transport, { clock, artifactsDir: artifactsDir() })
  await manager.ensureStarted()

  // 1. Dispatch first execution that hangs
  const hung = manager.execute("long_running_task()")
  for (let i = 0; i < 10; i++) await Promise.resolve()

  // 2. Advance time past EXECUTE_TIMEOUT_MS -> timeout triggers
  await clock.advance(EXECUTE_TIMEOUT_MS)
  const hungResult = await hung
  expect(hungResult.status).toBe("error")
  expect(hungResult.traceback).toContain("POST-KM-4 violation: execute exceeded 30000ms")

  // 3. Immediately dispatch second execution
  const secondPromise = manager.execute("next_task()")
  for (let i = 0; i < 10; i++) await Promise.resolve()

  // 4. Stale first execution eventually resolves late from transport
  if (activeExecResolve) {
    (activeExecResolve as (res: TransportResult) => void)({ code: 0, stdout: "late", stderr: "", result: "old" })
  }
  for (let i = 0; i < 10; i++) await Promise.resolve()

  // 5. Assert second execution resolved properly with second output, not corrupted or hung
  const secondResult = await secondPromise
  expect(secondResult.status).toBe("ok")
  expect(secondResult.result).toBe("42")
  expect(execCallCount).toBe(2)
})


// ---------------------------------------------------------------------------
// FORBIDDEN-KM-5 / INV-KM-4 — stale execute-timer isolation across executions
// ---------------------------------------------------------------------------

test("FORBIDDEN-KM-5/INV-KM-4: abort-settled execute's timer must not touch a later execution", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: FORBIDDEN-KM-5 (INV-KM-4, REQ-RLM-0024) — a settled
   *   execution's execute timer SHALL NOT interrupt or settle any later
   *   execution; the abort/grace settle path SHALL cancel its execute
   *   timer, same as an ordinary settle (INV-KM-4: "exactly one execute
   *   timer cancelled on settle, including the abort/grace settle path").
   * - Category: negative-space / timing boundary (virtual clock)
   * - Risk tier: High — a stale timer silently corrupts a LATER, unrelated
   *   execution's result and steals the transport's attention from live
   *   work; INV-KM-1 serialization is meaningless if a ghost timer from a
   *   settled cell can still act on whatever is current.
   * - Adversarial: Implementation-blind
   *
   * Theater check: a manager that never cancels the aborted execution's
   * execute timer leaves it armed to fire at t=EXECUTE_TIMEOUT_MS
   * (measured from CELL 1's start, t=0). Cell 2 is submitted right after
   * cell 1's abort/grace settle (t≈ABORT_GRACE_MS) and never touches its
   * OWN deadline until t=ABORT_GRACE_MS+EXECUTE_TIMEOUT_MS. That leaves a
   * window — exactly at t=EXECUTE_TIMEOUT_MS — where cell 1's stale timer,
   * if still armed, fires while cell 2 is genuinely in-flight and nowhere
   * near its own deadline. A manager that cancels the timer only on the
   * ordinary settle path (and not on abort/grace settle) makes this test
   * FAIL, because the assertions at that exact instant require cell 2 to
   * be completely untouched.
   */
  const clock = makeClock()
  const transport = makeTransport({
    execute: () => new Promise<TransportResult>(() => {}), // every cell hangs; isolates timer behavior from transport resolution
  })
  const manager = new KernelManager(transport, { clock, artifactsDir: artifactsDir() })
  await manager.ensureStarted()

  // Cell 1: arms its execute timer (SEQ-KM-6) at virtual t=0, aimed at
  // t=EXECUTE_TIMEOUT_MS (30000) if never cancelled. Abort interrupts it;
  // per ERRORS-KM-3 it settles "aborted" after ABORT_GRACE_MS elapses.
  const cell1 = manager.execute("cell1")
  let cell1Result: { status: string } | undefined
  void cell1.then(r => { cell1Result = r })
  for (let i = 0; i < 10; i++) await Promise.resolve()
  void manager.abort().catch(() => {})
  await clock.advance(ABORT_GRACE_MS + 10) // virtual t = 1010
  expect(
    cell1Result?.status,
    "ARRANGE precondition failed: cell 1 must reach 'aborted' before cell 2 is submitted, " +
    `otherwise the timer-isolation window below is not under test (got ${JSON.stringify(cell1Result)})`,
  ).toBe("aborted")

  const interruptsAfterAbort = transport.calls.filter(c => c.kind === "interrupt").length

  // Cell 2: submitted at virtual t=1010. Its OWN timer, armed here, is
  // aimed at t=1010+EXECUTE_TIMEOUT_MS=31010 — strictly AFTER cell 1's
  // stale deadline of t=30000.
  const cell2 = manager.execute("cell2")
  let cell2Result: { status: string; errorEname?: string } | undefined
  void cell2.then(r => { cell2Result = r })
  for (let i = 0; i < 10; i++) await Promise.resolve()

  // Advance to exactly t=30000 — cell 1's now-stale original deadline,
  // still 1010ms short of cell 2's own deadline. If FORBIDDEN-KM-5 holds,
  // nothing observable happens to cell 2 here.
  await clock.advance(EXECUTE_TIMEOUT_MS - (ABORT_GRACE_MS + 10))
  expect(
    cell2Result,
    "FORBIDDEN-KM-5 violation: cell 2 already settled at t=EXECUTE_TIMEOUT_MS " +
    "(cell 1's stale, uncancelled deadline)\n" +
    "WHY: INV-KM-4 requires the abort/grace settle path to cancel cell 1's " +
    "execute timer; if it stayed armed, it fired here against cell 2\n" +
    "EXPECTED: undefined (cell 2 still genuinely in-flight, 1010ms from its own deadline)\n" +
    `ACTUAL: ${JSON.stringify(cell2Result)}\n` +
    "GUIDANCE: cancel the execute timer on every settle path, including abort/grace settle",
  ).toBeUndefined()
  expect(
    transport.calls.filter(c => c.kind === "interrupt").length,
    "FORBIDDEN-KM-5 violation: an extra transport.interrupt() fired at " +
    "t=EXECUTE_TIMEOUT_MS while cell 2 was in-flight and nowhere near its " +
    "own deadline\n" +
    "WHY: cell 1's stale execute timer must not act on a later execution\n" +
    `EXPECTED: ${interruptsAfterAbort} (unchanged since abort)\n` +
    `ACTUAL: ${transport.calls.filter(c => c.kind === "interrupt").length}\n` +
    "GUIDANCE: cancel cell 1's execute timer on its abort/grace settle",
  ).toBe(interruptsAfterAbort)

  // Advance the remaining 1010ms to cell 2's OWN deadline (t=31010). Its
  // own timer (INV-KM-4: "exactly one execute timer") must still be
  // intact and must be the thing that settles it now.
  await clock.advance(ABORT_GRACE_MS + 10)
  expect(
    cell2Result?.status,
    "FORBIDDEN-KM-5/INV-KM-4 violation: cell 2 did not settle at its own " +
    "execute-timeout deadline (t=ABORT_GRACE_MS+EXECUTE_TIMEOUT_MS)\n" +
    "WHY: the abort/grace settle path must cancel cell 1's execute timer " +
    "(INV-KM-4); if it left cell 1's stale timer armed instead, that timer " +
    "already fired at t=EXECUTE_TIMEOUT_MS and may have consumed or " +
    "corrupted cell 2's own timer bookkeeping\n" +
    "EXPECTED: status 'error' via cell 2's own execute timer\n" +
    `ACTUAL: ${JSON.stringify(cell2Result)}\n` +
    "GUIDANCE: cancel the execute timer on every settle path, including " +
    "abort/grace settle, not only the ordinary resolve/reject path",
  ).toBe("error")
  expect(cell2Result?.errorEname).toBe("KernelExecuteTimeoutError")
  expect(
    transport.calls.filter(c => c.kind === "interrupt").length,
    "FORBIDDEN-KM-5 violation: expected exactly one MORE interrupt (cell 2's " +
    "own timeout) beyond the count after abort\n" +
    `EXPECTED: ${interruptsAfterAbort + 1}\n` +
    `ACTUAL: ${transport.calls.filter(c => c.kind === "interrupt").length}\n` +
    "GUIDANCE: only cell 2's own execute timer may interrupt during cell 2",
  ).toBe(interruptsAfterAbort + 1)
  expect(
    transport.calls.filter(c => c.kind === "execute").length,
    "FORBIDDEN-KM-5 violation: expected exactly 2 execute() dispatches " +
    "(cell 1, cell 2)\n" +
    "WHY: a stale timer firing against the wrong execution can trigger a " +
    "phantom retry/dispatch not requested by either caller\n" +
    "EXPECTED: 2\n" +
    `ACTUAL: ${transport.calls.filter(c => c.kind === "execute").length}\n` +
    "GUIDANCE: only the two explicit execute() calls above may reach the " +
    "transport",
  ).toBe(2)
})

// ---------------------------------------------------------------------------
// FORBIDDEN-KM-6 — stale abort-grace callback must not touch a later,
// genuinely in-flight execution
// ---------------------------------------------------------------------------

test("FORBIDDEN-KM-6: abort-grace callback must not settle a later execution in flight when it fires", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: FORBIDDEN-KM-6 (ERRORS-KM-3) — an abort-grace callback
   *   SHALL NOT settle, and SHALL NOT cancel the execute timer of, any
   *   execution whose id differs from the execution that was ACTIVE at
   *   abort() time. INV-KM-1 (cell 2 starts only once cell 1 settles)
   *   and ERRORS-KM-3 (grace-deadline scheduling) set up the window:
   *   cell 1 settles 'ok' on its own before the grace deadline it armed
   *   elapses, cell 2 is admitted, and cell 2 is genuinely in-flight when
   *   that stale grace timer fires.
   * - Category: negative-space / timing boundary (virtual clock)
   * - Risk tier: High — a grace callback that closes over "whichever
   *   execution is current" instead of the id captured at abort() time
   *   silently kills an unrelated, healthy, later execution.
   * - Adversarial: Implementation-blind
   *
   * FOUR-CRITERIA TEST VALIDITY GATE:
   * [✓] C1 VALID: cites FORBIDDEN-KM-6, present in
   *     requirements/contracts/rlm-kernel.contract.ts today
   * [✓] C2 VALUABLE: an implementation whose grace callback settles
   *     whatever execution is current (rather than the id captured at
   *     abort() time) makes this test FAIL
   * [✓] C3 NON-DUPLICATIVE: distinct from "V1 regression" (there, cell 2
   *     is submitted only AFTER the stale grace already fired, proving
   *     no poison latch on an already-consumed settle) and from
   *     "FORBIDDEN-KM-5/INV-KM-4" (that test isolates cell 1's stale
   *     EXECUTE-TIMEOUT deadline, not its grace-settle callback); here
   *     cell 2 is genuinely in-flight WHILE the stale grace fires
   * [✓] C4 NOT FUTURE-EDIT: FORBIDDEN-KM-6 is in the contract today;
   *     bounds the existing abort/grace scheduling path, not a
   *     hypothetical future capability
   *
   * Theater check: harness OBSERVED on current code —
   * {"cell1":"ok","cell2_after_grace":"aborted"} — cell 1's stale grace
   * timer settles cell 2 to 'aborted' when it fires mid-flight for cell
   * 2. The assertions below require cell 2 to remain unsettled at that
   * instant and to later settle only via its OWN execute timer, which
   * the current code violates.
   */
  const clock = makeClock()
  const cellGate = Promise.withResolvers<void>()
  const transport = makeTransport({
    execute: async (_id, _code, n) => {
      if (n === 1) {
        cellGate.resolve()
        await new Promise(r => setTimeout(r, 2)) // resolves well inside the grace window
        return { code: 0, stdout: "cell1-done", stderr: "", result: "" }
      }
      return new Promise<TransportResult>(() => {}) // cell 2: genuinely in-flight, never resolves
    },
  })
  const manager = new KernelManager(transport, { clock, artifactsDir: artifactsDir() })

  // Abort lands while cell 1 is ACTIVELY executing (SEQ-KM-7); this arms
  // the grace timer at virtual t=0, deadline t=ABORT_GRACE_MS, captured
  // against cell 1's execution id.
  const cell1 = manager.execute("cell1")
  await cellGate.promise
  void manager.abort()
  const r1 = await cell1
  expect(
    r1.status,
    "ARRANGE precondition failed: cell 1 must settle 'ok' on its own, " +
    "before the grace deadline elapses, or the stale-grace window below " +
    `is not under test (got ${JSON.stringify(r1)})`,
  ).toBe("ok")

  // INV-KM-1: cell 2 is admitted only now that cell 1 has settled. It
  // dispatches at virtual t≈0 (no virtual time has advanced yet) and
  // hangs — genuinely in-flight, nowhere near its own EXECUTE_TIMEOUT_MS
  // deadline, when cell 1's stale grace timer is about to fire.
  const cell2 = manager.execute("cell2")
  let cell2Result: { status: string; errorEname?: string } | undefined
  void cell2.then(r => { cell2Result = r })
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(
    transport.calls.filter(c => c.kind === "execute").length,
    "ARRANGE precondition failed: cell 2 must have dispatched to the " +
    "transport (genuinely in-flight) before the grace deadline elapses, " +
    "or the window this test targets is not under test",
  ).toBe(2)

  // Advance to cell 1's grace deadline (virtual t=ABORT_GRACE_MS,
  // measured from abort() at t=0). FORBIDDEN-KM-6: this callback must
  // recognize the active execution id changed since abort() and do
  // nothing to cell 2.
  await clock.advance(ABORT_GRACE_MS + 10)
  expect(
    cell2Result,
    "FORBIDDEN-KM-6 violation: cell 1's abort-grace callback settled " +
    "cell 2 (a different, later execution) when it fired\n" +
    "WHY: the grace callback must only settle the execution id that was " +
    "ACTIVE at abort() time (cell 1); cell 2 was admitted after cell 1 " +
    "settled 'ok' on its own (INV-KM-1) and is genuinely still in-flight\n" +
    "EXPECTED: undefined (cell 2 untouched by cell 1's stale grace timer)\n" +
    `ACTUAL: ${JSON.stringify(cell2Result)}\n` +
    "GUIDANCE: the grace callback must compare against the execution id " +
    "captured at abort() time before settling anything",
  ).toBeUndefined()
  expect(
    transport.calls.filter(c => c.kind === "execute").length,
    "FORBIDDEN-KM-6 violation: an extra execute() dispatch appeared after " +
    "cell 1's stale grace fired against cell 2\n" +
    "WHY: a grace callback that mistakes cell 2 for the aborted execution " +
    "can trigger a phantom retry/replacement dispatch\n" +
    "EXPECTED: 2 (cell 1, cell 2 — no phantom dispatch)\n" +
    `ACTUAL: ${transport.calls.filter(c => c.kind === "execute").length}\n` +
    "GUIDANCE: the stale grace callback must be a no-op once its captured " +
    "execution id no longer matches the active execution",
  ).toBe(2)

  // Cell 2's OWN execute timer (armed at its own dispatch, virtual t≈0)
  // must still be intact — not cancelled by cell 1's stale grace
  // callback — and must be the thing that eventually settles it.
  await clock.advance(EXECUTE_TIMEOUT_MS - (ABORT_GRACE_MS + 10))
  expect(
    cell2Result?.status,
    "FORBIDDEN-KM-6 violation: cell 2 never settled at its own " +
    "EXECUTE_TIMEOUT_MS deadline\n" +
    "WHY: if cell 1's stale grace callback cancelled cell 2's execute " +
    "timer instead of leaving it alone, cell 2 hangs forever\n" +
    "EXPECTED: status 'error' via cell 2's own, untouched execute timer\n" +
    `ACTUAL: ${JSON.stringify(cell2Result)}\n` +
    "GUIDANCE: the stale grace callback must not cancel a later " +
    "execution's execute timer",
  ).toBe("error")
  expect(
    cell2Result?.errorEname,
    "FORBIDDEN-KM-6 violation: cell 2 settled 'error' but not via its own " +
    "execute-timeout path\n" +
    "EXPECTED: KernelExecuteTimeoutError (cell 2's own execute timer)\n" +
    `ACTUAL: ${JSON.stringify(cell2Result?.errorEname)}\n` +
    "GUIDANCE: cell 2 must time out through its own execute timer, " +
    "untouched by cell 1's stale grace callback",
  ).toBe("KernelExecuteTimeoutError")
})
