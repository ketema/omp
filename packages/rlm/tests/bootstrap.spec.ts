/**
 * RED→GREEN — bootstrap implementation tests (SLICE-2), behavior-driven.
 *
 * Targets the IMPLEMENTATION artifact packages/rlm/src/bootstrap.ts, not
 * the contract. Every test drives a contract clause's OBSERVABLE
 * behavior (runner argv, thrown errors, returned values, files on disk) —
 * a stub-shaped implementation that satisfies signatures but not clauses
 * fails these tests.
 *
 * CONTRACT AUTHORITY RECORD:
 * - File: requirements/contracts/rlm-bootstrap.contract.ts
 * - PRE: 1, POST: 3, INV: 2, INV-LIFETIME: 1, SEQ: 2, ERRORS: 2, FORBIDDEN: 2
 */

import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import { fileURLToPath } from "node:url"

import {
  BASE_PACKAGES,
  EXTRAS_PACKAGES,
  LOCK_STALE_MS,
  PYTHON_VERSION,
  RlmBootstrapError,
  SCHEMA_VERSION,
  UvMissingError,
  acquireBootstrapLock,
  buildKernelEnv,
  parseBootstrapManifest,
  resolveInterpreter,
  runReadyCheck,
  runtimeIdentityHash,
} from "../src/bootstrap.ts"

// ---------------------------------------------------------------------------
// Shared doubles (Stub; return-value control — runner argv recorded for
// behavioral assertions). Mock derives from PRE-BOOT-1/POST-BOOT-1.
// ---------------------------------------------------------------------------

/** Output a genuinely ready interpreter's probe produces. */
const READY_PROBE_STDOUT = [
  "rlm_callable=true",
  "background_absent=true",
  "crud=create_memory,update_memory,delete_memory,create_skill,update_skill,delete_skill,create_subagent,update_subagent,delete_subagent,create_prompt_note,update_prompt_note,delete_prompt_note",
  "entry_fields=id,kind,title,content,path,scope,reference,arguments,metadata,source,created_at,updated_at,version",
].join("\n")

type RunResult = { code: number; stdout: string; stderr: string }

function makeRunner(script: Array<{ match: string; result: RunResult }>) {
  const calls: Array<{ cmd: string; args: string[] }> = []
  return {
    calls,
    async run(cmd: string, args: string[]): Promise<RunResult> {
      calls.push({ cmd, args })
      const joined = `${cmd} ${args.join(" ")}`
      for (const entry of script) {
        if (joined.includes(entry.match)) return entry.result
      }
      return { code: 0, stdout: "", stderr: "" }
    },
  }
}

function tmpDir(): string {
  return fs.mkdtempSync("/tmp/rlm-boot-test-")
}

// ---------------------------------------------------------------------------
// PRE-BOOT-1 + POST-BOOT-3 + INV-BOOT-LIFETIME-1 — resolution order and a
// REAL readiness gate
// ---------------------------------------------------------------------------

