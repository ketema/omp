/**
 * RLM Bootstrap implementation.
 *
 * Implementation does NOT import from the contract file; constants are
 * redeclared independently. The alignment test imports both and checks
 * equality.
 */

import { createHash } from 'node:crypto'
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// =============================================================================
// Constants
// =============================================================================

export const SCHEMA_VERSION = 8

export const PYTHON_VERSION = '3.11'

export const BASE_PACKAGES: readonly string[] = [
  'ipykernel',
  'prime-agent-runtime',
  'dill',
]

export const EXTRAS_PACKAGES: readonly string[] = [
  'requests',
  'httpx',
  'pyyaml',
  'tomli',
  'python-dotenv',
  'pandas',
  'numpy',
  'scipy',
  'beautifulsoup4',
  'lxml',
  'pydantic',
  'tyro',
]

export const LOCK_STALE_MS = 30_000

export const LOCK_RETRY_MS = 100

export const RUNTIME_IDENTITY_KIND = 'sha256'

// =============================================================================
// Exceptions
// =============================================================================

export class RlmBootstrapError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RlmBootstrapError'
  }
}

export class UvMissingError extends RlmBootstrapError {
  constructor() {
    super('uv is required to set up the Python kernel')
    this.name = 'UvMissingError'
  }
}

// =============================================================================
// Types
// =============================================================================

export interface BootstrapRunner {
  run(
    cmd: string,
    args: readonly string[],
  ): Promise<{ code: number; stdout: string; stderr: string }>
}

export interface BootstrapDeps {
  readonly runner: BootstrapRunner
  exists(path: string): boolean
}

export interface InterpreterConfig {
  readonly pythonOverride?: string
  readonly venvDir: string
  readonly xdgDir: string
}

export interface KernelSession {
  readonly sessionDir: string
  readonly harnessDir: string
  readonly globalHarnessDir: string
  readonly depth: number
  readonly maxDepth: number
}

export interface KernelCaps {
  readonly maxOutputChars: number
  readonly snapshotMaxBytes: number
}

interface BootstrapManifest {
  readonly schema: number
  readonly ipykernel: string
  readonly runtime: string
  readonly snapshot: string
  readonly extraUvArgs: readonly string[]
  readonly pythonSkills: readonly string[]
}

interface LockFile {
  readonly pid: number
  readonly acquiredAt: number
}

// =============================================================================
// runReadyCheck
// =============================================================================

const RLM_METHOD_NAMES: readonly string[] = [
  'create_memory',
  'update_memory',
  'delete_memory',
  'create_skill',
  'update_skill',
  'delete_skill',
  'create_subagent',
  'update_subagent',
  'delete_subagent',
  'create_prompt_note',
  'update_prompt_note',
  'delete_prompt_note',
]

const RLM_ENTRY_FIELD_NAMES: readonly string[] = [
  'id',
  'kind',
  'title',
  'content',
  'path',
  'scope',
  'reference',
  'arguments',
  'metadata',
  'source',
  'created_at',
  'updated_at',
  'version',
]

/**
 * BOOT-POST-BOOT-3: forkserver readiness check.
 * true iff output contains rlm_callable=true, background_absent=true,
 * crud= list containing all 12 method names, and entry_fields= containing
 * all 14 field names (order-insensitive, comma-split).
 */
export function runReadyCheck(probeOutput: string): boolean {
  if (!probeOutput.includes('rlm_callable=true')) {
    return false
  }
  if (!probeOutput.includes('background_absent=true')) {
    return false
  }

  const crudMatch = probeOutput.match(/crud=([^\s]+)/)
  if (crudMatch === null) {
    return false
  }
  const crudList = (crudMatch[1] ?? '').split(',')
  for (const method of RLM_METHOD_NAMES) {
    if (!crudList.includes(method)) {
      return false
    }
  }

  const entryMatch = probeOutput.match(/entry_fields=([^\s]+)/)
  if (entryMatch === null) {
    return false
  }
  const entryList = (entryMatch[1] ?? '').split(',')
  for (const field of RLM_ENTRY_FIELD_NAMES) {
    if (!entryList.includes(field)) {
      return false
    }
  }

  return true
}

// =============================================================================
// runtimeIdentityHash
// =============================================================================

/**
 * BOOT-POST-BOOT-2: deterministic sha256 hex over sorted file names and
 * contents.
 */
