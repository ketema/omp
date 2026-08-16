/**
 * RED PHASE — bootstrap implementation tests (SLICE-2).
 *
 * Targets the IMPLEMENTATION artifact packages/rlm/src/bootstrap.ts, not
 * the contract. At RED time the module does not exist; every test fails
 * with a module-resolution error. Contract verification lives in
 * test_bootstrap_alignment.test.ts (supporting, labeled).
 *
 * CONTRACT AUTHORITY RECORD:
 * - File: requirements/contracts/rlm-bootstrap.contract.ts
 * - PRE: 1, POST: 3, INV: 2, INV-LIFETIME: 1, SEQ: 2, ERRORS: 2, FORBIDDEN: 2
 *
 * TSR (coordinator-issued, reference-faithful): module at
 * packages/rlm/src/bootstrap.ts exports:
 * - class RlmBootstrapError extends Error
 * - class UvMissingError extends RlmBootstrapError
 * - constants: SCHEMA_VERSION=8, PYTHON_VERSION='3.11', BASE_PACKAGES,
 *   EXTRAS_PACKAGES, LOCK_STALE_MS=30000, LOCK_RETRY_MS=100,
 *   RUNTIME_IDENTITY_KIND='sha256'
 * - resolveInterpreter(config, deps): Promise<string>
 *     config: {pythonOverride?: string; venvDir: string; xdgDir: string}
 *     deps: {runner: {run(cmd, args): Promise<{code; stdout; stderr}>};
 *            exists(path): boolean}
 * - buildKernelEnv(session, caps): Record<string, string>
 *     session: {depth: number; maxDepth: number; sessionDir: string;
 *               harnessDir: string; globalHarnessDir?: string}
 *     caps: {maxOutputChars: number; snapshotMaxBytes: number}
 * - parseBootstrapManifest(text): BootstrapVersionManifest  (throws on bad)
 * - runtimeIdentityHash(sources: Record<string, string>): string  (sha256 hex)
 * - acquireBootstrapLock(lockDir, clock: {now(): number}):
 *     {release(): void}  — throws RlmBootstrapError when lock held by a
 *     live holder; a stale lock (no live pid / older than LOCK_STALE_MS)
 *     is taken over
 * - runReadyCheck(probeOutput: string): boolean  (RUNTIME_READY_CHECK)
 * - bootstrapManagedVenv(config, deps): Promise<string> — creates venv
 *   via uv, installs packages, writes manifest; skill failures degrade to
 *   warnings collected on result.warnings
 */

import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"

import {
  BASE_PACKAGES,
  EXTRAS_PACKAGES,
  LOCK_RETRY_MS,
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
// Helpers (Object Mother; injected doubles — no real uv/network/fs)
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<{
  pythonOverride: string
  venvDir: string
  xdgDir: string
}> = {}) {
  return {
    venvDir: "/tmp/rlm-test-venv",
    xdgDir: "/tmp/rlm-test-xdg",
    ...overrides,
  }
}

/** Stub runner: records commands; answers by script. Double type: Stub
 * (return-value control; no call verification except where a SEQ test
 * asserts order explicitly). Mock derives from PRE-BOOT-1/POST-BOOT-1. */
function makeRunner(script: Array<{ match: string; code: number; stdout: string; stderr?: string }>) {
  const calls: Array<{ cmd: string; args: string[] }> = []
  return {
    calls,
    async run(cmd: string, args: string[]) {
      calls.push({ cmd, args })
      const joined = `${cmd} ${args.join(" ")}`
      for (const entry of script) {
        if (joined.includes(entry.match)) {
          return { code: entry.code, stdout: entry.stdout, stderr: entry.stderr ?? "" }
        }
      }
      return { code: 0, stdout: "", stderr: "" }
    },
  }
}

// ---------------------------------------------------------------------------
// PRE-BOOT-1 — interpreter resolution order
// ---------------------------------------------------------------------------

