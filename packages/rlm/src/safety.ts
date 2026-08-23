/**
 * RLM safety enforcement — credential boundary filtering, trust-posture
 * validation, and model crossing isolation.
 *
 * Implements requirements/contracts/rlm-safety.contract.ts.
 * All constants, exceptions, types, and validators are redeclared
 * independently (no import from the contract file).
 *
 * Traceability: REQ-RLM-0001, REQ-RLM-0013, REQ-RLM-0016, REQ-N-3,
 * REQ-N-4, REQ-N-6; POST-SAFE-1, POST-SAFE-2, INV-SAFE-1,
 * INV-SAFE-LIFETIME-1, ERRORS-SAFE-1, ERRORS-SAFE-2, FORBIDDEN-SAFE-1..4;
 * SAFE-V1, SAFE-V2.
 */

// =============================================================================
// Artifact 1: Constants
// =============================================================================

/** F-207: ONLY credential ever injected into kernel env, only when
 *  the websearch capability is loaded. */
export const SAFE_ALLOWED_CREDENTIAL_KEYS: readonly string[] = ["SERPER_API_KEY"] as const;

/** F-207/F-206: The env keys passed through to kernel (session identity,
 *  CCABDD harness & runtime configuration, plus config caps delivered by SEQ-BOOT-2). */
export const SAFE_SESSION_ENV_KEYS: readonly string[] = [
	"RLM_DEPTH",
	"RLM_MAX_DEPTH",
	"RLM_SESSION_DIR",
	"RLM_HARNESS_STATE_DIR",
	"RLM_GLOBAL_HARNESS_STATE_DIR",
	"OMP_RLM_AGENT_DIR",
	"RLM_MAX_OUTPUT_CHARS",
	"RLM_SNAPSHOT_MAX_BYTES",
	"CCABDD_HARNESS",
	"CCABDD_STATE_SERVER_PATH",
	"HOME",
	"PATH",
] as const;

/** A-012/F-267: the only model data permitted into Python — bounded catalog
 * metadata, never the full store. */
export const SAFE_MODEL_CROSSING = "bounded-catalog-metadata-only";

/** F-208: kernel trust posture, stated once. */
export const SAFE_TRUST_POSTURE =
	"The kernel executes model-written Python with the worker OS permissions; it isolates protocol and lifecycle, not security. It is not a sandbox.";

// =============================================================================
// Artifact 2: Exceptions
// =============================================================================

export class RlmSafetyContractError extends Error {
	readonly clause?: string;

	constructor(message: string, options?: { cause?: unknown; clause?: string }) {
		super(message, { cause: options?.cause });
		this.name = "RlmSafetyContractError";
		this.clause = options?.clause;
	}
}

/** REQ-N-3: A credential attempted to cross the boundary. */
export class CredentialBoundaryViolationError extends RlmSafetyContractError {
	readonly key: string;

	constructor(key: string) {
		super(`SAFE-V1 violation: credential ${JSON.stringify(key)} is not in the allowed kernel-env set`, {
			clause: "SAFE-V1",
		});
		this.name = "CredentialBoundaryViolationError";
		this.key = key;
	}
}

// =============================================================================
// Artifact 3: Types
// =============================================================================

export interface KernelEnvPolicy {
	readonly sessionEnvKeys: readonly string[];
	readonly allowedCredentialKeys: readonly string[];
	readonly modelCrossing: typeof SAFE_MODEL_CROSSING;
}

// =============================================================================
// Artifact 4: Validators
// =============================================================================

/**
 * SAFE-V1: capability-gated credential filtering (F-206/F-207, REQ-N-3).
 *
 * Verifies that the assembled kernel env contains ONLY:
 * 1. Allowed session identity and CCABDD environment keys (SAFE_SESSION_ENV_KEYS)
 * 2. Allowed credentials when the gating capability is active (SAFE_ALLOWED_CREDENTIAL_KEYS)
 *
 * Throws CredentialBoundaryViolationError on any non-whitelisted key.
 */
export function validateKernelEnv(
	env: Readonly<Record<string, string>>,
	options: { websearchLoaded: boolean },
): Readonly<Record<string, string>> {
	for (const key of Object.keys(env)) {
		const isSession = SAFE_SESSION_ENV_KEYS.includes(key);
		const isGatedCredential = SAFE_ALLOWED_CREDENTIAL_KEYS.includes(key) && options.websearchLoaded;
		if (!isSession && !isGatedCredential) {
			throw new CredentialBoundaryViolationError(key);
		}
	}
	return env;
}

/**
 * SAFE-V2: trust-posture statement presence. Any text documenting the
 * kernel to Model or User must contain the exact phrase
 * "not a sandbox" (F-208, REQ-N-4).
 */
export function validateTrustPostureDocumented(docText: string): boolean {
	const documented = docText.includes("not a sandbox");
	if (!documented) {
		throw new RlmSafetyContractError(
			'SAFE-V2 violation: kernel documentation must contain the exact phrase "not a sandbox"',
			{ clause: "SAFE-V2" },
		);
	}
	return documented;
}