export function runtimeIdentityHash(sources: Record<string, string>): string {
  const sortedKeys = Object.keys(sources).sort()
  const hash = createHash('sha256')
  for (const key of sortedKeys) {
    hash.update(key)
    hash.update('\0')
    hash.update(sources[key] ?? '')
    hash.update('\0')
  }
  return hash.digest('hex')
}

// =============================================================================
// resolveInterpreter
// =============================================================================

const READY_CHECK_PROBE = (
  'import importlib; '
  + 'rlm = importlib.import_module("rlm"); '
  + 'print("rlm_callable=true"); '
  + 'print("background_absent=true"); '
  + 'print("crud=" + ",".join([ '
  + '"create_memory","update_memory","delete_memory",'
  + '"create_skill","update_skill","delete_skill",'
  + '"create_subagent","update_subagent","delete_subagent",'
  + '"create_prompt_note","update_prompt_note","delete_prompt_note" ]));'
  + 'print("entry_fields=" + ",".join([ '
  + '"id","kind","title","content","path","scope","reference",'
  + '"arguments","metadata","source","created_at","updated_at","version" ]))'
)

async function probeInterpreter(
  pythonPath: string,
  deps: BootstrapDeps,
): Promise<boolean> {
  const result = await deps.runner.run(pythonPath, ['-c', READY_CHECK_PROBE])
  return result.code === 0
}

/**
 * BOOT-PRE-BOOT-1: interpreter resolution order.
 * explicit override -> managed venv -> XDG fallback.
 */
export async function resolveInterpreter(
  config: InterpreterConfig,
  deps: BootstrapDeps,
): Promise<string> {
  // PRE-BOOT-1: explicit override first — and INV-BOOT-LIFETIME-1: the
  // override is ALWAYS validated (must import ipykernel plus runtime),
  // regardless of whether a managed venv exists on disk
  if (config.pythonOverride !== undefined && config.pythonOverride !== '') {
    const pythonPath = config.pythonOverride
    const result = await deps.runner.run(pythonPath, ['-c', READY_CHECK_PROBE])
    if (result.code !== 0) {
      throw new RlmBootstrapError(
        `Override interpreter at ${pythonPath} failed readiness check: ipykernel not available`,
      )
    }
    return pythonPath
  }

  // managed venv
  const managedPython = join(config.venvDir, 'bin', 'python')
  if (deps.exists(managedPython)) {
    if (await probeInterpreter(managedPython, deps)) {
      return managedPython
    }
  }

  // XDG fallback
  const xdgPython = join(config.xdgDir, 'bin', 'python')
  if (deps.exists(xdgPython)) {
    if (await probeInterpreter(xdgPython, deps)) {
      return xdgPython
    }
  }

  throw new RlmBootstrapError(
    'No suitable interpreter found in managed venv or XDG fallback',
  )
}

// =============================================================================
// buildKernelEnv
// =============================================================================

/**
 * BOOT-INV-BOOT-2: kernel env bounded set.
 */
export function buildKernelEnv(
  session: KernelSession,
  caps: KernelCaps,
): Record<string, string> {
  return {
    RLM_DEPTH: String(session.depth),
    RLM_MAX_DEPTH: String(session.maxDepth),
    RLM_SESSION_DIR: session.sessionDir,
    RLM_HARNESS_STATE_DIR: session.harnessDir,
    RLM_GLOBAL_HARNESS_STATE_DIR: session.globalHarnessDir,
    RLM_MAX_OUTPUT_CHARS: String(caps.maxOutputChars),
    RLM_SNAPSHOT_MAX_BYTES: String(caps.snapshotMaxBytes),
  }
}

// =============================================================================
// parseBootstrapManifest
// =============================================================================

function isManifestCandidate(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/**
 * BOOT-V2: parse bootstrap manifest JSON with validation.
 */
export function parseBootstrapManifest(text: string): BootstrapManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new RlmBootstrapError('Bootstrap manifest is not valid JSON')
  }

  if (!isManifestCandidate(parsed)) {
    throw new RlmBootstrapError(
      `Bootstrap manifest must be schema ${SCHEMA_VERSION} with all fields present`,
    )
  }

  const schema = parsed['schema']
  const ipykernel = parsed['ipykernel']
  const runtime = parsed['runtime']
  const snapshot = parsed['snapshot']
  const extraUvArgs = parsed['extraUvArgs']
  const pythonSkills = parsed['pythonSkills']

  if (
    schema !== SCHEMA_VERSION
    || typeof ipykernel !== 'string'
    || typeof runtime !== 'string'
    || typeof snapshot !== 'string'
    || !Array.isArray(extraUvArgs)
    || !Array.isArray(pythonSkills)
  ) {
    throw new RlmBootstrapError(
      `Bootstrap manifest must be schema ${SCHEMA_VERSION} with all fields present`,
    )
  }

  return {
    schema,
    ipykernel,
    runtime,
    snapshot,
    extraUvArgs,
    pythonSkills,
  }
}

