/**
 * CONTRACT-IMPLEMENTATION ALIGNMENT (supporting test, dual-stack rule).
 *
 * Imports BOTH the contract authority (requirements/contracts/
 * rlm-safety.contract.ts) and the implementation (packages/rlm/src/safety.ts),
 * asserting value equality. The implementation redeclares its own values
 * and never imports the contract (Contract-Implementation Independence).
 *
 * At RED time ../src/safety.ts does not exist: this file fails with a
 * module-resolution error, which is the canonical RED signal.
 */

import { describe, expect, test } from "bun:test";

import {
  CredentialBoundaryViolationError as ContractCredentialBoundaryViolationError,
  RlmSafetyContractError as ContractSafetyContractError,
  SAFE_ALLOWED_CREDENTIAL_KEYS as CONTRACT_ALLOWED_CREDENTIAL_KEYS,
  SAFE_MODEL_CROSSING as CONTRACT_MODEL_CROSSING,
  SAFE_SESSION_ENV_KEYS as CONTRACT_SESSION_ENV_KEYS,
  SAFE_TRUST_POSTURE as CONTRACT_TRUST_POSTURE,
} from "../../../requirements/contracts/rlm-safety.contract.ts";
import {
  CredentialBoundaryViolationError,
  RlmSafetyContractError,
  SAFE_ALLOWED_CREDENTIAL_KEYS,
  SAFE_MODEL_CROSSING,
  SAFE_SESSION_ENV_KEYS,
  SAFE_TRUST_POSTURE,
} from "../src/safety.ts";

describe("safety contract-implementation alignment", () => {
  test("safety constants match the contract authority", () => {
    expect(SAFE_ALLOWED_CREDENTIAL_KEYS).toEqual(CONTRACT_ALLOWED_CREDENTIAL_KEYS);
    expect(SAFE_SESSION_ENV_KEYS).toEqual(CONTRACT_SESSION_ENV_KEYS);
    expect(SAFE_MODEL_CROSSING).toBe(CONTRACT_MODEL_CROSSING);
    expect(SAFE_TRUST_POSTURE).toBe(CONTRACT_TRUST_POSTURE);
  });

  test("safety error classes match contract exception shapes", () => {
    const safetyErr = new RlmSafetyContractError("test message", { clause: "PRE-SAFE-1" });
    const contractSafetyErr = new ContractSafetyContractError("test message", { clause: "PRE-SAFE-1" });
    expect(safetyErr.name).toBe(contractSafetyErr.name);
    expect(safetyErr.message).toBe(contractSafetyErr.message);

    const credErr = new CredentialBoundaryViolationError("DATABASE_URL");
    const contractCredErr = new ContractCredentialBoundaryViolationError("DATABASE_URL");
    expect(credErr.name).toBe(contractCredErr.name);
    expect(credErr.key).toBe(contractCredErr.key);
    expect(credErr.message).toBe(contractCredErr.message);
  });
});