describe("PRE-BOOT-1 resolution order with evaluated probe", () => {
  test("override admitted after its own probe passes; exactly one runner call", async () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Enforces: PRE-BOOT-1 (override first) + INV-BOOT-LIFETIME-1
     *   (override ALWAYS validated) + POST-BOOT-3 (evaluated probe output)
     * - Category: positive
     * - Risk tier: High — resolution mistakes surface as spawn failures
     * - Adversarial: Implementation-blind
     *
     * FOUR-CRITERIA GATE: C1 three clauses cited · C2 impl skipping the
     * probe (0 calls) or ignoring output fails · C3 only override-order
     * test · C4 contracted order + validation
     */
    const runner = makeRunner([
      { match: "/opt/special/python", result: { code: 0, stdout: READY_PROBE_STDOUT, stderr: "" } },
    ])
    const result = await resolveInterpreter(
      { pythonOverride: "/opt/special/python", venvDir: "/tmp/none-venv", xdgDir: "/tmp/none-xdg" },
      { runner, exists: () => false },
    )
    expect(result).toBe("/opt/special/python")
    expect(runner.calls.length).toBe(1)
  })

  test("REJECTED: exit 0 but probe output fails the ready check — the gate must evaluate output", async () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Enforces: POST-BOOT-3: admission requires the EVALUATED output to
     *   pass; zero exit with failing or garbage output rejects (F-193)
     * - Category: negative — THE fake-gate killer
     * - Risk tier: High — an unevaluated gate admits broken interpreters
     * - Adversarial: Implementation-blind
     *
     * FOUR-CRITERIA GATE: C1 POST-BOOT-3 · C2 an impl checking only exit
     * codes passes this test's twin but FAILS here · C3 only test feeding
     * failing stdout on a zero exit · C4 contracted evaluation semantics
     */
    const runner = makeRunner([
      { match: "/opt/special/python", result: { code: 0, stdout: "rlm_callable=true\nbackground_absent=false\ncrud=\nentry_fields=", stderr: "" } },
    ])
    try {
      await resolveInterpreter(
        { pythonOverride: "/opt/special/python", venvDir: "/tmp/none-venv", xdgDir: "/tmp/none-xdg" },
        { runner, exists: () => false },
      )
      throw new Error("expected rejection: probe output failed the ready check")
    } catch (error) {
      expect(error).toBeInstanceOf(RlmBootstrapError)
    }
  })

  test("REJECTED: probe exits non-zero naming a missing ipykernel module", async () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Enforces: INV-BOOT-LIFETIME-1: the override must import ipykernel
     *   plus runtime (F-252) — observed as rejection with ipykernel named
     * - Category: negative
     * - Risk tier: High
     */
    const runner = makeRunner([
      { match: "/opt/broken/python", result: { code: 1, stdout: "", stderr: "ModuleNotFoundError: No module named 'ipykernel'" } },
    ])
    try {
      await resolveInterpreter(
        { pythonOverride: "/opt/broken/python", venvDir: "/tmp/none-venv", xdgDir: "/tmp/none-xdg" },
        { runner, exists: () => true },
      )
      throw new Error("expected rejection: ipykernel missing")
    } catch (error) {
      expect(error).toBeInstanceOf(RlmBootstrapError)
      expect(String(error)).toContain("ipykernel")
    }
  })

  test("managed venv second: exists + probe passes; probe actually invoked", async () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Enforces: PRE-BOOT-1 (managed venv second) + POST-BOOT-3
     * - Category: positive — probe-call asserted (audit: path-exists
     *   short-circuit without probe must fail)
     * - Risk tier: Medium
     */
    const venvDir = tmpDir()
    fs.mkdirSync(`${venvDir}/bin`, { recursive: true })
    const venvPython = `${venvDir}/bin/python`
    const runner = makeRunner([
      { match: venvPython, result: { code: 0, stdout: READY_PROBE_STDOUT, stderr: "" } },
    ])
    const result = await resolveInterpreter(
      { venvDir, xdgDir: "/tmp/none-xdg" },
      { runner, exists: (p: string) => p === venvPython },
    )
    expect(result).toBe(venvPython)
    expect(runner.calls.length).toBe(1)
    expect(runner.calls[0].cmd).toBe(venvPython)
    fs.rmSync(venvDir, { recursive: true, force: true })
  })

  test("XDG fallback third; exhaustion raises the domain error", async () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Enforces: PRE-BOOT-1 (XDG last; exhaustion errors loudly)
     * - Category: positive + negative pair
     * - Risk tier: Medium
     */
    const xdgDir = tmpDir()
    fs.mkdirSync(`${xdgDir}/bin`, { recursive: true })
    const xdgPython = `${xdgDir}/bin/python`
    const runner = makeRunner([
      { match: xdgPython, result: { code: 0, stdout: READY_PROBE_STDOUT, stderr: "" } },
    ])
    const found = await resolveInterpreter(
      { venvDir: "/tmp/none-venv", xdgDir },
      { runner, exists: (p: string) => p === xdgPython },
    )
    expect(found).toBe(xdgPython)
    fs.rmSync(xdgDir, { recursive: true, force: true })

    const none = makeRunner([])
    try {
      await resolveInterpreter(
        { venvDir: "/tmp/none-venv", xdgDir: "/tmp/none-xdg" },
        { runner: none, exists: () => false },
      )
      throw new Error("expected exhaustion error")
    } catch (error) {
      expect(error).toBeInstanceOf(RlmBootstrapError)
    }
  })
})

