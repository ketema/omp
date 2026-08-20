/**
 * RLM Bootstrap Contract — specification authority.
 *
 * WHAT environment bootstrap guarantees (resolution order, venv contents,
 * runtime identity, locking, forkserver scope), NOT how uv is invoked.
 *
 * The implementation does NOT import from this file; tests import both.
 *
 * Traceability: REQ-RLM-0012, REQ-RLM-0014, REQ-N-3; F-001, F-190..F-208,
 * F-239, F-252; Z-2/Z-4 decisions; IP-1, IP-8; SEQ-1, SEQ-11; A-005, A-011.
 */

// =============================================================================
// Artifact 1: Constants
// =============================================================================

/** F-190: bootstrap manifest schema version. */
export const BOOT_SCHEMA_VERSION = 8
/** F-191: required Python version. */
export const BOOT_PYTHON_VERSION = '3.11'
/** F-192: base packages, exact names. The runtime shim is omp's own
 * rlm-runtime (bundled in-repo); the port does not depend on any
 * prime-agent package (user directive 2026-08-17). */
export const BOOT_BASE_PACKAGES: readonly string[] = [
  'ipykernel', 'rlm-runtime', 'dill',
] as const
/** F-192: extras set, exact names — the FULL set per user decision Z-4. */
export const BOOT_EXTRAS_PACKAGES: readonly string[] = [
  'requests', 'httpx', 'pyyaml', 'tomli', 'python-dotenv',
  'pandas', 'numpy', 'scipy', 'beautifulsoup4', 'lxml', 'pydantic', 'tyro',
] as const
/** F-195: stale-lock threshold when no live pid holds it. */
export const BOOT_LOCK_STALE_MS = 30_000
/** F-195: lock retry cadence. */
export const BOOT_LOCK_RETRY_MS = 100
/** F-204: forkserver readiness budget. */
export const BOOT_FORK_READY_TIMEOUT_MS = 30_000
/** F-204: forkserver spawn budget. */
export const BOOT_FORK_SPAWN_TIMEOUT_MS = 10_000
/** F-194: runtime identity invalidates the venv on content change. */
export const BOOT_RUNTIME_IDENTITY_KIND = 'sha256'

// =============================================================================
// Artifact 2: Exceptions
// =============================================================================

export class RlmBootstrapContractError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RlmBootstrapContractError'
  }
}

/** F-239: uv missing. */
export class UvMissingError extends RlmBootstrapContractError {
  constructor() {
    super('uv is required to set up the Python kernel')
    this.name = 'UvMissingError'
  }
}

// =============================================================================
// Artifact 3: Structural types
// =============================================================================

/** F-190: on-disk bootstrap manifest. */
export interface BootstrapVersionManifest {
  readonly schema: number
  readonly ipykernel: string
  readonly runtime: string
  readonly snapshot: string
  readonly extraUvArgs: readonly string[]
  readonly pythonSkills: readonly string[]
}

// =============================================================================
// Artifact 4: Validators
// =============================================================================

/**
 * BOOT-V1: package set completeness. The venv manifest must carry every
 * base and extras package name (F-192, Z-4 "keep all venv extras").
 */
export function validatePackageSet(installed: readonly string[]): readonly string[] {
  const have = new Set(installed)
  const missing = [...BOOT_BASE_PACKAGES, ...BOOT_EXTRAS_PACKAGES].filter(p => !have.has(p))
  if (missing.length > 0) {
    throw new RlmBootstrapContractError(
      `BOOT-V1 violation: venv is missing required packages: ${missing.sort().join(', ')}`,
    )
  }
  return installed
}

/**
 * BOOT-V2: bootstrap manifest schema (F-190).
 */
export function validateBootstrapManifest(candidate: unknown): BootstrapVersionManifest {
  const m = candidate as Partial<BootstrapVersionManifest> | null
  if (
    m === null || typeof m !== 'object' || m.schema !== BOOT_SCHEMA_VERSION
    || typeof m.ipykernel !== 'string' || typeof m.runtime !== 'string'
    || typeof m.snapshot !== 'string' || !Array.isArray(m.extraUvArgs)
    || !Array.isArray(m.pythonSkills)
  ) {
    throw new RlmBootstrapContractError(
      `BOOT-V2 violation: bootstrap manifest must be schema ${BOOT_SCHEMA_VERSION} with all fields`,
    )
  }
  return m as BootstrapVersionManifest
}

