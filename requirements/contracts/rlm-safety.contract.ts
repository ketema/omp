/**
 * RLM Safety Contract — specification authority.
 *
 * WHAT the trust and credential boundaries guarantee, NOT enforcement
 * mechanics.
 *
 * The implementation does NOT import from this file; tests import both.
 *
 * Traceability: REQ-N-3, REQ-N-4, REQ-N-6, REQ-RLM-0012/F-206/F-207,
 * F-208, F-267; A-012; Z-4 host-execution decision.
 */

// =============================================================================
// Artifact 1: Constants
// =============================================================================

/** F-207: the ONLY credential ever injected into kernel env, and only when
 * the websearch capability is loaded. */
export const SAFE_ALLOWED_CREDENTIAL_KEYS: readonly string[] = ['SERPER_API_KEY'] as const
/** F-207/F-206: env keys passed through to the kernel (session identity
 * plus the config caps delivered by SEQ-BOOT-2). */
export const SAFE_SESSION_ENV_KEYS: readonly string[] = [
  'RLM_DEPTH',
  'RLM_MAX_DEPTH',
  'RLM_SESSION_DIR',
  'RLM_HARNESS_STATE_DIR',
  'RLM_GLOBAL_HARNESS_STATE_DIR',
  'OMP_RLM_AGENT_DIR',
  'RLM_MAX_OUTPUT_CHARS',
  'RLM_SNAPSHOT_MAX_BYTES',
] as const
/** A-012/F-267: the only model data permitted into Python — bounded catalog
 * metadata, never the full store. */
export const SAFE_MODEL_CROSSING = 'bounded-catalog-metadata-only'
/** F-208: the kernel trust posture, stated once. */
export const SAFE_TRUST_POSTURE =
  'The kernel executes model-written Python with the worker OS permissions; it isolates protocol and lifecycle, not security. It is not a sandbox.'

// =============================================================================
// Artifact 2: Exceptions
// =============================================================================

export class RlmSafetyContractError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RlmSafetyContractError'
  }
}

/** REQ-N-3: a credential attempted to cross the boundary. */
export class CredentialBoundaryViolationError extends RlmSafetyContractError {
  readonly key: string
  constructor(key: string) {
    super(
      `SAFE-V1 violation: credential ${JSON.stringify(key)} is not in the allowed kernel-env set`,
    )
    this.name = 'CredentialBoundaryViolationError'
    this.key = key
  }
}

// =============================================================================
// Artifact 3: Structural types
// =============================================================================

/** The complete kernel environment policy, observable for testing. */
export interface KernelEnvPolicy {
  readonly sessionEnvKeys: readonly string[]
  readonly allowedCredentialKeys: readonly string[]
  readonly modelCrossing: typeof SAFE_MODEL_CROSSING
}

// =============================================================================
// Artifact 4: Validators
// =============================================================================

/**
 * SAFE-V1: kernel env admission. Every key must be a session env key, or a
 * capability-gated allowed credential (F-206/F-207, REQ-N-3).
 */
export function validateKernelEnv(
  env: Readonly<Record<string, string>>,
  options: { websearchLoaded: boolean },
): Readonly<Record<string, string>> {
  for (const key of Object.keys(env)) {
    const isSession = SAFE_SESSION_ENV_KEYS.includes(key)
    const isGatedCredential =
      SAFE_ALLOWED_CREDENTIAL_KEYS.includes(key) && options.websearchLoaded
    if (!isSession && !isGatedCredential) {
      throw new CredentialBoundaryViolationError(key)
    }
  }
  return env
}

/**
 * SAFE-V2: trust-posture statement presence. Any text documenting the
 * kernel to the Model or the User must contain the exact phrase
 * "not a sandbox" (F-208, REQ-N-4).
 */
export function validateTrustPostureDocumented(docText: string): boolean {
  const documented = docText.includes('not a sandbox')
  if (!documented) {
    throw new RlmSafetyContractError(
      'SAFE-V2 violation: kernel documentation must contain the exact phrase "not a sandbox"',
    )
  }
  return documented
}

// =============================================================================
// Artifact 5: Traceability
// =============================================================================

export const RLM_SAFETY_CONTRACT = {
  'SAFE-V1': 'validateKernelEnv: validates that kernel env contains only allowed session identity keys and capability-gated credentials (F-206/F-207, REQ-N-3).',
  'SAFE-V2': 'validateTrustPostureDocumented: validates that trust posture documentation contains the exact phrase "not a sandbox" (F-208, REQ-N-4).',
  'PRE-SAFE-1': 'Kernel env assembly runs before process spawn with a capability-gated credential policy (F-206/F-207).',
  'POST-SAFE-1': 'The kernel env contains only session identity keys plus capability-gated allowed credentials (SAFE-V1, REQ-N-3).',
  'INV-SAFE-1': 'The auth store never crosses the boundary in any direction (F-207).',
  'INV-SAFE-LIFETIME-1': 'From spawn through dispose, the trust posture is stated in every user/model-facing kernel description (SAFE-V2, REQ-N-4).',
  'ERRORS-SAFE-1': 'CredentialBoundaryViolationError names the offending key the moment a non-allowed credential enters kernel env assembly (REQ-N-3, fail-fast CL15-A).',
  'ERRORS-SAFE-2': 'Missing trust-posture documentation raises RlmSafetyContractError rather than shipping silently (SAFE-V2).',
  'FORBIDDEN-SAFE-1': 'The RLM plugin SHALL NOT present the kernel as a security sandbox (REQ-N-4, F-208).',
  'FORBIDDEN-SAFE-2': 'The TypeScript host SHALL NOT expose credentials, auth stores, or non-bounded catalog data to the Python process (REQ-N-3).',
  'FORBIDDEN-SAFE-3': 'The RLM plugin SHALL NOT stub the planned destructive-command blocker; that capability is out of scope for this port (REQ-N-4).',
  'FORBIDDEN-SAFE-4': 'The RLM plugin SHALL NOT ship placeholder, TODO, or stub implementations for any requirement (REQ-N-6).',
} as const

export type RlmSafetyClauseId = keyof typeof RLM_SAFETY_CONTRACT