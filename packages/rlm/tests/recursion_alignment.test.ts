/**
 * CONTRACT-IMPLEMENTATION ALIGNMENT (supporting test, dual-stack rule).
 *
 * Imports BOTH the contract authority (requirements/contracts/
 * rlm-recursion.contract.ts) and the implementation (packages/rlm/src/recursion.ts),
 * asserting value equality. The implementation redeclares its own values
 * and never imports the contract (Contract-Implementation Independence).
 *
 * At RED time ../src/recursion.ts does not exist: this file fails with a
 * module-resolution error, which is the canonical RED signal.
 */

import { describe, expect, test } from "bun:test";

import {
  REC_CHILD_DIR_PREFIX as CONTRACT_CHILD_DIR_PREFIX,
  REC_CHILD_ID_HEX_LEN as CONTRACT_CHILD_ID_HEX_LEN,
  REC_DEFAULT_NAME_FALLBACK as CONTRACT_DEFAULT_NAME_FALLBACK,
  REC_DEPTH_DEFAULT as CONTRACT_DEPTH_DEFAULT,
  REC_ERR_AMBIGUOUS as CONTRACT_ERR_AMBIGUOUS,
  REC_ERR_DEPTH as CONTRACT_ERR_DEPTH,
  REC_ERR_DISPOSED_PARENT as CONTRACT_ERR_DISPOSED_PARENT,
  REC_ERR_INVALID_HANDLE as CONTRACT_ERR_INVALID_HANDLE,
  REC_ERR_KWARGS as CONTRACT_ERR_KWARGS,
  REC_ERR_MODEL_UNAVAILABLE as CONTRACT_ERR_MODEL_UNAVAILABLE,
  REC_ERR_PREFLIGHT as CONTRACT_ERR_PREFLIGHT,
  REC_ERR_PROMPT_TYPE as CONTRACT_ERR_PROMPT_TYPE,
  REC_ERR_UNKNOWN_TARGET as CONTRACT_ERR_UNKNOWN_TARGET,
  REC_MAX_DEPTH_DEFAULT as CONTRACT_MAX_DEPTH_DEFAULT,
  REC_MODEL_SEARCH_DEFAULT_LIMIT as CONTRACT_MODEL_SEARCH_DEFAULT_LIMIT,
  REC_MODEL_SEARCH_MAX_LIMIT as CONTRACT_MODEL_SEARCH_MAX_LIMIT,
  REC_NAME_MAX_CHARS as CONTRACT_NAME_MAX_CHARS,
  REC_TASK_PREFIX as CONTRACT_TASK_PREFIX,
  RlmRecursionContractError as ContractRecursionContractError,
} from "../../../requirements/contracts/rlm-recursion.contract.ts";
import {
  REC_CHILD_DIR_PREFIX,
  REC_CHILD_ID_HEX_LEN,
  REC_DEFAULT_NAME_FALLBACK,
  REC_DEPTH_DEFAULT,
  REC_ERR_AMBIGUOUS,
  REC_ERR_DEPTH,
  REC_ERR_DISPOSED_PARENT,
  REC_ERR_INVALID_HANDLE,
  REC_ERR_KWARGS,
  REC_ERR_MODEL_UNAVAILABLE,
  REC_ERR_PREFLIGHT,
  REC_ERR_PROMPT_TYPE,
  REC_ERR_UNKNOWN_TARGET,
  REC_MAX_DEPTH_DEFAULT,
  REC_MODEL_SEARCH_DEFAULT_LIMIT,
  REC_MODEL_SEARCH_MAX_LIMIT,
  REC_NAME_MAX_CHARS,
  REC_TASK_PREFIX,
  RlmRecursionContractError,
} from "../src/recursion.ts";

describe("recursion contract-implementation alignment", () => {
  test("depth and constraint constants match the contract authority", () => {
    expect(REC_DEPTH_DEFAULT).toBe(CONTRACT_DEPTH_DEFAULT);
    expect(REC_MAX_DEPTH_DEFAULT).toBe(CONTRACT_MAX_DEPTH_DEFAULT);
    expect(REC_NAME_MAX_CHARS).toBe(CONTRACT_NAME_MAX_CHARS);
    expect(REC_MODEL_SEARCH_DEFAULT_LIMIT).toBe(CONTRACT_MODEL_SEARCH_DEFAULT_LIMIT);
    expect(REC_MODEL_SEARCH_MAX_LIMIT).toBe(CONTRACT_MODEL_SEARCH_MAX_LIMIT);
  });

  test("identifier and naming format constants match the contract authority", () => {
    expect(REC_CHILD_DIR_PREFIX).toBe(CONTRACT_CHILD_DIR_PREFIX);
    expect(REC_CHILD_ID_HEX_LEN).toBe(CONTRACT_CHILD_ID_HEX_LEN);
    expect(REC_TASK_PREFIX).toBe(CONTRACT_TASK_PREFIX);
    expect(REC_DEFAULT_NAME_FALLBACK).toBe(CONTRACT_DEFAULT_NAME_FALLBACK);
  });

  test("exact error template strings match the contract authority", () => {
    expect(REC_ERR_DEPTH).toBe(CONTRACT_ERR_DEPTH);
    expect(REC_ERR_KWARGS).toBe(CONTRACT_ERR_KWARGS);
    expect(REC_ERR_PROMPT_TYPE).toBe(CONTRACT_ERR_PROMPT_TYPE);
    expect(REC_ERR_MODEL_UNAVAILABLE).toBe(CONTRACT_ERR_MODEL_UNAVAILABLE);
    expect(REC_ERR_PREFLIGHT).toBe(CONTRACT_ERR_PREFLIGHT);
    expect(REC_ERR_INVALID_HANDLE).toBe(CONTRACT_ERR_INVALID_HANDLE);
    expect(REC_ERR_UNKNOWN_TARGET).toBe(CONTRACT_ERR_UNKNOWN_TARGET);
    expect(REC_ERR_AMBIGUOUS).toBe(CONTRACT_ERR_AMBIGUOUS);
    expect(REC_ERR_DISPOSED_PARENT).toBe(CONTRACT_ERR_DISPOSED_PARENT);
  });

  test("recursion error class matches contract exception shape", () => {
    const err = new RlmRecursionContractError("test message", { clause: "PRE-REC-1" });
    const contractErr = new ContractRecursionContractError("test message", { clause: "PRE-REC-1" });
    expect(err.name).toBe(contractErr.name);
    expect(err.message).toBe(contractErr.message);
    expect(err.clause).toBe(contractErr.clause);
  });
});