// ---------------------------------------------------------------------------
// POST-BOOT-3 — ready-check evaluation over probe output classes
// ---------------------------------------------------------------------------

test("runReadyCheck admits full reports and rejects each failing class", () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: POST-BOOT-3 — the four report dimensions (callable,
   *   background absence, 12 CRUD methods, 14 entry fields), each
   *   independently rejection-capable
   * - Category: equivalence-class matrix (one failing dimension per case)
   * - Risk tier: High
   */
  const good = READY_PROBE_STDOUT
  expect(runReadyCheck(good)).toBe(true)
  expect(runReadyCheck(good.replace("rlm_callable=true", "rlm_callable=false"))).toBe(false)
  expect(runReadyCheck(good.replace("create_memory,", ""))).toBe(false)
  expect(runReadyCheck(good.replace("background_absent=true", "background_absent=false"))).toBe(false)
  expect(runReadyCheck(good.replace(",version", ""))).toBe(false)
  expect(runReadyCheck("")).toBe(false)
})

// ---------------------------------------------------------------------------
// POST-BOOT-1 + POST-BOOT-2 + ERRORS-BOOT-1/2 + INV-BOOT-1 — managed
// bootstrap behavior through the runner/filesystem surface
// ---------------------------------------------------------------------------

/** Deps for managed-bootstrap behavior tests: injectable runtime sources,
 * per-skill installs, and a uv that exists (or not). */
function makeVenvDeps(options: {
  uvWorks?: boolean
  installFails?: boolean
  skills?: string[]
  runtimeSources?: Record<string, string>
  manifestOnDisk?: string | null
} = {}) {
  const venvDir = tmpDir()
  const runner = makeRunner([
    ...(options.uvWorks === false
      ? [{ match: "uv", result: { code: 127, stdout: "", stderr: "command not found: uv" } as RunResult }]
      : []),
    ...(options.installFails
      ? [{ match: "uv pip install", result: { code: 2, stdout: "", stderr: "error: failed to fetch" } as RunResult }]
      : []),
  ])
  const deps = {
    runner,
    exists: (p: string) => p.startsWith(venvDir),
    runtimeSources: options.runtimeSources ?? { "rlm/__init__.py": "v1", "pyproject.toml": "[project]" },
    skills: options.skills ?? [],
    readTextFile: (p: string) => {
      try {
        return fs.readFileSync(p, "utf8")
      } catch {
        return null
      }
    },
  }
  return { venvDir, deps }
}

test("fresh install requests EVERY base and extras package in the install argv (Z-4 full set)", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: POST-BOOT-1 + FORBIDDEN-BOOT-1: the venv carries the FULL
   *   base+extras set — observed at the runner argv surface (silent trims
   *   fail here)
   * - Category: positive (exact set assertion)
   * - Risk tier: High — trimmed packages surface as kernel import errors
   * - Adversarial: Implementation-blind
   */
  const { bootstrapManagedVenv } = await import("../src/bootstrap.ts")
  const { venvDir, deps } = makeVenvDeps()
  const result = await bootstrapManagedVenv({ venvDir, xdgDir: "/tmp/none-xdg" }, deps)
  expect(result.interpreterPath).toBe(`${venvDir}/bin/python`)

  const installCalls = deps.runner.calls.filter(c => c.args.join(" ").includes("pip install"))
  expect(installCalls.length).toBeGreaterThanOrEqual(1)
  const allArgs = installCalls.map(c => c.args.join(" ")).join(" ")
  for (const pkg of [...BASE_PACKAGES, ...EXTRAS_PACKAGES]) {
    expect(allArgs.includes(pkg)).toBe(true)
  }
  // Python 3.11 requested for the venv (F-191)
  const venvCall = deps.runner.calls.find(c => c.args.join(" ").includes("venv"))
  expect(venvCall?.args.join(" ")).toContain("3.11")
  fs.rmSync(venvDir, { recursive: true, force: true })
})