/**
 * BOOT-V3: forkserver eligibility (F-200). A claim to use the fork
 * fast-path on a non-Linux platform or under explicit disable is a
 * contract violation; direct spawn is the only legal path there.
 */
export function validateForkEligibility(claim: {
  platform: string
  disabledByEnv: boolean
  useFork: boolean
}): boolean {
  if (claim.useFork && (claim.platform !== 'linux' || claim.disabledByEnv)) {
    throw new RlmBootstrapContractError(
      `BOOT-V3 violation: fork fast-path claimed on ${claim.platform} (disabledByEnv=${claim.disabledByEnv}); only linux with forkserver enabled may fork`,
    )
  }
  return claim.useFork
}

// =============================================================================
// Artifact 5: Traceability
// =============================================================================

export const RLM_BOOTSTRAP_CONTRACT = {
  'PRE-BOOT-1': 'Interpreter resolution order: explicit override, then managed venv, then XDG fallback (F-205/F-197).',
  'POST-BOOT-1': 'The managed venv carries Python 3.11 with every base and extras package of BOOT package constants (F-191/F-192, BOOT-V1, Z-4).',
  'POST-BOOT-2': 'The runtime identity hash covers the rlm runtime sources plus pyproject; bootstrap compares it to the recorded manifest hash and REBUILDS the venv on mismatch — a fresh install with an unchanged runtime identity skips reinstall (F-194).',
  'POST-BOOT-3': 'Every admitted interpreter passed a readiness probe whose ACTUAL OUTPUT was evaluated: the probe imports ipykernel and the rlm runtime and reports callable rlm, harness CRUD method presence, HarnessEntry fields, and background absence; admission requires the evaluated output to pass — a zero exit code with failing or garbage output rejects the interpreter (F-193, F-252).',
  'INV-BOOT-1': 'Only the bootstrap lock holder rebuilds: managed bootstrap runs under the lock; a live foreign holder blocks with the domain error, and stale locks (holder pid no longer alive, or older than BOOT_LOCK_STALE_MS with no live pid) age out — a live holder is never stolen regardless of age (F-195).',
  'INV-BOOT-2': 'Kernel env carries exactly the bounded session set: RLM_DEPTH, RLM_MAX_DEPTH, RLM_SESSION_DIR, RLM_HARNESS_STATE_DIR, RLM_GLOBAL_HARNESS_STATE_DIR, OMP_RLM_AGENT_DIR, plus the config caps RLM_MAX_OUTPUT_CHARS and RLM_SNAPSHOT_MAX_BYTES (F-206, A-011, SEQ-BOOT-2; the set MUST equal SAFE_SESSION_ENV_KEYS in the safety contract — SAFE-V1 validates it).',
  'INV-BOOT-LIFETIME-1': 'From first bootstrap through upgrade, an explicit interpreter override skips managed bootstrap and must import ipykernel plus runtime plus defaults (F-252).',
  'SEQ-BOOT-1': 'First use SHALL admit the kernel through the resolution order BEFORE any cell executes (SEQ-1, IP-1, F-001).',
  'SEQ-BOOT-2': 'The config surface SHALL deliver interpreter path, caps, and depth to the RLM runtime BEFORE kernel start (SEQ-11, IP-8, REQ-RLM-0014).',
  'ERRORS-BOOT-1': 'A bootstrap attempt whose uv invocations cannot run (uv missing from the resolution path) raises UvMissingError (F-239); install failures raise the domain error naming the internet requirement for first-time installs (F-198).',
  'ERRORS-BOOT-2': 'Python-skill install failures downgrade to a warning NAMING the unavailable skill (per-skill installs run individually), never abort the bootstrap (F-199).',
  'FORBIDDEN-BOOT-1': 'Bootstrap SHALL NOT silently trim the extras set (REQ-RLM-0012, A-011; Z-4 records the decision).',
  'FORBIDDEN-BOOT-2': 'The TypeScript host SHALL NOT expose credentials into the kernel env; only the bounded, capability-gated set crosses (F-207, REQ-N-3).',
} as const

export type RlmBootstrapClauseId = keyof typeof RLM_BOOTSTRAP_CONTRACT