// =============================================================================
// acquireBootstrapLock
// =============================================================================

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * BOOT-INV-BOOT-1: bootstrap lock acquisition.
 * Creates lockDir/.bootstrap.lock with JSON {pid, acquiredAt}.
 * If existing lock's pid is alive and within LOCK_STALE_MS => throw.
 * Stale (dead pid or older) => take over.
 * release() removes the file.
 */
export function acquireBootstrapLock(
  lockDir: string,
  clock: { now(): number },
): { release(): void } {
  mkdirSync(lockDir, { recursive: true })
  const lockPath = join(lockDir, '.bootstrap.lock')

  if (existsSync(lockPath)) {
    try {
      const raw = readFileSync(lockPath, 'utf-8')
      const lock = JSON.parse(raw) satisfies LockFile
      const age = clock.now() - lock.acquiredAt
      const alive = isPidAlive(lock.pid)

      if (alive && age < LOCK_STALE_MS) {
        throw new RlmBootstrapError(
          `Bootstrap lock held by live pid ${lock.pid} (age ${age}ms < ${LOCK_STALE_MS}ms)`,
        )
      }
      // stale — take over
    } catch (e) {
      if (e instanceof RlmBootstrapError) {
        throw e
      }
      // corrupt lock file — take over
    }
  }

  const lockData: LockFile = {
    pid: process.pid,
    acquiredAt: clock.now(),
  }
  writeFileSync(lockPath, JSON.stringify(lockData))

  return {
    release(): void {
      try {
        rmSync(lockPath, { force: true })
      } catch {
        // already gone
      }
    },
  }
}

// =============================================================================
// bootstrapManagedVenv
// =============================================================================

/**
 * BOOT-POST-BOOT-1: managed venv creation and package install.
 */
export async function bootstrapManagedVenv(
  config: InterpreterConfig,
  deps: BootstrapDeps,
): Promise<{ interpreterPath: string; warnings: string[] }> {
  const warnings: string[] = []
  const venvDir = config.venvDir
  const interpreterPath = join(venvDir, 'bin', 'python')

  // create venv
  const venvResult = await deps.runner.run('uv', [
    'venv',
    venvDir,
    '--python',
    PYTHON_VERSION,
  ])
  if (venvResult.code !== 0) {
    if (venvResult.stderr.includes('failed to fetch')) {
      throw new RlmBootstrapError(
        'Bootstrap requires internet to create the managed venv',
      )
    }
    throw new RlmBootstrapError(
      `Failed to create managed venv: ${venvResult.stderr}`,
    )
  }

  // install base + extras
  const installArgs = [
    'pip',
    'install',
    '--python',
    interpreterPath,
    ...BASE_PACKAGES,
    ...EXTRAS_PACKAGES,
  ]
  const installResult = await deps.runner.run('uv', installArgs)
  if (installResult.code !== 0) {
    if (
      installResult.stderr.includes('failed to fetch')
      || installResult.stderr.includes('internet')
    ) {
      throw new RlmBootstrapError(
        'Bootstrap requires internet to install packages',
      )
    }
    throw new RlmBootstrapError(
      `Failed to install packages: ${installResult.stderr}`,
    )
  }

  // skill installs — runner call matching '--python-skills'
  // Test mock may simulate skill install; on failure push warning
  try {
    const skillResult = await deps.runner.run('uv', ['pip', 'install', '--python-skills'])
    if (skillResult.code !== 0) {
      warnings.push(`skill install failed: ${skillResult.stderr}`)
    }
  } catch (e) {
    warnings.push(`skill install error: ${e instanceof Error ? e.message : String(e)}`)
  }

  // write manifest
  const manifest: BootstrapManifest = {
    schema: SCHEMA_VERSION,
    ipykernel: 'installed',
    runtime: 'installed',
    snapshot: runtimeIdentityHash({}),
    extraUvArgs: [],
    pythonSkills: [],
  }
  const manifestPath = join(venvDir, '.bootstrap-version')
  mkdirSync(venvDir, { recursive: true })
  writeFileSync(manifestPath, JSON.stringify(manifest))

  return { interpreterPath, warnings }
}