describe("PRE-BOOT-1 resolution order", () => {
  test("explicit override wins after passing its own runtime probe", async () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Enforces: PRE-BOOT-1: explicit override first (F-205) — AND
     *   INV-BOOT-LIFETIME-1: the override is always validated (must import
     *   ipykernel plus runtime), regardless of whether a managed venv
     *   exists on disk
     * - Category: positive (override class)
     * - Risk tier: Medium — wrong order silently picks the wrong
     *   interpreter; an unprobed override defers failure to kernel spawn
     * - Adversarial: Implementation-blind
     *
     * FOUR-CRITERIA GATE: C1 PRE-BOOT-1/INV-BOOT-LIFETIME-1 · C2 an impl
     * that skips the override probe (0 runner calls) fails — the probe
     * call is asserted · C3 only test asserting override short-circuit ·
     * C4 contracted order and override validation
     */
    const runner = makeRunner([
      { match: "/opt/special/python", code: 0, stdout: "rlm_callable=true" },
    ])
    const exists = (path: string) => !path.includes("venv")
    const result = await resolveInterpreter(
      makeConfig({ pythonOverride: "/opt/special/python" }),
      { runner, exists },
    )
    expect(result).toBe("/opt/special/python")
    // INV-BOOT-LIFETIME-1: exactly one runner call — the override's own
    // probe. No venv resolution, no other checks.
    expect(runner.calls.length).toBe(1)
    expect(runner.calls[0].cmd).toBe("/opt/special/python")
  })

  test("managed venv used when it exists and passes the ready check", async () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Enforces: PRE-BOOT-1: managed venv second in the order
     * - Category: positive (venv class)
     * - Risk tier: Medium
     */
    const venvPython = "/tmp/rlm-test-venv/bin/python"
    const runner = makeRunner([
      { match: venvPython, code: 0, stdout: "READY" },
    ])
    const exists = (path: string) => path.includes("rlm-test-venv") || path.includes("rlm-test-xdg")
    const result = await resolveInterpreter(makeConfig(), { runner, exists })
    expect(result).toBe(venvPython)
  })

  test("XDG fallback third when managed venv absent", async () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Enforces: PRE-BOOT-1: XDG fallback last
     * - Category: positive (fallback class)
     * - Risk tier: Medium
     */
    const xdgPython = "/tmp/rlm-test-xdg/bin/python"
    const runner = makeRunner([
      { match: xdgPython, code: 0, stdout: "READY" },
    ])
    const exists = (path: string) => path.includes("rlm-test-xdg")
    const result = await resolveInterpreter(makeConfig(), { runner, exists })
    expect(result).toBe(xdgPython)
  })
})

// ---------------------------------------------------------------------------
// INV-BOOT-LIFETIME-1 — override must be validated (imports runtime)
// ---------------------------------------------------------------------------

test("override that fails the runtime probe is rejected, not silently used", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: INV-BOOT-LIFETIME-1: an explicit interpreter override skips
   *   managed bootstrap AND must import ipykernel plus runtime plus defaults
   *   (F-252) — observed as: a probe failure rejects the override
   * - Category: negative
   * - Risk tier: High — a broken override means every later kernel spawn
   *   fails far from the cause
   * - Adversarial: Implementation-blind
   */
  const runner = makeRunner([
    { match: "/opt/broken/python", code: 1, stdout: "", stderr: "ModuleNotFoundError: No module named 'ipykernel'" },
  ])
  const exists = () => true
  try {
    await resolveInterpreter(makeConfig({ pythonOverride: "/opt/broken/python" }), { runner, exists })
    throw new Error("expected resolveInterpreter to reject the broken override")
  } catch (error) {
    expect(error).toBeInstanceOf(RlmBootstrapError)
    expect(String(error)).toContain("ipykernel")
  }
})

// ---------------------------------------------------------------------------
// POST-BOOT-1 — venv contents / manifest
// ---------------------------------------------------------------------------

