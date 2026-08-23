/**
 * RED PHASE — RLM transport implementation tests (SLICE-4, TRANS-* clauses).
 *
 * Targets the IMPLEMENTATION artifact packages/rlm/src/transport.ts, not the
 * contract. At RED time the module does not exist; every test fails with a
 * module-resolution error.
 *
 * Added by the 2026-08-16 constitutional-refactor re-assessment: REQ-RLM-0019
 * assigned the real kernel spawn to SLICE-4 (requirements -> contracts ->
 * tests -> implementation provenance chain).
 *
 * CONTRACT AUTHORITY RECORD:
 * - File: requirements/contracts/rlm-transport.contract.ts
 * - PRE: 1, POST: 5, INV: 1, SEQ: 2, ERRORS: 3, FORBIDDEN: 2
 *
 * Two tiers (test pyramid):
 * - WIRE tier: fake process injected AT CONSTRUCTION, virtual clock for all
 *   timeouts. Drives protocol clauses deterministically.
 * - LIVE tier: real spawn through the SLICE-2 bootstrap (managed venv via
 *   real uv, warm-cache fast). Drives POST-TRANS-1/2/3/4/5 end-to-end,
 *   including the snapshot revival round-trip across two processes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import * as fs from "node:fs"
import { join } from "node:path"

import {
  RlmTransportContractError as ContractRlmTransportContractError,
  TRANS_FRAMES,
  TRANS_KILL_GRACE_MS,
  TRANS_OPS,
  TRANS_PROTOCOL_VERSION,
  TRANS_READY_TIMEOUT_MS,
  TRANS_RUNNER_FILE,
  TRANS_STDERR_TAIL_CHARS,
  TransportProtocolError as ContractTransportProtocolError,
  TransportSpawnError as ContractTransportSpawnError,
  TransportUnresponsiveError as ContractTransportUnresponsiveError,
  validateFrameType,
  validateTransportConfig,
} from "../../../requirements/contracts/rlm-transport.contract.ts"
import {
  bootstrapManagedVenv,
  buildKernelEnv,
  type KernelCaps,
  type KernelSession,
} from "../src/bootstrap.ts"
import {
  RlmTransportContractError,
  TransportProtocolError,
  TransportSpawnError,
  TransportUnresponsiveError,
  createTransport,
  RlmTransport,
  type RlmTransportProcess,
} from "../src/transport.ts"

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeClock() {
  let now = 0
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = []
  return {
    now: () => now,
    schedule(fn: () => void, ms: number): () => void {
      const t = { at: now + ms, fn, cancelled: false }
      timers.push(t)
      return () => { t.cancelled = true }
    },
    async advance(ms: number): Promise<void> {
      const target = now + ms
      for (;;) {
        const due = timers.filter(t => !t.cancelled && t.at <= target).sort((a, b) => a.at - b.at)[0]
        if (due === undefined) break
        now = due.at
        due.cancelled = true
        due.fn()
        await new Promise(r => setTimeout(r, 0))
      }
      now = target
    },
  }
}

const CONFIG = {
  interpreter: "/fake/python",
  env: { RLM_DEPTH: "0", RLM_SESSION_DIR: "/tmp/s" },
  cwd: "/tmp",
  artifactsDir: "/tmp/artifacts",
}

/** Fake runner process: scripted frames, captured signals, virtual exit. */
function makeFakeProcess(script: { failSpawn?: boolean } = {}) {
  const state = {
    spawnedWith: null as null | { cmd: string; args: string[]; cwd: string; env: Record<string, string> },
    stdinLines: [] as string[],
    stdinEnded: false,
    signals: [] as string[],
    exited: false,
    exitCallbacks: [] as Array<(code: number | null, signal: string | null) => void>,
  }
  let stdoutCb: ((chunk: string) => void) | null = null
  let stderrCb: ((chunk: string) => void) | null = null
  const proc: RlmTransportProcess = {
    stdin: {
      write(line: string) { state.stdinLines.push(line) },
      end() { state.stdinEnded = true },
    },
    onStdout(cb) { stdoutCb = cb },
    onStderr(cb) { stderrCb = cb },
    kill(signal) { state.signals.push(signal ?? "SIGTERM") },
    onExit(cb) { state.exitCallbacks.push(cb) },
  }
  return {
    proc,
    state,
    emitFrame(obj: unknown) { stdoutCb?.(JSON.stringify(obj) + "\n") },
    emitRaw(line: string) { stdoutCb?.(line + "\n") },
    emitStderr(text: string) { stderrCb?.(text) },
    exit(code: number | null, signal: string | null = null) {
      state.exited = true
      for (const cb of state.exitCallbacks) cb(code, signal)
    },
    spawnFactory(cmd: string, args: string[], opts: { cwd: string; env: Record<string, string> }) {
      if (script.failSpawn) throw new Error("spawn ENOENT")
      state.spawnedWith = { cmd, args, cwd: opts.cwd, env: opts.env }
      return proc
    },
  }
}