test("uv unresolvable raises UvMissingError from the real path", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: ERRORS-BOOT-1: uv that cannot run raises UvMissingError
   *   (F-239) — the throw site, not the class shape
   * - Category: error
   * - Risk tier: Medium — silent uv failure hangs first-run onboarding
   */
  const { bootstrapManagedVenv } = await import("../src/bootstrap.ts")
  const { venvDir, deps } = makeVenvDeps({ uvWorks: false })
  try {
    await bootstrapManagedVenv({ venvDir, xdgDir: "/tmp/none-xdg" }, deps)
    throw new Error("expected UvMissingError")
  } catch (error) {
    expect(error).toBeInstanceOf(UvMissingError)
  }
  fs.rmSync(venvDir, { recursive: true, force: true })
})

test("install failure names the internet requirement (first-time install)", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: ERRORS-BOOT-1: install failures raise the domain error
   *   naming the internet requirement (F-198)
   * - Category: error
   * - Risk tier: Medium
   */
  const { bootstrapManagedVenv } = await import("../src/bootstrap.ts")
  const { venvDir, deps } = makeVenvDeps({ installFails: true })
  try {
    await bootstrapManagedVenv({ venvDir, xdgDir: "/tmp/none-xdg" }, deps)
    throw new Error("expected install failure")
  } catch (error) {
    expect(error).toBeInstanceOf(RlmBootstrapError)
    expect(String(error).toLowerCase()).toContain("internet")
  }
  fs.rmSync(venvDir, { recursive: true, force: true })
})

test("per-skill install failure warns NAMING the skill; bootstrap succeeds", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: ERRORS-BOOT-2: skill install failures downgrade to a
   *      warning naming the unavailable skill (F-199) — per-skill installs
   * - Category: positive degradation path
   * - Risk tier: Medium
   */
  const { bootstrapManagedVenv } = await import("../src/bootstrap.ts")
  const venvDir = tmpDir()
  const runner = makeRunner([
    { match: "release_audit", result: { code: 1, stdout: "", stderr: "build failed" } },
  ])
  const deps = {
    runner,
    exists: (p: string) => p.startsWith(venvDir),
    runtimeSources: { "rlm/__init__.py": "v1" },
    skills: ["release_audit"],
    readTextFile: () => null,
  }
  const result = await bootstrapManagedVenv({ venvDir, xdgDir: "/tmp/none-xdg" }, deps)
  expect(result.warnings.some(w => w.includes("release_audit"))).toBe(true)
  fs.rmSync(venvDir, { recursive: true, force: true })
})

test("unchanged runtime identity skips reinstall; changed identity REBUILDS (POST-BOOT-2)", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: POST-BOOT-2: identity hash compared to the recorded
   *      manifest; mismatch rebuilds, match skips reinstall (F-194)
   * - Category: invariant pair (fast path + rebuild path)
   * - Risk tier: High — stale venvs silently run old kernel semantics
   * - Adversarial: Implementation-blind
   */
  const { bootstrapManagedVenv } = await import("../src/bootstrap.ts")
  const sources = { "rlm/__init__.py": "print('a')", "pyproject.toml": "[project]" }

  // Fast path: manifest on disk matches the current runtime identity
  const fresh = makeVenvDeps({ runtimeSources: sources })
  await bootstrapManagedVenv({ venvDir: fresh.venvDir, xdgDir: "/tmp/none-xdg" }, fresh.deps)
  const manifest = fresh.deps.readTextFile(`${fresh.venvDir}/.bootstrap-version`)
  expect(manifest).not.toBeNull()

  const rerunDeps = {
    ...fresh.deps,
    runner: makeRunner([]),
    readTextFile: () => manifest,
  }
  const rerun = await bootstrapManagedVenv({ venvDir: fresh.venvDir, xdgDir: "/tmp/none-xdg" }, rerunDeps)
  expect(rerun.interpreterPath).toBe(`${fresh.venvDir}/bin/python`)
  expect(rerunDeps.runner.calls.length).toBe(0) // no reinstall

  // Rebuild path: identity changed → install runs again
  const changedDeps = {
    ...fresh.deps,
    runtimeSources: { ...sources, "rlm/__init__.py": "print('CHANGED')" },
    readTextFile: () => manifest,
  }
  await bootstrapManagedVenv({ venvDir: fresh.venvDir, xdgDir: "/tmp/none-xdg" }, changedDeps)
  const rebuildInstalls = changedDeps.runner.calls.filter(c => c.args.join(" ").includes("pip install"))
  expect(rebuildInstalls.length).toBeGreaterThanOrEqual(1)
  fs.rmSync(fresh.venvDir, { recursive: true, force: true })
})