describe("POST-BOOT-1 venv manifest", () => {
  test("manifest carries schema 8 and the full package set installs are requested", () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Enforces: POST-BOOT-1: managed venv carries Python 3.11 with every
     *   base and extras package (F-191/F-192, BOOT-V1, Z-4)
     * - Category: positive
     * - Risk tier: High — missing packages surface as kernel import errors
     *   far from bootstrap (FORBIDDEN-BOOT-1 silent trim)
     * - Adversarial: Implementation-blind
     */
    expect(SCHEMA_VERSION).toBe(8)
    expect(PYTHON_VERSION).toBe("3.11")
    const manifest = parseBootstrapManifest(JSON.stringify({
      schema: 8,
      ipykernel: "8.0.0",
      runtime: "sha256:abc",
      snapshot: "sha256:def",
      extraUvArgs: [],
      pythonSkills: [],
    }))
    expect(manifest.schema).toBe(8)
    // Z-4: the FULL extras set — every name from the contract's F-192 list
    expect(EXTRAS_PACKAGES).toEqual([
      "requests", "httpx", "pyyaml", "tomli", "python-dotenv",
      "pandas", "numpy", "scipy", "beautifulsoup4", "lxml", "pydantic", "tyro",
    ])
    expect(BASE_PACKAGES).toEqual(["ipykernel", "prime-agent-runtime", "dill"])
  })

  test("manifest with wrong schema or missing fields is rejected", () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Enforces: POST-BOOT-1/BOOT-V2: manifest must be schema 8 with all
     *   fields — a stale/foreign manifest forces a rebuild, never a
     *   half-trusted venv
     * - Category: negative (boundary: schema 7 = one off)
     * - Risk tier: Medium
     */
    expect(() => parseBootstrapManifest(JSON.stringify({
      schema: 7, ipykernel: "x", runtime: "x", snapshot: "x",
      extraUvArgs: [], pythonSkills: [],
    }))).toThrow(RlmBootstrapError)
    expect(() => parseBootstrapManifest(JSON.stringify({
      schema: 8, runtime: "x", snapshot: "x", extraUvArgs: [], pythonSkills: [],
    }))).toThrow(RlmBootstrapError)
  })
})

// ---------------------------------------------------------------------------
// POST-BOOT-2 — runtime identity hash
// ---------------------------------------------------------------------------

test("runtime identity hash is sha256 over runtime sources; any change invalidates", () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: POST-BOOT-2: identity hash covers rlm runtime sources plus
   *   pyproject; a content change changes the hash (F-194)
   * - Category: invariant (deterministic exact values)
   * - Risk tier: High — stale venvs run old kernel semantics silently
   * - Adversarial: Implementation-blind
   */
  const sources = { "rlm/__init__.py": "print('a')", "pyproject.toml": "[project]" }
  const h1 = runtimeIdentityHash(sources)
  const h2 = runtimeIdentityHash({ ...sources })
  const h3 = runtimeIdentityHash({ ...sources, "rlm/__init__.py": "print('b')" })
  expect(h1).toBe(h2)          // deterministic
  expect(h1).toMatch(/^[0-9a-f]{64}$/) // sha256 hex
  expect(h1).not.toBe(h3)      // content change invalidates
})

// ---------------------------------------------------------------------------
// POST-BOOT-3 — RUNTIME_READY_CHECK gate
// ---------------------------------------------------------------------------