function makeWireTransport(fake: ReturnType<typeof makeFakeProcess>, clock = makeClock()) {
  const transport = createTransport(CONFIG, { clock, spawn: fake.spawnFactory })
  return { transport, clock }
}

async function startReady(fake: ReturnType<typeof makeFakeProcess>, transport: ReturnType<typeof createTransport>) {
  const pending = transport.start()
  pending.catch(() => undefined)
  await new Promise(r => setTimeout(r, 0))
  fake.emitFrame({ type: "ready", protocol: TRANS_PROTOCOL_VERSION, pythonVersion: "3.11.0" })
  await pending
}

// ---------------------------------------------------------------------------
// WIRE tier — protocol clauses against the fake process
// ---------------------------------------------------------------------------

describe("transport wire protocol", () => {
  test("SEQ-TRANS-1: ops before start are rejected; spawn happens only at start", async () => {
    // Risk tier: HIGH — an op issued before readiness hangs or dies on an
    // unready runner (manifest SEQ-12 failure mode).
    const fake = makeFakeProcess()
    const { transport } = makeWireTransport(fake)
    let rejectionError: unknown = null
    await transport.execute("e1", "x = 1").catch(err => { rejectionError = err })
    expect(rejectionError).toBeInstanceOf(RlmTransportContractError)
    expect(fake.state.spawnedWith).toBeNull()
  })

  test("POST-TRANS-1 + FORBIDDEN-TRANS-2: start spawns the runner with exactly the provided env", async () => {
    // Risk tier: HIGH — the spawn env is the credential-boundary last hop
    // (REQ-N-3, F-207); any added variable is a leak path.
    const fake = makeFakeProcess()
    const { transport } = makeWireTransport(fake)
    await startReady(fake, transport)
    const spawn = fake.state.spawnedWith
    expect(spawn).not.toBeNull()
    if (spawn === null) {
      throw new Error("fake.state.spawnedWith must not be null after startReady")
    }
    expect(spawn.cmd).toBe(CONFIG.interpreter)
    expect(spawn.args[spawn.args.length - 1].endsWith(TRANS_RUNNER_FILE)).toBe(true)
    expect(spawn.env).toEqual(CONFIG.env)
    expect(Object.keys(spawn.env).sort()).toEqual(Object.keys(CONFIG.env).sort())
  })

  test("ERRORS-TRANS-2: missing readiness frame within the gate raises with bounded stderr tail", async () => {
    // Risk tier: HIGH — F-224: without the stderr tail the user cannot
    // diagnose a kernel that never became ready. Stderr is emitted AFTER
    // start() begins (a process cannot produce stderr before it is spawned).
    const fake = makeFakeProcess()
    const { transport, clock } = makeWireTransport(fake)
    const pending = transport.start()
    pending.catch(() => undefined)
    await new Promise(r => setTimeout(r, 0))

    const discardPrefix = "DISCARDED_PREFIX_OVER_BUDGET_".repeat(200)
    const rawTail = "EXPECTED_DISTINGUISHABLE_TAIL_TOKEN_".repeat(100)
    const expectedTail = rawTail.slice(rawTail.length - TRANS_STDERR_TAIL_CHARS)
    fake.emitStderr(discardPrefix + expectedTail)

    await clock.advance(TRANS_READY_TIMEOUT_MS + 1)
    let caught: unknown
    await pending.catch(e => { caught = e })
    expect(caught).toBeInstanceOf(TransportUnresponsiveError)
    const message = (caught as Error).message
    expect(message.endsWith(expectedTail)).toBe(true)
    expect(message.includes("DISCARDED_PREFIX_OVER_BUDGET_")).toBe(false)
  })
  test("ERRORS-TRANS-3: a malformed frame fails loud, never degrades silently", async () => {
    // Risk tier: HIGH — CL15-B: silent wire corruption would poison results.
    const fake = makeFakeProcess()
    const { transport } = makeWireTransport(fake)
    await startReady(fake, transport)
    const exec = transport.execute("e1", "x = 1")
    exec.catch(() => undefined)
    await new Promise(r => setTimeout(r, 0))
    fake.emitRaw("this is not json{")
    let caught: unknown
    await exec.catch(e => { caught = e })
    expect(caught).toBeInstanceOf(TransportProtocolError)
  })

  test("ERRORS-TRANS-3: an unknown frame type fails loud", async () => {
    const fake = makeFakeProcess()
    const { transport } = makeWireTransport(fake)
    await startReady(fake, transport)
    const exec = transport.execute("e1", "x = 1")
    exec.catch(() => undefined)
    await new Promise(r => setTimeout(r, 0))
    fake.emitFrame({ type: "bogus", id: "e1" })
    let caught: unknown
    await exec.catch(e => { caught = e })
    expect(caught).toBeInstanceOf(TransportProtocolError)
  })

  test("INV-TRANS-1: frames with a stale id never leak into the active execution", async () => {
    // Risk tier: HIGH — POST-KM-3 transport surface: cross-talk between
    // executions corrupts cell output.
    const fake = makeFakeProcess()
    const { transport } = makeWireTransport(fake)
    await startReady(fake, transport)
    const outputs: Array<{ id: string; stream: string; data: string }> = []
    transport.onOutput(e => outputs.push({ id: e.id, stream: e.stream, data: e.data }))
    const exec = transport.execute("live", "print(1)")
    exec.catch(() => undefined)
    await new Promise(r => setTimeout(r, 0))
    fake.emitFrame({ type: "stdout", id: "stale", data: "LEAKED" })
    fake.emitFrame({ type: "stdout", id: "live", data: "ok" })
    fake.emitFrame({ type: "done", id: "live", code: 0, stdout: "ok", stderr: "", result: "" })
    const result = await exec
    expect(outputs.map(o => o.data)).toEqual(["ok"])
    expect(result.stdout).toBe("ok")
  })

  test("POST-TRANS-2: execute settles from the done frame with streams and error fields", async () => {
    // Risk tier: HIGH — the result mapping feeds KernelManager POST-KM-1.
    const fake = makeFakeProcess()
    const { transport } = makeWireTransport(fake)
    await startReady(fake, transport)
    const exec = transport.execute("e1", "raise ValueError('x')")
    exec.catch(() => undefined)
    await new Promise(r => setTimeout(r, 0))
    fake.emitFrame({
      type: "done", id: "e1", code: 1, stdout: "OUT", stderr: "ERR",
      result: "", traceback: "ValueError: x", errorEname: "ValueError",
    })
    const result = await exec
    expect(result).toEqual({
      code: 1, stdout: "OUT", stderr: "ERR", result: "",
      traceback: "ValueError: x", errorEname: "ValueError",
    })
  })

  test("SEQ-TRANS-2: kill sends SIGTERM then escalates to SIGKILL after the grace", async () => {
    // Risk tier: HIGH — F-016: a runner that ignores SIGTERM must not pin
    // the session forever.
    const fake = makeFakeProcess()
    const { transport, clock } = makeWireTransport(fake)
    await startReady(fake, transport)
    const killPending = transport.kill()
    if (killPending instanceof Promise) killPending.catch(() => undefined)
    await new Promise(r => setTimeout(r, 0))
    expect(fake.state.signals).toEqual(["SIGTERM"])
    await clock.advance(TRANS_KILL_GRACE_MS + 1)
    expect(fake.state.signals).toEqual(["SIGTERM", "SIGKILL"])
  })

  test("ERRORS-TRANS-1: a spawn failure surfaces as TransportSpawnError", async () => {
    // Risk tier: MEDIUM — CL15 fail-fast with the underlying cause.
    const fake = makeFakeProcess({ failSpawn: true })
    const { transport } = makeWireTransport(fake)
    let caught: unknown
    await transport.start().catch(e => { caught = e })
    expect(caught).toBeInstanceOf(TransportSpawnError)
  })

  test("POST-TRANS-6: host_request mid-execute routes to the host bridge and writes host_reply without settling the execute", async () => {
    // Risk tier: HIGH — MCP/bridge (REQ-RLM-0022) rides this wire. A
    // host_request that is dropped, or that settles the in-flight execute,
    // breaks every in-kernel host call.
    //
    // SEAM: transport.onHostRequest(handler) registers the host-bridge
    // handler. On a host_request frame the transport invokes the handler and
    // writes a host_reply op (matching id) back to the runner. GREEN fixes
    // the exact seam name if it differs; the asserted behavior is the wire
    // contract.
    const fake = makeFakeProcess()
    const { transport } = makeWireTransport(fake)
    await startReady(fake, transport)

    const seen: Array<{ type: string; payload: Record<string, unknown> }> = []
    transport.onHostRequest(async request => {
      seen.push(request)
      return { value: 42 }
    })

    const exec = transport.execute("e1", "await rlm.host_request('mcp.call')")
    let settled = false
    exec.then(() => { settled = true }, () => { settled = true })
    await new Promise(r => setTimeout(r, 0))

    // Runner emits a host_request frame mid-execute.
    fake.emitFrame({ type: "host_request", id: "hr1", requestType: "mcp.call", payload: { server: "linear" } })
    await new Promise(r => setTimeout(r, 0))

    expect(seen).toEqual([{ type: "mcp.call", payload: { server: "linear" } }])

    // The transport wrote exactly one host_reply op, matched by id, carrying
    // the handler's reply, status ok.
    const replies = fake.state.stdinLines
      .map(l => JSON.parse(l) as Record<string, unknown>)
      .filter(f => f.op === "host_reply")
    expect(replies.length).toBe(1)
    expect(replies[0].id).toBe("hr1")
    expect(replies[0].status).toBe("ok")
    expect(replies[0].value).toBe(42)

    // The host_request/host_reply exchange did NOT settle the execute.
    expect(settled).toBe(false)

    // Only the done frame settles the execute.
    fake.emitFrame({ type: "done", id: "e1", code: 0, stdout: "", stderr: "", result: "" })
    await exec
    expect(settled).toBe(true)
  })

  test("POST-TRANS-2/POST-TRANS-3: sequential execute after timeout/interrupt desync recovers cleanly", async () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Authority: requirements/contracts/rlm-timeout-desync.contract.ts
     * - Enforces: POST-TRANS-2, POST-TRANS-3, INV-TRANS-1, SEQ-3, FORBIDDEN-1, FORBIDDEN-2
     * - Category: Wire tier protocol / Desync recovery
     * - Behavior: When execute is interrupted / times out, subsequent execute must not deadlock
     *   or be corrupted when stale done frame arrives from runner.
     */
    const fake = makeFakeProcess()
    const { transport } = makeWireTransport(fake)
    await startReady(fake, transport)

    // First execution
    const exec1 = transport.execute("e1", "while True: pass")
    expect(fake.state.stdinLines.length).toBe(1)
    const op1 = JSON.parse(fake.state.stdinLines[0])
    expect(op1.id).toBe("e1")

    // Interrupt transport
    await transport.interrupt()
    expect(fake.state.signals).toContain("SIGINT")

    // Second execution dispatched immediately
    const exec2 = transport.execute("e2", "1 + 1")
    expect(fake.state.stdinLines.length).toBe(2)
    const op2 = JSON.parse(fake.state.stdinLines[1])
    expect(op2.id).toBe("e2")

    // Late done frame for e1 arrives
    fake.emitFrame({ type: "done", id: "e1", code: 1, stderr: "Interrupted" })
    for (let i = 0; i < 5; i++) await Promise.resolve()

    // Done frame for e2 arrives
    fake.emitFrame({ type: "done", id: "e2", code: 0, stdout: "", stderr: "", result: "2" })
    for (let i = 0; i < 5; i++) await Promise.resolve()

    const res2 = await exec2
    expect(res2.code).toBe(0)
    expect(res2.result).toBe("2")
  })

  test("POST-TRANS-5: bootstrap sends the bootstrap op and resolves only after the matching result frame", async () => {
    // Deterministically proves bootstrap() performs a real wire round-trip
    // rather than resolving synchronously as a no-op: a mutated
    // `async bootstrap(){ return }` would never write a "bootstrap" op to
    // stdin, and this test would fail on the first assertion below instead
    // of silently passing (the live-tier POST-TRANS-5 test cannot detect
    // this class of regression because the target venv already has every
    // package importable regardless of whether bootstrap() ran).
    const fake = makeFakeProcess()
    const { transport } = makeWireTransport(fake)
    await startReady(fake, transport)

    let resolved = false
    const pending = transport.bootstrap()
    pending.then(() => { resolved = true })
    pending.catch(() => undefined)

    await new Promise(r => setTimeout(r, 0))
    const sentOps = fake.state.stdinLines.map(line => JSON.parse(line) as { op: string; id: string })
    const bootstrapOp = sentOps.find(op => op.op === "bootstrap")
    expect(bootstrapOp).toBeDefined()
    expect(resolved).toBe(false)

    if (bootstrapOp === undefined) {
      throw new Error("bootstrap op was never sent over the wire")
    }
    fake.emitFrame({ type: "result", id: bootstrapOp.id })
    await pending
    expect(resolved).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// WIRE tier — contract validators (supporting, labeled)
// ---------------------------------------------------------------------------

describe("transport contract validators (supporting, not RED)", () => {
  test("TRANS-V1: config validation rejects incomplete configs", () => {
    expect(() => validateTransportConfig(null)).toThrow(ContractRlmTransportContractError)
    expect(() => validateTransportConfig({ ...CONFIG, interpreter: "  " })).toThrow(
      "TRANS-V1 violation: transport config requires interpreter, cwd, artifactsDir, and env",
    )
    expect(() => validateTransportConfig({ ...CONFIG, env: { "": "x" } })).toThrow(
      "TRANS-V1 violation: spawn env keys and values must be non-empty strings",
    )
    expect(validateTransportConfig(CONFIG)).toEqual(CONFIG)
  })

  test("TRANS-V2: frame vocabulary is exact and closed", () => {
    expect([...TRANS_OPS]).toEqual([
      "execute", "interrupt", "snapshot_names", "snapshot_write",
      "snapshot_restore", "bootstrap", "shutdown", "host_reply",
    ])
    expect([...TRANS_FRAMES]).toEqual([
      "ready", "started", "stdout", "stderr", "result", "error", "done", "host_request",
    ])
    expect(validateFrameType("ready")).toBe("ready")
    expect(validateFrameType("host_request")).toBe("host_request")
    expect(() => validateFrameType("bogus")).toThrow(ContractTransportProtocolError)
  })

  test("error message shapes align contract and implementation (dual-stack)", () => {
    // Contract-Implementation Independence: instanceof runs against the
    // IMPLEMENTATION classes (imported above); alignment to the contract
    // authority is asserted by message-shape equality.
    expect(new TransportSpawnError("boom").message).toBe(
      new ContractTransportSpawnError("boom").message,
    )
    expect(new TransportUnresponsiveError("tail").message).toBe(
      new ContractTransportUnresponsiveError("tail").message,
    )
    expect(new TransportProtocolError("bad frame").message).toBe(
      new ContractTransportProtocolError("bad frame").message,
    )
  })
})

// ---------------------------------------------------------------------------
// LIVE tier — real spawn through the SLICE-2 bootstrap
// ---------------------------------------------------------------------------

describe("transport live kernel (real spawn)", () => {
  let interpreter = ""
  let workRoot = ""

  beforeAll(async () => {
    workRoot = fs.mkdtempSync("/tmp/rlm-trans-test-")
    const venvDir = join(workRoot, "venv")
    const pythonDir = join(import.meta.dir, "..", "python")
    const runtimeSources: Record<string, string> = {}
    for (const f of fs.readdirSync(pythonDir)) {
      if (f.endsWith(".py")) runtimeSources[f] = fs.readFileSync(join(pythonDir, f), "utf8")
    }
    const result = await bootstrapManagedVenv(
      { venvDir, xdgDir: join(workRoot, "xdg") },
      {
        runner: {
          async run(cmd, args) {
            // cwd = neutral fresh dir: uv walks UP from cwd looking for a
            // pyproject.toml; an ancestor with requires-python != 3.11 would
            // reject the managed venv (real production hazard).
            const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe", cwd: workRoot })
            const [stdout, stderr, code] = await Promise.all([
              new Response(proc.stdout).text(),
              new Response(proc.stderr).text(),
              proc.exited,
            ])
            return { code, stdout, stderr }
          },
        },
        exists: p => fs.existsSync(p),
        readTextFile: p => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null),
        runtimeSources,
        skills: [],
      },
    )
    interpreter = result.interpreterPath
  }, 240_000)

  afterAll(async () => {
    // Recoverable cleanup: move the work root to the system trash rather than
    // permanently deleting it (no rm).
    if (workRoot !== "") {
      try {
        const hasTrash = Bun.which("trash") !== null
        if (hasTrash) {
          await Bun.spawn(["trash", workRoot], { stdout: "ignore", stderr: "ignore" }).exited
        } else {
          fs.rmSync(workRoot, { recursive: true, force: true })
        }
      } catch {}
    }
  }, 120_000)

  function liveConfig(artifactsDir: string) {
    const session: KernelSession = {
      sessionDir: join(workRoot, "session"),
      harnessDir: join(workRoot, "harness"),
      globalHarnessDir: join(workRoot, "global"),
      agentDir: join(workRoot, "agent"),
      depth: 0,
      maxDepth: 1,
    }
    const caps: KernelCaps = { maxOutputChars: 65536, snapshotMaxBytes: 256 * 1024 * 1024 }
    return {
      interpreter,
      env: buildKernelEnv(session, caps),
      cwd: workRoot,
      artifactsDir,
    }
  }

  test("POST-TRANS-1 live: the managed-venv runner becomes ready within the gate", async () => {
    // Risk tier: HIGH — SEQ-12 end-to-end: bootstrap interpreter -> spawn ->
    // readiness, the slice's real-kernel proof.
    const artifacts = join(workRoot, "art-ready")
    fs.mkdirSync(artifacts, { recursive: true })
    const transport = createTransport(liveConfig(artifacts))
    try {
      const started = Date.now()
      await transport.start()
      expect(Date.now() - started).toBeLessThan(TRANS_READY_TIMEOUT_MS + 15_000)
      expect(transport.alive()).toBe(true)
    } finally {
      await transport.dispose()
    }
  }, 60_000)

  test("POST-TRANS-2 live: cells execute with streams and error surfaces", async () => {
    const artifacts = join(workRoot, "art-exec")
    fs.mkdirSync(artifacts, { recursive: true })
    const transport = createTransport(liveConfig(artifacts))
    try {
      await transport.start()
      const ok = await transport.execute("e1", "print('hello rlm')")
      expect(ok.code).toBe(0)
      expect(ok.stdout).toContain("hello rlm")
      const bad = await transport.execute("e2", "raise ValueError('boom')")
      expect(bad.code).not.toBe(0)
      expect(bad.errorEname).toBe("ValueError")
      expect(bad.traceback ?? "").toContain("boom")
    } finally {
      await transport.dispose()
    }
  }, 60_000)

  test("POST-TRANS-3 live: interrupt aborts a running cell and the kernel stays usable", async () => {
    // Self-contained: creates its own artifacts dir, marker file, and
    // transport; tears down its own transport on every exit path so this
    // test cannot pollute state for tests that run after it.
    const artifacts = join(workRoot, "art-intr")
    fs.mkdirSync(artifacts, { recursive: true })
    const transport = createTransport(liveConfig(artifacts))
    const markerFile = join(artifacts, "started.marker")
    try {
      await transport.start()
      // The cell writes a marker file as its very first statement, before
      // sleeping. Polling for that marker is a deterministic signal that
      // the runner has actually entered cell execution (past the point
      // where an interrupt is attributable to THIS cell) — a fixed-delay
      // sleep() is a race against CI scheduling variance: on a loaded
      // runner the interrupt can arrive before the op is even dispatched,
      // in which case it is correctly (by design) absorbed as an idle
      // interrupt and the cell then runs to completion untouched.
      const sleeper = transport.execute(
        "e1",
        `open(${JSON.stringify(markerFile)}, "w").close()
import time
time.sleep(30)`,
      )
      sleeper.catch(() => undefined)

      const deadline = Date.now() + 10_000
      while (!fs.existsSync(markerFile)) {
        if (Date.now() > deadline) {
          throw new Error(`cell did not signal start via ${markerFile} within 10s`)
        }
        await Bun.sleep(10)
      }

      await transport.interrupt()
      const interrupted = await sleeper
      expect(interrupted.code).not.toBe(0)
      const next = await transport.execute("e2", "1 + 1")
      expect(next.code).toBe(0)
      expect(next.result).toContain("2")
    } finally {
      await transport.dispose()
      if (fs.existsSync(markerFile)) {
        // Best-effort marker cleanup: the whole workRoot is removed in
        // afterAll regardless, so a failure here must never fail the test.
        try {
          fs.rmSync(markerFile, { force: true })
        } catch {}
      }
    }
  }, 60_000)

  test("POST-TRANS-4 live: snapshot round-trips and a fresh process revives the namespace", async () => {
    // Risk tier: HIGH — the revival round-trip is the completion-promise
    // behavior at the transport level (F-170..F-183).
    const artifacts = join(workRoot, "art-snap")
    fs.mkdirSync(artifacts, { recursive: true })
    const first = createTransport(liveConfig(artifacts))
    // Same suite-safety guarantee as POST-SNAP-COMPRESS-1/RESTORE-1 live below:
    // two real kernel processes, both torn down on every exit path so an
    // assertion failure cannot leave a live runner poisoning later tests.
    let second: RlmTransport | null = null
    try {
      await first.start()
      await first.execute("e1", "x = 42\nimport math")
      const names = await first.snapshotNames()
      expect(names).toContain("x")
      const write = await first.writeSnapshot(names.filter(n => n === "x"), 256 * 1024 * 1024)
      expect(write.bytes).toBeGreaterThan(0)
      await first.dispose()

      second = createTransport(liveConfig(artifacts))
      await second.start()
      const restored = await second.restoreSnapshot()
      expect(restored).toContain("x")
      const probe = await second.execute("e1", "print(x)")
      expect(probe.stdout).toContain("42")
    } finally {
      try {
        await first.dispose()
      } finally {
        if (second !== null) {
          await second.dispose()
        }
      }
    }
  }, 120_000)

  test("POST-TRANS-5 live: the runtime bootstrap succeeds in the managed venv", async () => {
    // Risk tier: HIGH — the bootstrap cell is the runtime admission gate;
    // ipykernel, dill, and rlm (the rlm-runtime package's import name) must
    // import. The WIRE-tier test below proves bootstrap() genuinely performs
    // the op round-trip (would catch a no-op regression); this live test
    // proves the real runner's _bootstrap() succeeds against a real venv.
    const artifacts = join(workRoot, "art-boot")
    fs.mkdirSync(artifacts, { recursive: true })
    const transport = createTransport(liveConfig(artifacts))
    try {
      await transport.start()
      await transport.bootstrap()
      const probe = await transport.execute("e1", "import ipykernel, dill, rlm; print('bootstrap_ok')")
      expect(probe.code).toBe(0)
      expect(probe.stdout).toContain("bootstrap_ok")
    } finally {
      await transport.dispose()
    }
  }, 60_000)

  test("POST-SNAP-COMPRESS-1/POST-SNAP-RESTORE-1 live: transparent stream compression round-trips with verified magic header and manifest", async () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Authority: requirements/contracts/rlm-dill-compression.contract.ts
     * - Enforces: POST-SNAP-COMPRESS-1, POST-SNAP-RESTORE-1, POST-SNAP-MANIFEST-1, SEQ-3, SEQ-4, IP-2, IP-3, IP-4, IP-5
     * - Category: Live transport stream compression round-trip
     */
    const artifacts = join(workRoot, "art-dill-compress")
    fs.mkdirSync(artifacts, { recursive: true })
    const config = liveConfig(artifacts)
    config.env.RLM_SNAPSHOT_COMPRESSION = "lzma"
    const first = createTransport(config)
    // Two real kernel processes are spawned across this test (first, then a
    // fresh second on revival). Both are protected by try/finally so ANY
    // assertion failure before their explicit dispose() calls still tears
    // them down — an un-guarded live process left running after a failed
    // assertion can poison every test that runs after it in the suite.
    let second: RlmTransport | null = null
    try {
      await first.start()

      // Populate large numerical array state in first session
      await first.execute("e1", "import numpy as np; arr = np.arange(250000).reshape(500, 500); label = 'verified_compression'")
      const names = await first.snapshotNames()
      expect(names).toContain("arr")
      expect(names).toContain("label")

      // Write compressed snapshot
      const writeResult = await first.writeSnapshot(names, 256 * 1024 * 1024)
      expect(writeResult.bytes).toBeGreaterThan(0)
      expect(writeResult.compression).toBe("lzma")
      // Narrow via explicit guard rather than a non-null assertion: compressedBytes
      // is optional on KernelSnapshotWriteResult, and a live LZMA write must always
      // populate it — failing loudly here documents that invariant instead of
      // silencing the checker with `!`.
      if (writeResult.compressedBytes === undefined) {
        throw new Error("writeResult.compressedBytes must be defined for a live lzma write")
      }
      expect(writeResult.uncompressedBytes).toBeGreaterThan(writeResult.compressedBytes)
      expect(writeResult.compressionRatio).toBeGreaterThanOrEqual(50.0)
      expect(writeResult.compressionDurationMs).toBeGreaterThan(0.0)

      // Inspect on-disk binary snapshot file header
      const snapshotFile = join(artifacts, "kernel-state.dill")
      expect(fs.existsSync(snapshotFile)).toBe(true)
      const fileBytes = fs.readFileSync(snapshotFile)

      // Assert LZMA magic byte header: 0xFD 0x37 0x7A 0x58 0x5A 0x00
      expect(fileBytes[0]).toBe(0xfd)
      expect(fileBytes[1]).toBe(0x37)
      expect(fileBytes[2]).toBe(0x7a)
      expect(fileBytes[3]).toBe(0x58)
      expect(fileBytes[4]).toBe(0x5a)
      expect(fileBytes[5]).toBe(0x00)

      // Inspect manifest JSON
      const manifestFile = join(artifacts, "kernel-state.json")
      expect(fs.existsSync(manifestFile)).toBe(true)
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf-8"))
      expect(manifest.compression).toBe("lzma")
      expect(manifest.uncompressedBytes).toBeGreaterThan(manifest.compressedBytes)
      expect(manifest.compressionRatio).toBeGreaterThanOrEqual(50.0)

      // Revive in fresh transport process
      const secondConfig = liveConfig(artifacts)
      secondConfig.env.RLM_SNAPSHOT_COMPRESSION = "lzma"
      second = createTransport(secondConfig)
      await second.start()
      const restored = await second.restoreSnapshot()
      expect(restored).toContain("arr")
      expect(restored).toContain("label")

      const probe = await second.execute("e2", "print(f'{label}:{arr[10, 10]}')")
      expect(probe.stdout).toContain("verified_compression:5010")
    } finally {
      try {
        await first.dispose()
      } finally {
        if (second !== null) {
          await second.dispose()
        }
      }
    }
  }, 120_000)

})
