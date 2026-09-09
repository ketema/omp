/**
 * RLM SAFETY SPECIFICATION TESTS (SLICE-8 RED).
 *
 * Adversarial specification-driven tests for safety enforcement:
 * 1. Credential boundary isolation (SAFE-V1, REQ-N-3, POST-SAFE-1, ERRORS-SAFE-1)
 * 2. Trust posture documentation verification (SAFE-V2, REQ-N-4, INV-SAFE-LIFETIME-1, ERRORS-SAFE-2)
 * 3. Bounded model catalog metadata crossing (POST-SAFE-2, FORBIDDEN-SAFE-2)
 * 4. Pre-port regression gate integrity (REQ-RLM-0001, REQ-N-1, REQ-N-2)
 *
 * Traceability:
 * - PRE-SAFE-1: kernel env assembly before process spawn
 * - POST-SAFE-1: kernel env contains only session keys + capability-gated credentials
 * - POST-SAFE-2: bounded catalog metadata only into Python
 * - INV-SAFE-1: auth store never crosses boundary
 * - INV-SAFE-LIFETIME-1: trust posture stated in every description
 * - ERRORS-SAFE-1: CredentialBoundaryViolationError names offending key
 * - ERRORS-SAFE-2: Missing trust posture raises RlmSafetyContractError
 * - FORBIDDEN-SAFE-1: kernel not presented as security sandbox
 * - FORBIDDEN-SAFE-2: no credentials/auth stores exposed to Python
 * - FORBIDDEN-SAFE-3: no stubbed destructive-command blocker
 * - FORBIDDEN-SAFE-4 / REQ-N-6: no placeholder or stub implementations
 * - SAFE-V1: validateKernelEnv
 * - SAFE-V2: validateTrustPostureDocumented
 */

import { describe, expect, test } from "bun:test";

import {
  CredentialBoundaryViolationError,
  RlmSafetyContractError,
  SAFE_ALLOWED_CREDENTIAL_KEYS,
  SAFE_MODEL_CROSSING,
  SAFE_SESSION_ENV_KEYS,
  SAFE_TRUST_POSTURE,
  validateKernelEnv,
  validateTrustPostureDocumented,
} from "../src/safety.ts";

describe("RLM Safety Enforcement (SLICE-8 RED)", () => {
  // ===========================================================================
  // 1. Credential Boundary Enforcement (SAFE-V1, REQ-N-3, ERRORS-SAFE-1)
  // ===========================================================================
  describe("Kernel Env Credential Boundary (SAFE-V1 / POST-SAFE-1 / ERRORS-SAFE-1)", () => {
    test("POST-SAFE-1: allows valid session identity and config environment keys", () => {
      const sessionEnv: Record<string, string> = {
        RLM_SESSION_DIR: "/tmp/session-1",
        RLM_HARNESS_STATE_DIR: "/tmp/session-1/harness",
        RLM_GLOBAL_HARNESS_STATE_DIR: "/tmp/global-harness",
        OMP_RLM_AGENT_DIR: "/tmp/agent",
        RLM_DEPTH: "0",
        RLM_MAX_DEPTH: "1",
        RLM_MAX_OUTPUT_CHARS: "65536",
        RLM_SNAPSHOT_MAX_BYTES: "268435456",
      };
      const validated = validateKernelEnv(sessionEnv, { websearchLoaded: false });
      expect(validated).toEqual(sessionEnv);
    });

    test("POST-SAFE-1: allows capability-gated SERPER_API_KEY only when websearch capability is loaded", () => {
      const envWithSerper = {
        RLM_SESSION_DIR: "/tmp/session-1",
        SERPER_API_KEY: "secret-serper-key-123",
      };

      // Allowed when websearchLoaded is true
      const validated = validateKernelEnv(envWithSerper, { websearchLoaded: true });
      expect(validated.SERPER_API_KEY).toBe("secret-serper-key-123");

      // Rejected when websearchLoaded is false
      let caught: unknown = null;
      try {
        validateKernelEnv(envWithSerper, { websearchLoaded: false });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(CredentialBoundaryViolationError);
      expect((caught as CredentialBoundaryViolationError).key).toBe("SERPER_API_KEY");
      expect((caught as Error).message).toContain("SERPER_API_KEY");
    });

    test("ERRORS-SAFE-1 + FORBIDDEN-SAFE-2: throws CredentialBoundaryViolationError naming offending credential", () => {
      const forbiddenCredentials = [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "AWS_SECRET_ACCESS_KEY",
        "DATABASE_URL",
        "GITHUB_TOKEN",
      ];

      for (const credKey of forbiddenCredentials) {
        const leakedEnv = {
          RLM_SESSION_DIR: "/tmp/session-1",
          [credKey]: "leaked-secret-value",
        };

        let caught: unknown = null;
        try {
          validateKernelEnv(leakedEnv, { websearchLoaded: true });
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(CredentialBoundaryViolationError);
        expect((caught as CredentialBoundaryViolationError).key).toBe(credKey);
        expect((caught as Error).message).toContain(credKey);
      }
    });
  });

  // ===========================================================================
  // 2. Trust Posture Documentation (SAFE-V2, REQ-N-4, INV-SAFE-LIFETIME-1)
  // ===========================================================================
  describe("Trust Posture Documentation (SAFE-V2 / INV-SAFE-LIFETIME-1 / ERRORS-SAFE-2)", () => {
    test("SAFE-V2 + INV-SAFE-LIFETIME-1: accepts documentation containing the exact phrase 'not a sandbox'", () => {
      const validDoc = `This is the RLM kernel tool. Note: ${SAFE_TRUST_POSTURE}`;
      const result = validateTrustPostureDocumented(validDoc);
      expect(result).toBe(true);
    });

    test("ERRORS-SAFE-2 + FORBIDDEN-SAFE-1: rejects documentation omitting 'not a sandbox' with exact error", () => {
      const misleadingDoc = "The Python kernel executes in a completely secure, isolated environment.";
      let caught: unknown = null;
      try {
        validateTrustPostureDocumented(misleadingDoc);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(RlmSafetyContractError);
      expect((caught as Error).message).toBe(
        'SAFE-V2 violation: kernel documentation must contain the exact phrase "not a sandbox"',
      );
    });
  });

  // ===========================================================================
  // 3. Model Crossing & Safety Constants
  // ===========================================================================
  describe("Safety Constants & Bounded Crossing", () => {
    test("POST-SAFE-2: model crossing is bounded-catalog-metadata-only", () => {
      expect(SAFE_MODEL_CROSSING).toBe("bounded-catalog-metadata-only");
      expect(SAFE_ALLOWED_CREDENTIAL_KEYS).toEqual(["SERPER_API_KEY"]);
      expect(SAFE_SESSION_ENV_KEYS).toContain("RLM_SESSION_DIR");
      expect(SAFE_SESSION_ENV_KEYS).toContain("RLM_DEPTH");
    });
  });
});