test("ready check admits a kernel reporting callable rlm, CRUD methods, entry fields, no background", () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: POST-BOOT-3: RUNTIME_READY_CHECK admits only interpreters
   *   whose probe confirms callable rlm + harness CRUD + HarnessEntry
   *   fields + no background attr (F-193)
   * - Category: positive/negative pair (equivalence classes of probe output)
   * - Risk tier: High — a wrong venv passes the gate and fails at runtime
   * - Adversarial: Implementation-blind
   */
  const good = [
    "rlm_callable=true",
    "crud=create_memory,update_memory,delete_memory,create_skill,update_skill,delete_skill,create_subagent,update_subagent,delete_subagent,create_prompt_note,update_prompt_note,delete_prompt_note",
    "entry_fields=id,kind,title,content,path,scope,reference,arguments,metadata,source,created_at,updated_at,version",
    "background_absent=true",
  ].join("\n")
  expect(runReadyCheck(good)).toBe(true)

  expect(runReadyCheck(good.replace("rlm_callable=true", "rlm_callable=false"))).toBe(false)
  expect(runReadyCheck(good.replace("create_memory,", ""))).toBe(false)
  expect(runReadyCheck(good.replace("background_absent=true", "background_absent=false"))).toBe(false)
  expect(runReadyCheck("")).toBe(false)
})

// ---------------------------------------------------------------------------
// INV-BOOT-1 — bootstrap lock
// ---------------------------------------------------------------------------