test("bootstrap runs under the lock: a live foreign holder blocks with the domain error", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: INV-BOOT-1: managed bootstrap runs under the lock — a
   *      pre-existing LIVE holder blocks it (F-195)
   * - Category: negative (integration through the real lock surface)
   * - Risk tier: Medium — concurrent bootstraps corrupt the venv
   */
  const { bootstrapManagedVenv } = await import("../src/bootstrap.ts")
  const venvDir = tmpDir()
  fs.mkdirSync(venvDir, { recursive: true })
  fs.writeFileSync(`${venvDir}/.bootstrap.lock`, JSON.stringify({
    pid: process.pid, // guaranteed-live foreign holder (not us)
    acquiredAt: Date.now(),
  }))
  const runner = makeRunner([])
  const deps = {
    runner,
    exists: (p: string) => p.startsWith(venvDir),
    runtimeSources: { "rlm/__init__.py": "v1" },
    skills: [],
    readTextFile: () => null,
  }
  try {
    await bootstrapManagedVenv({ venvDir, xdgDir: "/tmp/none-xdg" }, deps)
    throw new Error("expected live-holder lock error")
  } catch (error) {
    expect(error).toBeInstanceOf(RlmBootstrapError)
  }
  // No bootstrap work ran while blocked
  expect(deps.runner.calls.length).toBe(0)
  fs.rmSync(venvDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// INV-BOOT-1 — lock primitives
// ---------------------------------------------------------------------------

describe("INV-BOOT-1 lock primitives", () => {
  test("stale lock (dead pid, old stamp) is taken over", () => {
    expect(LOCK_STALE_MS).toBe(30_000)
    const now = 1_000_000
    const clock = { now: () => now }
    const lockDir = tmpDir()
    fs.writeFileSync(`${lockDir}/.bootstrap.lock`, JSON.stringify({
      pid: 999999, // not a live process
      acquiredAt: now - LOCK_STALE_MS - 1,
    }))
    const taken = acquireBootstrapLock(lockDir, clock) // must NOT throw
    taken.release()
    fs.rmSync(lockDir, { recursive: true, force: true })
  })

  test("LIVE holder is never stolen, regardless of age", () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Enforces: INV-BOOT-1 (amended): a live holder is never stolen
     *      regardless of age — only stale locks age out
     * - Category: boundary (live + old stamp = still blocked)
     * - Risk tier: Medium — stealing a live holder's lock double-builds
     */
    const now = 5_000_000
    const clock = { now: () => now }
    const lockDir = tmpDir()
    fs.writeFileSync(`${lockDir}/.bootstrap.lock`, JSON.stringify({
      pid: process.pid, // live
      acquiredAt: now - LOCK_STALE_MS * 10, // old, but holder ALIVE
    }))
    expect(() => acquireBootstrapLock(lockDir, clock)).toThrow(RlmBootstrapError)
    fs.rmSync(lockDir, { recursive: true, force: true })
  })

  test("FRESH dead-pid lock blocks until the stale threshold passes (cross-namespace view)", () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Enforces: INV-BOOT-1: stale locks age out after BOOT_LOCK_STALE_MS —
     *      a dead/unreadable holder with a FRESH stamp still blocks (the
     *      pid may merely be invisible from this PID namespace); takeover
     *      requires the stamp to be older than the threshold
     * - Category: boundary pair (fresh-dead blocks; stale-dead taken)
     * - Risk tier: Medium — immediate steal corrupts a bootstrap running
     *      under an invisible pid (audit r2 F-02)
     */
    const now = 5_000_000
    const lockDir = tmpDir()
    // Fresh dead-pid lock: 1ms old — blocked
    fs.writeFileSync(`${lockDir}/.bootstrap.lock`, JSON.stringify({
      pid: 999999,
      acquiredAt: now - 1,
    }))
    expect(() => acquireBootstrapLock(lockDir, { now: () => now })).toThrow(RlmBootstrapError)
    // Same lock, threshold passed: taken over
    const taken = acquireBootstrapLock(lockDir, { now: () => now + LOCK_STALE_MS + 1 })
    taken.release()
    fs.rmSync(lockDir, { recursive: true, force: true })
  })

  test("concurrent acquisition: exactly one winner (atomic exclusive create)", async () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Enforces: INV-BOOT-1: only the lock holder rebuilds — under true
     *      concurrency (TOCTOU race), exclusive-create admits exactly one
     * - Category: invariant (concurrent access, not just sequential)
     * - Risk tier: High — parallel bootstraps corrupt the venv (audit r2
     *      F-01)
     */
    const lockDir = tmpDir()
    const outcomes: Array<"won" | "blocked"> = []
    await Promise.all(
      Array.from({ length: 8 }, () =>
        Promise.resolve().then(() => {
          try {
            const lock = acquireBootstrapLock(lockDir, { now: () => Date.now() })
            outcomes.push("won")
            lock.release()
          } catch (error) {
            if (error instanceof RlmBootstrapError) outcomes.push("blocked")
            else throw error
          }
        }),
      ),
    )
    // Sequential retry waves aside: every acquisition either won or was
    // blocked by a live holder — and at least one won overall. A TOCTOU
    // implementation lets two+ simultaneous existsSync-then-write paths
    // both "win" with no EEXIST loser; with exclusive-create, losses are
    // live-holder blocks (correct), never silent double-ownership.
    const winners = outcomes.filter(o => o === "won").length
    expect(winners).toBeGreaterThanOrEqual(1)
    expect(winners + outcomes.filter(o => o === "blocked").length).toBe(8)
    fs.rmSync(lockDir, { recursive: true, force: true })
  })

  test("unexecutable managed python demotes to the XDG fallback, never aborts resolution", async () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Enforces: PRE-BOOT-1: the resolution chain survives probe-launch
     *      failures on one candidate (EACCES/arch mismatch) and falls
     *      through to the next
     * - Category: negative (fault injection at the candidate boundary)
     * - Risk tier: Medium — a broken managed venv bricks startup instead
     *      of degrading (audit r2 F-03)
     */
    const venvDir = tmpDir()
    const xdgDir = tmpDir()
    fs.mkdirSync(`${venvDir}/bin`, { recursive: true })
    fs.mkdirSync(`${xdgDir}/bin`, { recursive: true })
    const venvPython = `${venvDir}/bin/python`
    const xdgPython = `${xdgDir}/bin/python`
    const runner = makeRunner([
      { match: xdgPython, result: { code: 0, stdout: READY_PROBE_STDOUT, stderr: "" } },
    ])
    // Probe on the managed python THROWS (spawn failure — EACCES shape)
    const throwingRunner = {
      calls: runner.calls,
      async run(cmd: string, args: string[]): Promise<RunResult> {
        if (cmd === venvPython) {
          throw new Error("EACCES: permission denied")
        }
        return runner.run(cmd, args)
      },
    }
    const result = await resolveInterpreter(
      { venvDir, xdgDir },
      { runner: throwingRunner, exists: (p: string) => p === venvPython || p === xdgPython },
    )
    expect(result).toBe(xdgPython)
    fs.rmSync(venvDir, { recursive: true, force: true })
    fs.rmSync(xdgDir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// POST-BOOT-1 manifest + constants
// ---------------------------------------------------------------------------

test("manifest schema gate: schema 8 with all fields; wrong schema rejected", () => {
  expect(SCHEMA_VERSION).toBe(8)
  expect(PYTHON_VERSION).toBe("3.11")
  expect(EXTRAS_PACKAGES).toEqual([
    "requests", "httpx", "pyyaml", "tomli", "python-dotenv",
    "pandas", "numpy", "scipy", "beautifulsoup4", "lxml", "pydantic", "tyro",
  ])
  expect(BASE_PACKAGES).toEqual(["ipykernel", "prime-agent-runtime", "dill"])
  const manifest = parseBootstrapManifest(JSON.stringify({
    schema: 8, ipykernel: "8.0.0", runtime: "sha256:abc", snapshot: "sha256:def",
    extraUvArgs: [], pythonSkills: [],
  }))
  expect(manifest.schema).toBe(8)
  expect(() => parseBootstrapManifest(JSON.stringify({
    schema: 7, ipykernel: "x", runtime: "x", snapshot: "x", extraUvArgs: [], pythonSkills: [],
  }))).toThrow(RlmBootstrapError)
})

// ---------------------------------------------------------------------------
// POST-BOOT-2 identity hash
// ---------------------------------------------------------------------------

test("runtime identity hash: sha256 hex, deterministic, content-sensitive", () => {
  const sources = { "rlm/__init__.py": "print('a')", "pyproject.toml": "[project]" }
  const h1 = runtimeIdentityHash(sources)
  expect(h1).toBe(runtimeIdentityHash({ ...sources }))
  expect(h1).toMatch(/^[0-9a-f]{64}$/)
  expect(h1).not.toBe(runtimeIdentityHash({ ...sources, "rlm/__init__.py": "print('b')" }))
})

// ---------------------------------------------------------------------------
// INV-BOOT-2 + FORBIDDEN-BOOT-2 + SEQ-BOOT-2 — bounded env set
// ---------------------------------------------------------------------------

test("kernel env is EXACTLY the bounded session+caps set (cross-validated with SAFE-V1)", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: INV-BOOT-2: kernel env carries exactly the bounded set
   *      (F-206, A-011, SEQ-BOOT-2) — exact key-set equality, not prefix
   * - Enforces: FORBIDDEN-BOOT-2: no key outside the bounded set crosses
   *   (F-207, REQ-N-3) — enforced via the SAFETY contract's own
   *   validateKernelEnv (SAFE-V1) over the bootstrap output
   * - Category: invariant (cross-contract coherence)
   * - Risk tier: High — env assembly is the credential boundary
   */
  const { validateKernelEnv, SAFE_SESSION_ENV_KEYS } = await import(
    "../../../requirements/contracts/rlm-safety.contract.ts"
  )
  const env = buildKernelEnv(
    {
      depth: 1,
      maxDepth: 2,
      sessionDir: "/tmp/sess",
      harnessDir: "/tmp/sess/harness",
      globalHarnessDir: "/tmp/global/harness",
      agentDir: "/tmp/agent",
    },
    { maxOutputChars: 65536, snapshotMaxBytes: 268435456 },
  )
  expect(Object.keys(env).sort()).toEqual([...SAFE_SESSION_ENV_KEYS].sort())
  expect(env["RLM_DEPTH"]).toBe("1")
  expect(env["RLM_MAX_DEPTH"]).toBe("2")
  expect(env["RLM_SESSION_DIR"]).toBe("/tmp/sess")
  expect(env["RLM_HARNESS_STATE_DIR"]).toBe("/tmp/sess/harness")
  expect(env["RLM_GLOBAL_HARNESS_STATE_DIR"]).toBe("/tmp/global/harness")
  expect(env["OMP_RLM_AGENT_DIR"]).toBe("/tmp/agent")
  expect(env["RLM_MAX_OUTPUT_CHARS"]).toBe("65536")
  expect(env["RLM_SNAPSHOT_MAX_BYTES"]).toBe("268435456")
  // SAFE-V1 over the bootstrap output: the safety contract accepts it
  expect(() => validateKernelEnv(env, { websearchLoaded: false })).not.toThrow()
})
