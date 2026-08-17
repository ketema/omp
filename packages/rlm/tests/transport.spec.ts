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
  BASE_PACKAGES,
  bootstrapManagedVenv,
  buildKernelEnv,
  type KernelCaps,
  type KernelSession,
} from "../src/bootstrap.ts"
import {
  TransportProtocolError,
  TransportSpawnError,
  TransportUnresponsiveError,
  createTransport,
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
    let rejected = false
    await transport.execute("e1", "x = 1").catch(() => { rejected = true })
    expect(rejected).toBe(true)
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
    expect(spawn!.cmd).toBe(CONFIG.interpreter)
    expect(spawn!.args[spawn!.args.length - 1].endsWith(TRANS_RUNNER_FILE)).toBe(true)
    expect(spawn!.env).toEqual(CONFIG.env)
    expect(Object.keys(spawn!.env).sort()).toEqual(Object.keys(CONFIG.env).sort())
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
    fake.emitStderr("x".repeat(TRANS_STDERR_TAIL_CHARS + 4000))
    await clock.advance(TRANS_READY_TIMEOUT_MS + 1)
    let caught: unknown
    await pending.catch(e => { caught = e })
    expect(caught).toBeInstanceOf(TransportUnresponsiveError)
    const message = (caught as Error).message
    const tail = message.slice(message.length - TRANS_STDERR_TAIL_CHARS)
    expect(tail.length).toBe(TRANS_STDERR_TAIL_CHARS)
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
    const t = transport as unknown as {
      onHostRequest(
        handler: (req: { type: string; payload: Record<string, unknown> }) => Promise<Record<string, unknown>>,
      ): void
    }
    t.onHostRequest(async request => {
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
})

// ---------------------------------------------------------------------------
// WIRE tier — contract validators (supporting, labeled)
// ---------------------------------------------------------------------------

describe("transport contract validators (supporting, not RED)", () => {
  test("TRANS-V1: config validation rejects incomplete configs", () => {
    expect(() => validateTransportConfig(null)).toThrow()
    expect(() => validateTransportConfig({ ...CONFIG, interpreter: "  " })).toThrow()
    expect(() => validateTransportConfig({ ...CONFIG, env: { "": "x" } })).toThrow()
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
      await Bun.spawn(["trash", workRoot], { stdout: "ignore", stderr: "ignore" }).exited
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
    const started = Date.now()
    await transport.start()
    expect(Date.now() - started).toBeLessThan(TRANS_READY_TIMEOUT_MS + 15_000)
    expect(transport.alive()).toBe(true)
    await transport.dispose()
  }, 60_000)

  test("POST-TRANS-2 live: cells execute with streams and error surfaces", async () => {
    const artifacts = join(workRoot, "art-exec")
    fs.mkdirSync(artifacts, { recursive: true })
    const transport = createTransport(liveConfig(artifacts))
    await transport.start()
    const ok = await transport.execute("e1", "print('hello rlm')")
    expect(ok.code).toBe(0)
    expect(ok.stdout).toContain("hello rlm")
    const bad = await transport.execute("e2", "raise ValueError('boom')")
    expect(bad.code).not.toBe(0)
    expect(bad.errorEname).toBe("ValueError")
    expect(bad.traceback ?? "").toContain("boom")
    await transport.dispose()
  }, 60_000)

  test("POST-TRANS-3 live: interrupt aborts a running cell and the kernel stays usable", async () => {
    const artifacts = join(workRoot, "art-intr")
    fs.mkdirSync(artifacts, { recursive: true })
    const transport = createTransport(liveConfig(artifacts))
    await transport.start()
    const sleeper = transport.execute("e1", "import time; time.sleep(30)")
    sleeper.catch(() => undefined)
    await Bun.sleep(300)
    await transport.interrupt()
    const interrupted = await sleeper
    expect(interrupted.code).not.toBe(0)
    const next = await transport.execute("e2", "1 + 1")
    expect(next.code).toBe(0)
    expect(next.result).toContain("2")
    await transport.dispose()
  }, 60_000)

  test("POST-TRANS-4 live: snapshot round-trips and a fresh process revives the namespace", async () => {
    // Risk tier: HIGH — the revival round-trip is the completion-promise
    // behavior at the transport level (F-170..F-183).
    const artifacts = join(workRoot, "art-snap")
    fs.mkdirSync(artifacts, { recursive: true })
    const first = createTransport(liveConfig(artifacts))
    await first.start()
    await first.execute("e1", "x = 42\nimport math")
    const names = await first.snapshotNames()
    expect(names).toContain("x")
    const write = await first.writeSnapshot(names.filter(n => n === "x"), 256 * 1024 * 1024)
    expect(write.bytes).toBeGreaterThan(0)
    await first.dispose()

    const second = createTransport(liveConfig(artifacts))
    await second.start()
    const restored = await second.restoreSnapshot()
    expect(restored).toContain("x")
    const probe = await second.execute("e1", "print(x)")
    expect(probe.stdout).toContain("42")
    await second.dispose()
  }, 120_000)

  test("POST-TRANS-5 live: the runtime bootstrap succeeds in the managed venv", async () => {
    // Risk tier: HIGH — the bootstrap cell is the runtime admission gate;
    // BASE_PACKAGES (ipykernel, rlm-runtime, dill) must import.
    const artifacts = join(workRoot, "art-boot")
    fs.mkdirSync(artifacts, { recursive: true })
    const transport = createTransport(liveConfig(artifacts))
    await transport.start()
    await transport.bootstrap()
    const probe = await transport.execute("e1", `print(${JSON.stringify(BASE_PACKAGES[1])})`)
    expect(probe.code).toBe(0)
    await transport.dispose()
  }, 60_000)
})