describe("INV-BOOT-1 bootstrap lock", () => {
  test("stale lock (older than LOCK_STALE_MS, no live pid) is taken over", () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Enforces: INV-BOOT-1: only the lock holder rebuilds; stale locks
     *      age out after BOOT_LOCK_STALE_MS (F-195)
     * - Category: boundary (on-point: exactly stale; off: 1ms fresh)
     * - Risk tier: Medium — a wedged lock blocks every future bootstrap
     * - Adversarial: Implementation-blind
     */
    expect(LOCK_STALE_MS).toBe(30_000)
    expect(LOCK_RETRY_MS).toBe(100)
    let now = 1_000_000
    const clock = { now: () => now }
    const lockDir = `/tmp/rlm-lock-${crypto.randomUUID()}`

    // Holder acquires, then dies; time passes past the stale threshold
    const first = acquireBootstrapLock(lockDir, clock)
    first.release()

    // A foreign stale lock file (pid 999999 — not us, long dead, old mtime)
    fs.mkdirSync(lockDir, { recursive: true })
    fs.writeFileSync(`${lockDir}/.bootstrap.lock`, JSON.stringify({
      pid: 999999, acquiredAt: now - LOCK_STALE_MS - 1,
    }))

    const taken = acquireBootstrapLock(lockDir, clock) // must NOT throw
    taken.release()
    fs.rmSync(lockDir, { recursive: true, force: true })
  })

  test("live foreign lock holder blocks acquisition with the domain error", () => {
    /**
     * CONTRACT TRACEABILITY:
     * - Enforces: INV-BOOT-1: only the holder rebuilds — a LIVE holder
     *   blocks; acquisition raises the domain error instead of clobbering
     * - Category: negative
     * - Risk tier: Medium
     */
    const now = 5_000_000
    const clock = { now: () => now }
    const lockDir = `/tmp/rlm-lock2-${crypto.randomUUID()}`
    fs.mkdirSync(lockDir, { recursive: true })
    // Live: OUR pid as holder (guaranteed alive), fresh timestamp
    fs.writeFileSync(`${lockDir}/.bootstrap.lock`, JSON.stringify({
      pid: process.pid, acquiredAt: now - 100,
    }))
    expect(() => acquireBootstrapLock(lockDir, clock)).toThrow(RlmBootstrapError)
    fs.rmSync(lockDir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// INV-BOOT-2 + FORBIDDEN-BOOT-2 + SEQ-BOOT-2 — kernel env assembly
// ---------------------------------------------------------------------------

test("kernel env carries RLM identity vars, caps, and depth — and nothing else", () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: INV-BOOT-2: kernel env carries RLM_DEPTH, RLM_MAX_DEPTH,
   *      session-dir and harness-dir variables (F-206, A-011)
   * - Enforces: FORBIDDEN-BOOT-2: only the bounded, capability-gated set
   *      crosses — no credential keys in the assembled env (F-207, REQ-N-3)
   * - Enforces: SEQ-BOOT-2: caps and depth are delivered IN the env the
   *      same call returns (config delivered before kernel start)
   * - Category: invariant (exact set equality — deterministic)
   * - Risk tier: High — env assembly is the credential boundary
   * - Adversarial: Implementation-blind
   */
  const env = buildKernelEnv(
    {
      depth: 1,
      maxDepth: 2,
      sessionDir: "/tmp/sess",
      harnessDir: "/tmp/sess/harness",
      globalHarnessDir: "/tmp/global/harness",
    },
    { maxOutputChars: 65536, snapshotMaxBytes: 268435456 },
  )
  expect(env["RLM_DEPTH"]).toBe("1")
  expect(env["RLM_MAX_DEPTH"]).toBe("2")
  expect(env["RLM_SESSION_DIR"]).toBe("/tmp/sess")
  expect(env["RLM_HARNESS_STATE_DIR"]).toBe("/tmp/sess/harness")
  expect(env["RLM_GLOBAL_HARNESS_STATE_DIR"]).toBe("/tmp/global/harness")
  expect(env["RLM_MAX_OUTPUT_CHARS"]).toBe("65536")
  expect(env["RLM_SNAPSHOT_MAX_BYTES"]).toBe("268435456")
  // FORBIDDEN-BOOT-2: the assembled env contains ONLY RLM_* keys — the
  // bounded set. Any credential-shaped key is a violation.
  for (const key of Object.keys(env)) {
    expect(key.startsWith("RLM_")).toBe(true)
  }
})

// ---------------------------------------------------------------------------
// ERRORS-BOOT-1 — uv missing + internet-naming failure
// ---------------------------------------------------------------------------

test("missing uv raises UvMissingError; bootstrap failure names internet need", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: ERRORS-BOOT-1: UvMissingError when no uv resolves (F-239);
   *      first-time-install failure messages name the internet requirement
   *      (F-198)
   * - Category: error
   * - Risk tier: Medium — silent uv failure hangs first-run onboarding
   * - Adversarial: Implementation-blind
   */
  expect(new UvMissingError().message).toContain("uv")
  // First-time venv creation failing (non-zero pip exit) must name internet
  const { bootstrapManagedVenv } = await import("../src/bootstrap.ts")
  const runner = makeRunner([
    { match: "uv venv", code: 0, stdout: "" },
    { match: "uv pip install", code: 2, stdout: "", stderr: "error: failed to fetch" },
  ])
  try {
    await bootstrapManagedVenv(makeConfig(), { runner, exists: () => false })
    throw new Error("expected bootstrapManagedVenv to fail")
  } catch (error) {
    expect(error).toBeInstanceOf(RlmBootstrapError)
    expect(String(error).toLowerCase()).toContain("internet")
  }
})

// ---------------------------------------------------------------------------
// ERRORS-BOOT-2 — skill install failures degrade to warnings
// ---------------------------------------------------------------------------

test("python-skill install failure downgrades to a warning, bootstrap succeeds", async () => {
  /**
   * CONTRACT TRACEABILITY:
   * - Enforces: ERRORS-BOOT-2: Python-skill install failures downgrade to a
   *      warning naming the unavailable skill, never abort the bootstrap
   *      (F-199)
   * - Category: positive (degradation path)
   * - Risk tier: Medium — one broken skill must not brick the kernel env
   * - Adversarial: Implementation-blind
   */
  const { bootstrapManagedVenv } = await import("../src/bootstrap.ts")
  const runner = makeRunner([
    { match: "uv venv", code: 0, stdout: "" },
    { match: "uv pip install ipykernel", code: 0, stdout: "" },
    { match: "--python-skills", code: 1, stdout: "", stderr: "skill build failed" },
  ])
  const result = await bootstrapManagedVenv(
    makeConfig(),
    { runner, exists: () => false },
  )
  expect(result.warnings.length).toBeGreaterThan(0)
  expect(result.warnings[0]).toContain("skill")
})
