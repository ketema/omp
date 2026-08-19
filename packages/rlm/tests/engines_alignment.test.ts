/**
 * CONTRACT-IMPLEMENTATION ALIGNMENT (supporting test, dual-stack rule).
 *
 * Imports BOTH the contract authority (requirements/contracts/
 * rlm-bridge.contract.ts) and the implementation (packages/rlm/src/engines.ts),
 * asserting value equality. The implementation redeclares its own values
 * and never imports the contract (Contract-Implementation Independence).
 *
 * At RED time ../src/engines.ts does not exist: this file fails with a
 * module-resolution error, which is the canonical RED signal.
 */

import { describe, expect, test } from "bun:test";

import {
  BR_COMM_TARGET as CONTRACT_COMM_TARGET,
  BR_COMPACT_NOTE as CONTRACT_COMPACT_NOTE,
  BR_ERR_UNAVAILABLE as CONTRACT_ERR_UNAVAILABLE,
  BR_HEARTBEAT_STATUSES as CONTRACT_HEARTBEAT_STATUSES,
  BR_MESSAGE_ROLES as CONTRACT_MESSAGE_ROLES,
  BR_REFINE_NOTE as CONTRACT_REFINE_NOTE,
  RlmBridgeContractError as ContractBridgeContractError,
} from "../../../requirements/contracts/rlm-bridge.contract.ts";
import {
  BR_COMM_TARGET,
  BR_COMPACT_NOTE,
  BR_ERR_UNAVAILABLE,
  BR_HEARTBEAT_STATUSES,
  BR_MESSAGE_ROLES,
  BR_REFINE_NOTE,
  RlmBridgeContractError,
} from "../src/engines.ts";

describe("engines contract-implementation alignment", () => {
  test("bridge note and template string constants match the contract authority", () => {
    expect(BR_COMM_TARGET).toBe(CONTRACT_COMM_TARGET);
    expect(BR_COMPACT_NOTE).toBe(CONTRACT_COMPACT_NOTE);
    expect(BR_REFINE_NOTE).toBe(CONTRACT_REFINE_NOTE);
    expect(BR_ERR_UNAVAILABLE).toBe(CONTRACT_ERR_UNAVAILABLE);
  });

  test("status and role enums match the contract authority", () => {
    expect(BR_HEARTBEAT_STATUSES).toEqual(CONTRACT_HEARTBEAT_STATUSES);
    expect(BR_MESSAGE_ROLES).toEqual(CONTRACT_MESSAGE_ROLES);
  });

  test("bridge error class matches contract exception shape", () => {
    const err = new RlmBridgeContractError("test message", { clause: "POST-BR-3" });
    const contractErr = new ContractBridgeContractError("test message", { clause: "POST-BR-3" });
    expect(err.name).toBe(contractErr.name);
    expect(err.message).toBe(contractErr.message);
    expect(err.clause).toBe(contractErr.clause);
  });
});
